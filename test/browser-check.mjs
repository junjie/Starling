/* Drive Starling in WebKit with Google's API faked: key A is out for
   the day, key B works, a third call is a per-minute limit on both. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* Playwright is no dependency of this repo, so it is found from the folder
   this is run in. See CLAUDE.md. */
const { webkit } = createRequire(join(process.cwd(), 'x.js'))('playwright');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111';
const B = 'AIzaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { failed++; process.exitCode = 1; } };

const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const profile = mkdtempSync(join(tmpdir(), 'tts-wk-'));
const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 900, height: 1200 }, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (/Content.Security|Refused/i.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => d.accept());

function wav(ms = 1000) {
  const n = 24 * ms * 2;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), 44 + i * 2);
  return b;
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const calls = [];
let minuteLimitOn = false;
let voicesDown = false;
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
  const key = req.headers()['x-goog-api-key'];
  if (req.url().includes('/voices')) {
    if (key === A || voicesDown) return route.fulfill({ status: 403, headers: cors, json: { error: { message: 'Requests from referer are blocked.' } } });
    return route.fulfill({ status: 200, headers: cors, json: { voices: [
      { id: 'tw-voice', display_name: 'Mei', language_code: 'cmn-TW', accent: 'Taiwanese', gender: 'female' },
      { id: 'vi-voice', display_name: 'Lan', language_code: 'vi-VN', gender: 'female' },
    ] } });
  }
  const body = req.postDataJSON();
  calls.push({ referer: req.headers().referer, key, voice: body.generationConfig.speechConfig.voiceConfig.voice, text: body.contents[0].parts[0].text, url: req.url() });
  if (minuteLimitOn) {
    return route.fulfill({ status: 429, headers: cors, json: { error: { message: 'slow', details: [{ retryDelay: '2s' }] } } });
  }
  if (key === A) {
    return route.fulfill({ status: 429, headers: cors, json: { error: { message: 'out', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } } });
  }
  return route.fulfill({ status: 200, headers: cors, json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav().toString('base64') } }] } }] } });
});

await page.goto(`http://127.0.0.1:${port}/`);
ok(await page.isDisabled('#generate'), 'Generate is off with no keys');
ok(await page.isVisible('#keys-input'), 'the keys panel starts open with no keys');

await page.fill('#keys-input', `${A} first account\n${B}\n`);
await page.click('#keys-save');
await page.waitForFunction(() => [...document.querySelectorAll('#voice option')].length > 30);
ok(/2 of 2 ready/.test(await page.textContent('#keys-summary')), 'two keys ready after saving');

await page.selectOption('#language', 'zh-TW');
ok(await page.locator('#voice option[value="tw-voice"]').count() === 1, 'Taiwan lists the Taiwanese library voice');
ok(await page.locator('#voice option[value="vi-voice"]').count() === 0, 'Taiwan does not list the Vietnamese one');
await page.selectOption('#language', 'zh-CN');
ok(/no Chinese \(Mainland\) voices/.test(await page.textContent('#voice-note')), 'a language with no library voices says so');

await page.selectOption('#language', 'vi');
await page.selectOption('#voice', 'vi-voice');
await page.fill('#text', 'Xin chào');
await page.click('#generate');
await page.waitForSelector('.clip');
ok(calls.length === 2 && calls[0].key === A && calls[1].key === B, 'key A hit its limit, key B made the clip');
ok(calls[1].referer === `http://127.0.0.1:${port}/`, `Google is told the site and no more (${calls[1].referer})`);
ok(calls[1].voice === 'vi-voice', 'the chosen library voice was sent');
ok(!calls.some((c) => c.url.includes('key=')), 'the key never appears in a URL');
ok(/1 of 2 ready/.test(await page.textContent('#keys-summary')), 'the table shows A resting');
ok(/Daily limit/.test(await page.textContent('#keys-table tbody')), 'A is labelled as out for the day');
ok(/Lan/.test(await page.textContent('.clip .meta')), 'the clip shows the voice by name');
const format = (await page.textContent('.clip .meta')).match(/OGG|WAV/)[0];
console.log('     saved as', format);

const canPlay = await page.evaluate(() => new Promise((resolve) => {
  const a = document.querySelector('.clip audio');
  if (a.readyState >= 1) resolve(a.duration);
  a.onloadedmetadata = () => resolve(a.duration);
  a.onerror = () => resolve('error ' + a.error?.message);
  setTimeout(() => resolve('timeout'), 4000);
}));
ok(typeof canPlay === 'number' && canPlay > 0.9 && canPlay < 1.2, `the audio element loaded it (${canPlay}s)`);

const [download] = await Promise.all([page.waitForEvent('download'), page.click('.clip button:has-text("Download")')]);
console.log('     raw name code points', [...download.suggestedFilename()].map((c) => c.codePointAt(0).toString(16)).join(' '));
ok(download.suggestedFilename().normalize('NFC') === `vi-Lan-Xin-chào.${format.toLowerCase()}`, `download named ${download.suggestedFilename()}`);
ok(statSync(await download.path()).size > 100, 'the download has content');

// A batch, in which the limit strikes on the second line and then lifts.
await page.check('#per-line');
await page.fill('#text', 'một\nhai\nba');
calls.length = 0;
const lifted = page.waitForFunction(() => /Waiting/.test(document.querySelector('#status').textContent));
await page.click('#generate');
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
minuteLimitOn = true;
await lifted.catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
minuteLimitOn = false;
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 4, null, { timeout: 15000 });
ok(/Made 3 clips/.test(await page.textContent('#status')), 'the batch waited out a short limit and finished');

// A reload keeps the clips, the keys and the rest on key A.
await page.reload();
await page.waitForSelector('.clip');
ok(await page.locator('.clip').count() === 4, 'clips survive a reload');
ok(/1 of 2 ready/.test(await page.textContent('#keys-summary')), 'the rest on key A survives a reload');
ok(!(await page.isVisible('#keys-input')), 'the keys panel starts closed once there are keys');

const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#save-all')]);
ok(zip.suggestedFilename() === 'starling-clips.zip', 'Download all gives a zip');
const { execFileSync } = await import('node:child_process');
const listing = execFileSync('unzip', ['-Z1', await zip.path()], { encoding: 'utf8' }).trim().split('\n');
ok(listing.length === 4 && new Set(listing).size === 4, `zip holds 4 distinct files: ${listing.join(', ')}`);

await page.screenshot({ path: 'starling.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll at phone width');
await page.screenshot({ path: 'starling-phone.png' });

// With the library gone and no key able to list it, the page says why.
voicesDown = true;
await page.evaluate(() => localStorage.removeItem('starling.voices'));
await page.reload();
await page.waitForFunction(() => /did not load/.test(document.querySelector('#voice-note').textContent));
ok(/referer are blocked/.test(await page.textContent('#voice-note')), 'a failed voice list shows Google\'s reason');
voicesDown = false;
await page.selectOption('#language', 'other');
await page.reload();
await page.waitForSelector('.clip');
await page.selectOption('#language', 'zh-TW');
await page.waitForSelector('#voice option[value="tw-voice"]', { state: 'attached' });
ok(true, 'a reload with no saved voices lists them again, with key A failing and B working');

await page.click('#clear-all');
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 0);
ok(true, 'Delete all clears the clips');

ok(errors.length === 0, 'no page or CSP errors ' + (errors.length ? JSON.stringify(errors) : ''));
await ctx.close();
server.kill();
rmSync(profile, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
