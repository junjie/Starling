/* Turning what Gemini sends into a file.

   Unary calls answer with a finished 24 kHz, 16-bit mono WAV. Older models
   sent bare PCM described by a mime type like audio/L16;rate=24000, so both
   are read into samples first and a file is written from those. */

import { encodeOggOpus, OPUS_MIME } from './opus.js';

function ascii(bytes, from, length) {
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

/* The samples and rate inside a WAV, when it is 16-bit mono PCM, or null. Walks
   the chunks rather than assuming a 44-byte header, since a writer may put
   others before the data. A data size larger than the file, as a streaming
   writer leaves it, is read as "to the end". */
export function wavSamples(bytes) {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format || format.code !== 1 || format.channels !== 1 || format.bits !== 16) return null;
      return { pcm: bytes.subarray(body, Math.min(body + size, bytes.length)), rate: format.rate };
    }
    at = body + size + (size & 1);               // chunks are padded to even
  }
  return null;
}

/* A plain 44-byte WAV header in front of 16-bit mono samples. */
export function writeWav(pcm, rate) {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const text = (at, s) => out.set([...s].map((c) => c.charCodeAt(0)), at);
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                   // PCM
  view.setUint16(22, 1, true);                   // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);            // bytes per second
  view.setUint16(32, 2, true);                   // bytes per frame
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export function samplesOf(bytes, mime) {
  if (ascii(bytes, 0, 4) === 'RIFF') return wavSamples(bytes);
  if (!/audio\/(l16|pcm)/i.test(mime || '')) return null;
  const rate = /rate=(\d+)/.exec(mime);
  return { pcm: bytes, rate: rate ? Number(rate[1]) : 24000 };
}

/* The file to keep: `format` is 'ogg' or 'wav'. Ogg falls back to WAV in a
   browser that cannot encode it, and a shape this cannot read is kept exactly
   as it came, because the call that made it has already been paid for. */
export async function speechFile(bytes, mime, format) {
  const inside = samplesOf(bytes, mime);
  if (!inside) {
    return { bytes, type: mime || 'application/octet-stream', ext: 'bin', seconds: 0 };
  }
  const seconds = inside.pcm.length / 2 / inside.rate;
  const opus = format === 'ogg' && await encodeOggOpus(inside.pcm, inside.rate);
  if (opus) return { bytes: opus, type: OPUS_MIME, ext: 'ogg', seconds };
  return { bytes: writeWav(inside.pcm, inside.rate), type: 'audio/wav', ext: 'wav', seconds };
}

/* A download name made from the text. Letters of every script are kept, so a
   Chinese or Vietnamese clip is still findable in Finder. */
export function fileName({ language, voice, text, ext }) {
  const words = String(text).normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${[language, voice, words].filter(Boolean).join('-')}.${ext}`;
}
