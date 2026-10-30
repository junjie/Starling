/* The page. Everything with a rule worth testing lives in the other modules;
   this file wires them to the DOM. */

import { KeyRing, parseKeys, keyTail } from './keyring.js';
import { speak, listVoices, KeysExhausted, GeminiError } from './gemini.js';
import {
  LANGUAGES, MODELS, STUDIO_VOICES, languageById, normalizeVoice, voicesFor, voiceLabel, randomVoice,
} from './voices.js';
import { speechFile, fileName } from './audio.js';
import { makeZip } from './zip.js';
import { saveClip, deleteClip, clearClips, allClips, askToKeep } from './clips.js';

/* A batch waits out a pause this short, and stops for anything longer. */
const LONGEST_WAIT = 90 * 1000;
const VOICES_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const RANDOM = '';

const $ = (id) => document.getElementById(id);

/* localStorage may be unavailable or full, and a prefix keeps this app's
   entries apart from any other project on the same github.io origin. */
const store = {
  get(name, fallback) {
    try {
      const raw = localStorage.getItem(`starling.${name}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(`starling.${name}`, JSON.stringify(value));
    } catch (e) {
      setStatus('This browser would not save settings, so they will be lost on reload.', true);
    }
  },
};

let ring = new KeyRing({ keys: store.get('keys', []), state: store.get('keyState', {}) });
let library = store.get('voices', { at: 0, list: [] }).list;
let clips = [];
let running = null;
const urls = new Map();

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function formatWait(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function saveLater(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ── keys ────────────────────────────────────────────────────────────── */

function persistRing() {
  store.set('keyState', ring.getState());
  renderKeys();
}

const STATUS_WORDS = {
  ready: () => 'Ready',
  minute: (s) => `Back in ${formatWait(s.until - Date.now())}`,
  day: (s) => `Daily limit, back in ${formatWait(s.until - Date.now())}`,
  refused: () => 'Refused by Google',
};

function renderKeys() {
  const model = $('model').value.trim();
  const body = document.querySelector('#keys-table tbody');
  body.replaceChildren(...ring.keys.map((key) => {
    const status = ring.status(key, model);
    const row = document.createElement('tr');
    const cell = (text, className) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (className) td.className = className;
      row.append(td);
      return td;
    };
    cell(keyTail(key), 'key');
    cell(STATUS_WORDS[status.kind](status), `s-${status.kind}`).title = status.detail || '';
    cell(String(ring.usedToday(key)));
    const action = cell('');
    if (status.kind !== 'ready') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        ring.reset(key);
        persistRing();
      });
      action.append(retry);
    }
    return row;
  }));
  $('keys-table').hidden = !ring.keys.length;
  const ready = ring.keys.filter((key) => ring.available(key, model)).length;
  $('keys-summary').textContent = ring.keys.length ? `${ready} of ${ring.keys.length} ready` : 'none yet';
}

function saveKeys() {
  const keys = parseKeys($('keys-input').value);
  store.set('keys', keys);
  ring = new KeyRing({ keys, state: ring.getState() });
  $('keys-input').value = keys.join('\n');
  $('keys-note').textContent = keys.length ? `${keys.length} saved.` : 'No keys found.';
  persistRing();
  refreshGenerate();
  if (keys.length && !library.length) loadLibrary();
}

/* ── voices ──────────────────────────────────────────────────────────── */

async function loadLibrary() {
  const key = ring.pick($('model').value.trim());
  if (!key) return;
  try {
    const raw = await listVoices({ key });
    library = raw.map(normalizeVoice).filter((v) => v.id);
    store.set('voices', { at: Date.now(), list: library });
  } catch (e) {
    console.warn('Could not load the Voice Library.', e);
  }
  renderVoices();
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function group(label, options) {
  const g = document.createElement('optgroup');
  g.label = label;
  g.append(...options);
  return g;
}

function renderVoices() {
  const language = languageById($('language').value);
  const regional = voicesFor(language.id, library);
  const select = $('voice');
  const chosen = select.value || store.get('prefs', {}).voice || RANDOM;

  const groups = [option(RANDOM, regional.length ? `Random ${language.label} voice` : 'Random voice')];
  if (regional.length) groups.push(group(`${language.label} voices`, regional.map((v) => option(v.id, voiceLabel(v)))));
  groups.push(group('Studio voices', STUDIO_VOICES.map(([name, trait]) => option(name, `${name} (${trait})`))));
  select.replaceChildren(...groups);
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : RANDOM;

  let note = '';
  if (language.id !== 'other' && !regional.length) {
    note = library.length
      ? `The Voice Library has no ${language.label} voices listed, so studio voices will read it in their own accent.`
      : `Regional voices load once a key is saved. Until then studio voices read ${language.label} in their own accent.`;
  }
  $('voice-note').textContent = note;
}

function voiceName(id) {
  return library.find((v) => v.id === id)?.name || id;
}

/* ── clips ───────────────────────────────────────────────────────────── */

function clipUrl(clip) {
  if (!urls.has(clip.id)) urls.set(clip.id, URL.createObjectURL(clip.blob));
  return urls.get(clip.id);
}

function dropUrl(id) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function clipRow(clip) {
  const li = document.createElement('li');
  li.className = 'clip';
  const text = document.createElement('p');
  text.textContent = clip.text;
  text.lang = languageById(clip.language).id === 'other' ? '' : clip.language;
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    languageById(clip.language).label, voiceName(clip.voice),
    clip.seconds ? `${clip.seconds.toFixed(1)}s` : '',
    `${clip.ext.toUpperCase()}, ${formatSize(clip.blob.size)}`,
  ].filter(Boolean).join(' · ');
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = clipUrl(clip);
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.append(
    button('Download', () => saveLater(clip.blob, clip.name)),
    button('Delete', async () => {
      await deleteClip(clip.id);
      dropUrl(clip.id);
      clips = clips.filter((c) => c.id !== clip.id);
      renderClips();
    }),
  );
  li.append(text, meta, audio, actions);
  return li;
}

function renderClips() {
  $('clips').replaceChildren(...clips.map(clipRow));
  $('clip-count').textContent = clips.length ? `(${clips.length})` : '';
  $('save-all').hidden = $('clear-all').hidden = clips.length < 2;
}

async function downloadAll() {
  const taken = new Set();
  const files = await Promise.all(clips.map(async (clip) => {
    /* Two takes of one line differ only by voice, or not at all. */
    const stem = clip.name.replace(/\.\w+$/, '');
    let name = clip.name;
    for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.${clip.ext}`;
    taken.add(name);
    return { name, bytes: new Uint8Array(await clip.blob.arrayBuffer()) };
  }));
  saveLater(makeZip(files), 'starling-clips.zip');
}

