import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wavSamples, writeWav, samplesOf, speechFile, fileName } from '../js/audio.js';
import { makeZip, crc32 } from '../js/zip.js';
import { normalizeVoice, voicesFor, randomVoice, STUDIO_VOICES } from '../js/voices.js';

const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

test('a written WAV reads back to the same samples', () => {
  const { pcm: out, rate } = wavSamples(writeWav(pcm, 24000));
  assert.deepEqual([...out], [...pcm]);
  assert.equal(rate, 24000);
});

test('samplesOf reads bare PCM by its mime type, and nothing else', () => {
  assert.equal(samplesOf(pcm, 'audio/L16;rate=16000').rate, 16000);
  assert.equal(samplesOf(pcm, 'audio/mpeg'), null);
});

test('speechFile keeps a WAV as a WAV, and reports its length', async () => {
  const file = await speechFile(writeWav(new Uint8Array(48000), 24000), 'audio/wav', 'wav');
  assert.equal(file.ext, 'wav');
  assert.equal(file.seconds, 1);
});

test('speechFile falls back to WAV where Ogg cannot be encoded', async () => {
  const file = await speechFile(writeWav(pcm, 24000), 'audio/wav', 'ogg');
  assert.equal(file.ext, 'wav'); // node has no AudioEncoder
});

test('audio it cannot read is kept as it came', async () => {
  const file = await speechFile(pcm, 'audio/mpeg', 'ogg');
  assert.equal(file.bytes, pcm);
  assert.equal(file.ext, 'bin');
});

test('fileName keeps letters of every script', () => {
  assert.equal(fileName({ language: 'vi', voice: 'Kore', text: 'Xin chào, bạn!', ext: 'ogg' }), 'vi-Kore-Xin-chào-bạn.ogg');
  assert.equal(fileName({ language: 'zh-TW', voice: 'Puck', text: '你好，世界。', ext: 'wav' }), 'zh-TW-Puck-你好-世界.wav');
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

/* Read back with Python, not the unzip command: macOS's unzip ignores the
   UTF-8 flag and mangles these names however a zip is written. */
test('another tool reads the zip, Chinese and Vietnamese names included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-zip-'));
  try {
    const zip = makeZip([
      { name: 'zh-你好.ogg', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'vi-chào.wav', bytes: new Uint8Array([4, 5]) },
    ]);
    const path = join(dir, 'a.zip');
    writeFileSync(path, new Uint8Array(await zip.arrayBuffer()));
    const script = 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])';
    execFileSync('python3', ['-I', '-c', script, path, dir]);
    assert.deepEqual([...readFileSync(join(dir, 'zh-你好.ogg'))], [1, 2, 3]);
    assert.deepEqual([...readFileSync(join(dir, 'vi-chào.wav'))], [4, 5]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const library = [
  { id: 'cn1', language_code: 'cmn-CN' },
  { id: 'cn2', language_code: 'zh', region_code: 'CN' },
  { id: 'tw1', language_code: 'cmn-TW' },
  { id: 'tw2', languageCode: 'zh-TW' },
  { id: 'tw3', language_code: 'zh', accent: 'Taiwanese' },
  { id: 'hk', language_code: 'yue-HK' },
  { id: 'hk2', language_code: 'zh-HK' },
  { id: 'vi1', language_code: 'vi-VN' },
  { id: 'nested', prompted: { language_code: 'vi' } },
  { id: 'en', language_code: 'en-US' },
].map(normalizeVoice);

const ids = (language) => voicesFor(language, library).map((v) => v.id);

test('Mainland, Taiwan and Vietnamese each find their voices, however filed', () => {
  assert.deepEqual(ids('zh-CN'), ['cn1', 'cn2']);
  assert.deepEqual(ids('zh-TW'), ['tw1', 'tw2', 'tw3']);
  assert.deepEqual(ids('vi'), ['vi1', 'nested']);
  assert.deepEqual(ids('other'), []);
});

test('random draws from the language, or the studio voices when it has none', () => {
  assert.equal(randomVoice('zh-TW', library, () => 0), 'tw1');
  assert.equal(randomVoice('zh-TW', [], () => 0), STUDIO_VOICES[0][0]);
});
