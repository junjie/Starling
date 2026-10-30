/* Which API key to use next, and why the others are resting.

   No DOM and no network, so node can check every rule here.

   Google counts quota per project and per model, so a key that is out of
   calls for one model may be fine for another. A rest is therefore recorded
   against the key and the model together. A key Google has refused outright
   is different: that is true of every model, and it stays out of the rotation
   until someone says otherwise, because it will not get better by waiting.

   The ring is sticky: it stays on one key until that key hits a limit. Going
   round on every call would spread a batch across all the keys and leave each
   one half spent, with nothing gained. */

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function pacificParts(now) {
  return Object.fromEntries(PACIFIC.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
}

/* Daily quotas reset at midnight Pacific. On the two days a year the clocks
   change this is an hour out, which costs one refused call and another rest. */
export function nextPacificMidnight(now) {
  const p = pacificParts(now);
  const elapsed = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * SECOND;
  return now - elapsed + DAY;
}

function pacificDay(now) {
  const p = pacificParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/* One key per line. Anything else on the line is ignored, so a key pasted
   with a note beside it still works: keys never contain spaces. */
export function parseKeys(text) {
  const keys = String(text || '').split('\n')
    .map((line) => line.trim().split(/[\s,;]+/).find((word) => word.length >= 20))
    .filter(Boolean);
  return [...new Set(keys)];
}

export function keyTail(key) {
  return '…' + String(key).slice(-4);
}

/* What a failed response means for the rotation:
     minute   rate limited, back shortly: rest the key for the delay given
     day      out of calls until the daily reset: rest it until then
     refused  the key itself is bad: take it out of the rotation
     server   Google's side failed: worth another try, says nothing of the key
     request  this request is wrong: no key would do better, so stop */
export function classifyFailure(status, bodyText, now) {
  let error = {};
  try { error = JSON.parse(bodyText).error || {}; } catch (e) { /* not JSON */ }
  const message = String(error.message || bodyText || `HTTP ${status}`).slice(0, 500);
  const details = Array.isArray(error.details) ? error.details : [];
  const text = JSON.stringify(details) + message;

  if (status === 429) {
    /* "limit: 0" means this project has no allowance for the model at all,
       which behaves like a day that never starts; retrying soon is pointless. */
    if (/PerDay|limit: 0\b/i.test(text)) {
      return { kind: 'day', until: nextPacificMidnight(now), message };
    }
    const retry = details.map((d) => /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay || '')).find(Boolean);
    const seconds = retry ? Math.ceil(Number(retry[1])) + 1 : 60;
    return { kind: 'minute', until: now + seconds * SECOND, message };
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|API key expired/i.test(text)) {
    return { kind: 'refused', message };
  }
  if (status >= 500) return { kind: 'server', message };
  return { kind: 'request', message };
}

export class KeyRing {
  /* `state` is what getState() returned earlier. Rests survive a reload: a key
     that hit its daily limit is still out of calls after the page is reopened,
     and finding that out again would spend a refused call per key per visit. */
  constructor({ keys = [], state = {}, now = () => Date.now() } = {}) {
    this.keys = keys;
    this.now = now;
    this.state = {};
    for (const key of keys) {
      const s = (state.keys && state.keys[key]) || {};
      this.state[key] = {
        rests: { ...s.rests }, refused: s.refused || '',
        used: s.used || 0, usedDay: s.usedDay || '',
      };
    }
    this.current = keys.includes(state.current) ? state.current : keys[0];
  }

  getState() {
    return { keys: this.state, current: this.current };
  }

  available(key, model) {
    const s = this.state[key];
    return !s.refused && (s.rests[model]?.until || 0) <= this.now();
  }

  /* The key to use, or null when none can take a call for this model. */
  pick(model) {
    const start = Math.max(0, this.keys.indexOf(this.current));
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[(start + i) % this.keys.length];
      if (this.available(key, model)) {
        this.current = key;
        return key;
      }
    }
    return null;
  }

  /* When the next key comes back for this model, or null if none ever will
     without someone fixing the list. */
  soonest(model) {
    const times = this.keys.filter((key) => !this.state[key].refused)
      .map((key) => this.state[key].rests[model]?.until || 0);
    return times.length ? Math.min(...times) : null;
  }

  rest(key, model, until, kind) {
    this.state[key].rests[model] = { until, kind };
  }

  refuse(key, why) {
    this.state[key].refused = why;
  }

  /* Back into the rotation by hand, for a key that was fixed, or topped up. */
  reset(key) {
    this.state[key].refused = '';
    this.state[key].rests = {};
  }

  recordUse(key) {
    const s = this.state[key];
    const today = pacificDay(this.now());
    if (s.usedDay !== today) {
      s.usedDay = today;
      s.used = 0;
    }
    s.used += 1;
  }

  usedToday(key) {
    const s = this.state[key];
    return s.usedDay === pacificDay(this.now()) ? s.used : 0;
  }

  /* For the keys table. Only the rest for this model counts: a key resting on
     another model is ready for this one. */
  status(key, model) {
    const s = this.state[key];
    if (s.refused) return { kind: 'refused', detail: s.refused };
    const rest = s.rests[model];
    if (rest && rest.until > this.now()) return { kind: rest.kind, until: rest.until };
    return { kind: 'ready' };
  }
}