async function deleteAll() {
  if (!confirm(`Delete all ${clips.length} clips from this browser?`)) return;
  await clearClips();
  clips.forEach((c) => dropUrl(c.id));
  clips = [];
  renderClips();
}

/* ── generating ──────────────────────────────────────────────────────── */

function refreshGenerate() {
  $('generate').disabled = !!running || !ring.keys.length;
  $('generate').title = ring.keys.length ? '' : 'Add an API key first.';
}

function setRunning(controller) {
  running = controller;
  $('stop').hidden = !controller;
  refreshGenerate();
}

function waitUntil(until, signal, label) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (signal.aborted) {
        clearInterval(timer);
        reject(signal.reason);
      } else if (Date.now() >= until) {
        clearInterval(timer);
        resolve();
      } else {
        setStatus(`${label} Waiting ${formatWait(until - Date.now())} for a key to come back.`);
      }
    };
    const timer = setInterval(tick, 500);
    tick();
  });
}

async function makeClip(text, settings, signal) {
  const voice = settings.voice || randomVoice(settings.language, library);
  for (;;) {
    try {
      const audio = await speak({
        ring, model: settings.model, text, voice, style: settings.style, signal,
        onChange: persistRing,
      });
      const file = await speechFile(audio.bytes, audio.mime, settings.format);
      const created = new Date().toISOString();
      const clip = {
        ...settings,
        id: `${created}-${Math.random().toString(36).slice(2, 8)}`,
        created, text, voice,
        ext: file.ext, seconds: file.seconds,
        name: fileName({ language: languageById(settings.language).short, voice: voiceName(voice), text, ext: file.ext }),
        blob: new Blob([file.bytes], { type: file.type }),
      };
      await saveClip(clip);
      return clip;
    } catch (e) {
      const soon = e instanceof KeysExhausted && e.until && e.until - Date.now() <= LONGEST_WAIT;
      if (!soon) throw e;
      await waitUntil(e.until, signal, 'All keys are at their per-minute limit.');
    }
  }
}

