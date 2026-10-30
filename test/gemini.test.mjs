import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyRing } from '../js/keyring.js';
import { speak, speechBody, listVoices, KeysExhausted, GeminiError } from '../js/gemini.js';

const M = 'gemini-3.8-flash-tts';
const A = 'AIzaAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'AIzaBBBBBBBBBBBBBBBBBBBBBBBB';

const audio = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: btoa('RIFF') } }] } }],
}));
const fail = (status, body) => new Response(body, { status });
const perDay = () => fail(429, JSON.stringify({ error: { message: 'x', details: [{ violations: [{ quotaId: 'RequestsPerDay' }] }] } }));
const perMinute = () => fail(429, JSON.stringify({ error: { message: 'x', details: [{ retryDelay: '10s' }] } }));

function script(...answers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, key: init.headers['x-goog-api-key'], body: JSON.parse(init.body) });
    return answers.shift()();
  };
  return { fetchFn, calls };
}

const ask = (ring, fetchFn, extra = {}) => speak({
  ring, model: M, text: 'xin chào', voice: 'Kore', fetchFn, pause: async () => {}, ...extra,
});

test('the body carries the voice, and a style only when there is one', () => {
  const plain = speechBody({ text: 'hi', voice: 'Kore' });
  assert.deepEqual(plain.generationConfig.speechConfig.voiceConfig, { voice: 'Kore' });
  assert.deepEqual(plain.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(plain.contents[0].parts[0].speech_metadata, undefined);
  const styled = speechBody({ text: 'hi', voice: 'Kore', style: 'calm' });
  assert.deepEqual(styled.contents[0].parts[0].speech_metadata, { style: 'calm' });
});

test('a daily limit moves on to the next key, and the audio comes back', async () => {
  const { fetchFn, calls } = script(perDay, audio);
  const ring = new KeyRing({ keys: [A, B] });
  const notes = [];
  const out = await ask(ring, fetchFn, { onChange: (n) => notes.push(n) });
  assert.deepEqual(calls.map((c) => c.key), [A, B]);
  assert.equal(out.key, B);
  assert.equal(out.mime, 'audio/wav');
  assert.equal(ring.status(A, M).kind, 'day');
  assert.equal(ring.usedToday(B), 1);
  assert.match(notes[0], /daily/);
});

test('a refused key is skipped from then on', async () => {
  const { fetchFn, calls } = script(() => fail(403, '{"error":{"message":"no"}}'), audio, audio);
  const ring = new KeyRing({ keys: [A, B] });
  await ask(ring, fetchFn);
  await ask(ring, fetchFn);
  assert.deepEqual(calls.map((c) => c.key), [A, B, B]);
});

test('when every key is out, the error says when the first returns', async () => {
  const { fetchFn } = script(perMinute, perDay);
  const ring = new KeyRing({ keys: [A, B] });
  await assert.rejects(ask(ring, fetchFn), (e) => {
    assert.ok(e instanceof KeysExhausted);
    assert.equal(e.until, ring.state[A].rests[M].until);
    return true;
  });
});

test('with no keys at all it says so without calling anything', async () => {
  const { fetchFn, calls } = script();
  await assert.rejects(ask(new KeyRing({ keys: [] }), fetchFn), KeysExhausted);
  assert.equal(calls.length, 0);
});

test('a bad request stops at once: no other key would do better', async () => {
  const { fetchFn, calls } = script(() => fail(400, '{"error":{"message":"bad text"}}'));
  await assert.rejects(ask(new KeyRing({ keys: [A, B] }), fetchFn), GeminiError);
  assert.equal(calls.length, 1);
});

test('a model that rejects the voice field gets the older spelling', async () => {
  const { fetchFn, calls } = script(() => fail(400, '{"error":{"message":"Unknown name \\"voice\\""}}'), audio);
  await ask(new KeyRing({ keys: [A] }), fetchFn);
  assert.deepEqual(calls[1].body.generationConfig.speechConfig.voiceConfig, { prebuiltVoiceConfig: { voiceName: 'Kore' } });
});

test('that older spelling is tried only once', async () => {
  const reject = () => fail(400, '{"error":{"message":"bad voice"}}');
  const { fetchFn, calls } = script(reject, reject);
  await assert.rejects(ask(new KeyRing({ keys: [A] }), fetchFn), GeminiError);
  assert.equal(calls.length, 2);
});

test('server errors retry on the same key, then give up', async () => {
  const down = () => fail(503, 'overloaded');
  const ok = script(down, audio);
  const ring = new KeyRing({ keys: [A, B] });
  assert.equal((await ask(ring, ok.fetchFn)).key, A);

  const stuck = script(down, down, down);
  await assert.rejects(ask(new KeyRing({ keys: [A] }), stuck.fetchFn), /kept failing/);
  assert.equal(stuck.calls.length, 3);
});

test('an answer with no audio is tried once more', async () => {
  const empty = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'OTHER' }] }));
  const ok = script(empty, audio);
  assert.ok((await ask(new KeyRing({ keys: [A] }), ok.fetchFn)).bytes);
  const stuck = script(empty, empty);
  await assert.rejects(ask(new KeyRing({ keys: [A] }), stuck.fetchFn), /no audio twice \(OTHER\)/);
});

test('stopping is not reported as a network failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchFn = async () => { throw new DOMException('stopped', 'AbortError'); };
  await assert.rejects(ask(new KeyRing({ keys: [A] }), fetchFn, { signal: controller.signal }), { name: 'AbortError' });
});

test('listVoices follows the pages', async () => {
  const urls = [];
  const pages = [{ voices: [{ id: 'a' }], next_page_token: 'p2' }, { voices: [{ id: 'b' }] }];
  const fetchFn = async (url) => { urls.push(url); return new Response(JSON.stringify(pages.shift())); };
  const voices = await listVoices({ key: A, fetchFn });
  assert.deepEqual(voices.map((v) => v.id), ['a', 'b']);
  assert.match(urls[1], /page_token=p2/);
});
