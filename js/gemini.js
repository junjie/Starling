/* Talking to the Gemini API straight from the page.

   There is no proxy. generativelanguage.googleapis.com answers CORS preflights
   with content-type and x-goog-api-key on its allowlist, so fetch() works from
   a static site, and each key goes only to Google, in a header rather than a
   URL so it stays out of logs and history.

   Google's docs now lead with the Interactions API and label generateContent
   "legacy", but generateContent is the one that takes voiceConfig.voice, which
   is documented to accept a Voice Library id as well as a studio voice name.
   Should it ever go away, speak() below is the only thing to change. */

import { classifyFailure, keyTail } from './keyring.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SERVER_RETRIES = 2;

export class GeminiError extends Error {}

/* Every key is resting. `until` is when the first comes back, or null when
   none will without the list being fixed. */
export class KeysExhausted extends Error {
  constructor(until) {
    super('No API key can take this call right now.');
    this.until = until;
  }
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function speechBody({ text, voice, style, voiceShape = 'voice' }) {
  const part = { text };
  if (style) part.speech_metadata = { style };
  return {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: voiceShape === 'voice'
          ? { voice }
          : { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };
}

function audioFrom(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      return { bytes: decodeBase64(inline.data), mime: inline.mimeType || inline.mime_type || '' };
    }
  }
  return null;
}

/* Older TTS models know only the prebuiltVoiceConfig spelling. */
function rejectsVoiceField(failure) {
  return failure.kind === 'request' && /voice/i.test(failure.message);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/* One clip. Keeps going round the ring until a key answers or none are left.
   That always ends: every failure that does not stop the loop takes the key
   that failed out of the running, or uses up one of a few retries.

   `onChange` is told each time the ring changes, so the page can save the
   rests and say what happened. */
export async function speak({
  ring, model, text, voice, style = '', signal,
  fetchFn = globalThis.fetch, onChange = () => {}, pause = wait,
}) {
  let voiceShape = 'voice';
  let serverFailures = 0;
  let emptyAnswers = 0;

  for (;;) {
    const key = ring.pick(model);
    if (!key) throw new KeysExhausted(ring.soonest(model));

    let res;
    try {
      res = await fetchFn(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(speechBody({ text, voice, style, voiceShape })),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e;
      throw new GeminiError(`Could not reach Gemini: ${e.message}`);
    }

    if (res.ok) {
      const data = await res.json();
      const audio = audioFrom(data);
      if (audio) {
        ring.recordUse(key);
        onChange(`Made with key ${keyTail(key)}.`);
        return { ...audio, key };
      }
      /* The safety filter and the model itself both sometimes answer with
         nothing for an ordinary sentence, and one more try is usually enough. */
      if (++emptyAnswers < 2) continue;
      const why = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'no audio';
      throw new GeminiError(`Gemini returned no audio twice (${why}). Try rewording the text.`);
    }

    const failure = classifyFailure(res.status, await res.text().catch(() => ''), ring.now());
    switch (failure.kind) {
      case 'minute':
      case 'day':
        ring.rest(key, model, failure.until, failure.kind);
        onChange(`Key ${keyTail(key)} hit its ${failure.kind === 'day' ? 'daily' : 'per-minute'} limit.`);
        break;
      case 'refused':
        ring.refuse(key, failure.message);
        onChange(`Google refused key ${keyTail(key)}.`);
        break;
      case 'server':
        if (++serverFailures > SERVER_RETRIES) {
          throw new GeminiError(`Gemini kept failing (HTTP ${res.status}): ${failure.message}`);
        }
        await pause(1500 * serverFailures, signal);
        break;
      default:
        if (voiceShape === 'voice' && rejectsVoiceField(failure)) {
          voiceShape = 'prebuilt';
          break;
        }
        throw new GeminiError(`${model} returned HTTP ${res.status}: ${failure.message}`);
    }
  }
}

/* The whole Voice Library, page by page. Filtering happens here in the page
   and not through language_code: Google does not document which codes Chinese
   is filed under, and an unfiltered list cannot miss. */
export async function listVoices({ key, fetchFn = globalThis.fetch }) {
  const voices = [];
  let token = '';
  do {
    const query = new URLSearchParams({ page_size: '1000' });
    if (token) query.set('page_token', token);
    const res = await fetchFn(`${BASE}/voices?${query}`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) {
      const { message } = classifyFailure(res.status, await res.text().catch(() => ''), 0);
      throw new GeminiError(`The voice list returned HTTP ${res.status}: ${message}`);
    }
    const data = await res.json();
    voices.push(...(data.voices || []));
    token = data.next_page_token || data.nextPageToken || '';
  } while (token);
  return voices;
}
