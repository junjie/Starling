import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyRing, parseKeys, keyTail, classifyFailure, nextPacificMidnight } from '../js/keyring.js';

const M = 'gemini-3.8-flash-tts';
const A = 'AIzaAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'AIzaBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'AIzaCCCCCCCCCCCCCCCCCCCCCCCC';

function clock(start = Date.UTC(2026, 9, 30, 12)) {
  const c = () => c.t;
  c.t = start;
  return c;
}

test('parseKeys takes one per line, ignores notes and duplicates', () => {
  assert.deepEqual(parseKeys(`${A}\n\n  ${B}  work account\nnote: ${C}\n${A}\n`), [A, B, C]);
  assert.deepEqual(parseKeys('too short\n'), []);
});

test('keyTail shows only the last four characters', () => {
  assert.equal(keyTail(A), '…AAAA');
});

test('the ring stays on one key until it has to move', () => {
  const now = clock();
  const ring = new KeyRing({ keys: [A, B, C], now });
  assert.equal(ring.pick(M), A);
  assert.equal(ring.pick(M), A);
  ring.rest(A, M, now.t + 60000, 'minute');
  assert.equal(ring.pick(M), B);
  assert.equal(ring.pick(M), B, 'stays on B after moving, even once A is back');
  now.t += 61000;
  assert.equal(ring.pick(M), B);
});

test('the ring wraps around past the end of the list', () => {
  const now = clock();
  const ring = new KeyRing({ keys: [A, B], now });
  ring.rest(A, M, now.t + 1000, 'minute');
  ring.pick(M);
  ring.rest(B, M, now.t + 5000, 'minute');
  now.t += 2000;
  assert.equal(ring.pick(M), A);
});

test('a rest belongs to one model; a refusal to all of them', () => {
  const now = clock();
  const ring = new KeyRing({ keys: [A, B], now });
  ring.rest(A, M, now.t + 60000, 'day');
  assert.equal(ring.pick('other-model'), A);
  ring.refuse(A, 'bad key');
  assert.equal(ring.pick('other-model'), B);
});

test('pick is null when all rest, and soonest says when', () => {
  const now = clock();
  const ring = new KeyRing({ keys: [A, B, C], now });
  ring.rest(A, M, now.t + 9000, 'minute');
  ring.rest(B, M, now.t + 4000, 'minute');
  ring.refuse(C, 'bad');
  assert.equal(ring.pick(M), null);
  assert.equal(ring.soonest(M), now.t + 4000);
});

test('soonest is null when every key was refused', () => {
  const ring = new KeyRing({ keys: [A] });
  ring.refuse(A, 'bad');
  assert.equal(ring.soonest(M), null);
});

test('rests and the current key survive a reload', () => {
  const now = clock();
  const before = new KeyRing({ keys: [A, B], now });
  before.rest(A, M, now.t + 60000, 'day');
  before.pick(M);
  const after = new KeyRing({ keys: [A, B], state: JSON.parse(JSON.stringify(before.getState())), now });
  assert.equal(after.current, B);
  assert.equal(after.status(A, M).kind, 'day');
});

test('state for a key no longer listed is dropped', () => {
  const before = new KeyRing({ keys: [A, B] });
  before.refuse(A, 'bad');
  const after = new KeyRing({ keys: [B], state: before.getState() });
  assert.deepEqual(after.keys, [B]);
  assert.equal(after.pick(M), B);
});

test('reset brings a key back', () => {
  const ring = new KeyRing({ keys: [A] });
  ring.refuse(A, 'bad');
  ring.reset(A);
  assert.equal(ring.pick(M), A);
});

test('use is counted per Pacific day', () => {
  const now = clock();
  const ring = new KeyRing({ keys: [A], now });
  ring.recordUse(A);
  ring.recordUse(A);
  assert.equal(ring.usedToday(A), 2);
  now.t += 24 * 60 * 60 * 1000;
  assert.equal(ring.usedToday(A), 0);
});

test('nextPacificMidnight is the coming midnight in Los Angeles', () => {
  // 2026-10-30 12:00 UTC is 05:00 PDT, so midnight is 07:00 UTC the next day.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 30, 12)), Date.UTC(2026, 9, 31, 7));
});

function quotaBody(quotaId, retryDelay) {
  return JSON.stringify({ error: {
    code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ],
  } });
}

test('a per-minute 429 rests the key for the delay Google gave', () => {
  const f = classifyFailure(429, quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '33.5s'), 1000);
  assert.equal(f.kind, 'minute');
  assert.equal(f.until, 1000 + 35000);
});

test('a per-day 429 rests the key until the Pacific reset', () => {
  const now = Date.UTC(2026, 9, 30, 12);
  const f = classifyFailure(429, quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s'), now);
  assert.equal(f.kind, 'day');
  assert.equal(f.until, Date.UTC(2026, 9, 31, 7));
});

test('a 429 with no details rests a minute', () => {
  const f = classifyFailure(429, 'nope', 0);
  assert.deepEqual([f.kind, f.until], ['minute', 60000]);
});

test('a model with a zero allowance counts as out for the day', () => {
  const body = JSON.stringify({ error: { message: 'Quota exceeded, limit: 0, model: x' } });
  assert.equal(classifyFailure(429, body, 0).kind, 'day');
});

test('a bad key is refused, however Google words it', () => {
  const invalid = JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
  assert.equal(classifyFailure(400, invalid, 0).kind, 'refused');
  assert.equal(classifyFailure(403, '{"error":{"message":"leaked"}}', 0).kind, 'refused');
});

test('server errors and bad requests are told apart', () => {
  assert.equal(classifyFailure(503, 'overloaded', 0).kind, 'server');
  assert.equal(classifyFailure(400, '{"error":{"message":"bad field"}}', 0).kind, 'request');
});