function explain(e, left) {
  const rest = left ? `\n${left} left in the text box.` : '';
  if (e instanceof KeysExhausted) {
    return (e.until
      ? `All keys are out of calls for this model. The next is back in ${formatWait(e.until - Date.now())}.`
      : 'Google refused every key. Check the list under API keys.') + rest;
  }
  if (e instanceof GeminiError) return e.message + rest;
  return `Something went wrong: ${e.message}${rest}`;
}

async function generate() {
  const input = $('text').value.trim();
  if (!input) {
    setStatus('Type some text first.', true);
    return;
  }
  const settings = {
    language: $('language').value, voice: $('voice').value, model: $('model').value.trim(),
    style: $('style').value.trim(), format: $('format').value,
  };
  const perLine = $('per-line').checked;
  const lines = perLine ? input.split('\n').map((l) => l.trim()).filter(Boolean) : [input];
  const controller = new AbortController();
  setRunning(controller);
  askToKeep();

  let done = 0;
  try {
    for (const line of lines) {
      setStatus(lines.length > 1 ? `Making clip ${done + 1} of ${lines.length}…` : 'Making your clip…');
      const clip = await makeClip(line, settings, controller.signal);
      clips.unshift(clip);
      renderClips();
      done++;
    }
    setStatus(lines.length > 1 ? `Made ${done} clips.` : 'Done.');
  } catch (e) {
    /* What has not been spoken stays in the box, so Generate picks up where
       this stopped. */
    if (perLine) $('text').value = lines.slice(done).join('\n');
    const left = perLine ? `${lines.length - done} line${lines.length - done === 1 ? '' : 's'}` : 0;
    if (controller.signal.aborted) setStatus(`Stopped.${left ? ` ${left} left in the text box.` : ''}`);
    else setStatus(explain(e, left), true);
  } finally {
    setRunning(null);
    persistRing();
  }
}

/* ── setup ───────────────────────────────────────────────────────────── */

function savePrefs() {
  store.set('prefs', {
    language: $('language').value, voice: $('voice').value, model: $('model').value.trim(),
    style: $('style').value, format: $('format').value, perLine: $('per-line').checked,
  });
}

async function init() {
  $('language').append(...LANGUAGES.map((l) => option(l.id, l.label)));
  $('models').append(...MODELS.map((m) => option(m, m)));

  const prefs = store.get('prefs', {});
  $('language').value = languageById(prefs.language).id;
  $('model').value = prefs.model || MODELS[0];
  $('style').value = prefs.style || '';
  $('format').value = prefs.format || 'ogg';
  $('per-line').checked = !!prefs.perLine;
  $('keys-input').value = ring.keys.join('\n');
  $('keys-panel').open = !ring.keys.length;

  renderVoices();
  renderKeys();
  refreshGenerate();

  $('keys-save').addEventListener('click', saveKeys);
  $('generate').addEventListener('click', generate);
  $('stop').addEventListener('click', () => running?.abort());
  $('save-all').addEventListener('click', downloadAll);
  $('clear-all').addEventListener('click', deleteAll);
  $('language').addEventListener('change', () => { renderVoices(); savePrefs(); });
  $('model').addEventListener('change', () => { renderKeys(); savePrefs(); });
  for (const id of ['voice', 'style', 'format', 'per-line']) $(id).addEventListener('change', savePrefs);
  setInterval(renderKeys, 30000);

  try {
    clips = await allClips();
    renderClips();
  } catch (e) {
    setStatus('This browser would not open its clip storage, so clips cannot be saved here.', true);
  }

  const cached = store.get('voices', { at: 0 });
  if (ring.keys.length && Date.now() - cached.at > VOICES_MAX_AGE) loadLibrary();
}

init();
