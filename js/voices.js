/* The voices on offer, and which suit which language.

   Gemini TTS detects the language from the text, so choosing a language here
   changes no request: what it does is choose the voice. That is also how
   Mainland and Taiwan speech differ. Google's advice is not to ask for an
   accent in the style text but to pick a regional voice from the Voice
   Library, so each language below is a test over the library's voices. */

/* Name, Google's one-word style, and gender. The Gemini API docs give only the
   first two; the genders are from the Cloud Text-to-Speech Gemini-TTS page. */
export const STUDIO_VOICES = [
  ['Zephyr', 'Bright', 'female'], ['Puck', 'Upbeat', 'male'], ['Charon', 'Informative', 'male'],
  ['Kore', 'Firm', 'female'], ['Fenrir', 'Excitable', 'male'], ['Leda', 'Youthful', 'female'],
  ['Orus', 'Firm', 'male'], ['Aoede', 'Breezy', 'female'], ['Callirrhoe', 'Easy-going', 'female'],
  ['Autonoe', 'Bright', 'female'], ['Enceladus', 'Breathy', 'male'], ['Iapetus', 'Clear', 'male'],
  ['Umbriel', 'Easy-going', 'male'], ['Algieba', 'Smooth', 'male'], ['Despina', 'Smooth', 'female'],
  ['Erinome', 'Clear', 'female'], ['Algenib', 'Gravelly', 'male'], ['Rasalgethi', 'Informative', 'male'],
  ['Laomedeia', 'Upbeat', 'female'], ['Achernar', 'Soft', 'female'], ['Alnilam', 'Firm', 'male'],
  ['Schedar', 'Even', 'male'], ['Gacrux', 'Mature', 'female'], ['Pulcherrima', 'Forward', 'female'],
  ['Achird', 'Friendly', 'male'], ['Zubenelgenubi', 'Casual', 'male'],
  ['Vindemiatrix', 'Gentle', 'female'], ['Sadachbia', 'Lively', 'male'],
  ['Sadaltager', 'Knowledgeable', 'male'], ['Sulafat', 'Warm', 'female'],
];

export const MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

/* The docs do not say how the library files Chinese (cmn-CN, zh-CN, or a
   region code beside a bare zh), so each test reads the code, the region and
   the accent, and any one of them is enough. Cantonese (yue, zh-HK) matches
   neither on purpose. */
const isMandarin = (v) => /^(zh|cmn)\b/i.test(v.language);
const inRegion = (v, region) => v.region.toUpperCase() === region
  || new RegExp(`-${region}$`, 'i').test(v.language);

export const LANGUAGES = [
  {
    id: 'zh-CN', label: 'Chinese (Mainland)', short: 'zh-CN',
    matches: (v) => isMandarin(v) && (inRegion(v, 'CN') || /mainland|beijing|putonghua/i.test(v.accent)),
  },
  {
    id: 'zh-TW', label: 'Chinese (Taiwan)', short: 'zh-TW',
    matches: (v) => isMandarin(v) && (inRegion(v, 'TW') || /taiwan/i.test(v.accent)),
  },
  { id: 'vi', label: 'Vietnamese', short: 'vi', matches: (v) => /^vi\b/i.test(v.language) },
  { id: 'other', label: 'Any language', short: 'tts', matches: () => false },
];

export function languageById(id) {
  return LANGUAGES.find((l) => l.id === id) || LANGUAGES[0];
}

/* The reference puts these fields on the voice, a nested `prompted` block, or
   both, and REST may spell them either way, so one flat shape is made here. */
export function normalizeVoice(raw) {
  const nested = raw.prompted || {};
  const read = (snake, camel) => raw[snake] || raw[camel] || nested[snake] || nested[camel] || '';
  return {
    id: raw.id || '',
    name: read('display_name', 'displayName') || raw.id || '',
    language: read('language_code', 'languageCode'),
    region: read('region_code', 'regionCode'),
    accent: read('accent', 'accent'),
    gender: read('gender', 'gender'),
  };
}

export function voicesFor(languageId, library) {
  return library.filter(languageById(languageId).matches);
}

export function voiceLabel(v) {
  const traits = [v.accent, v.gender].filter(Boolean).join(', ');
  return traits ? `${v.name} (${traits})` : v.name;
}

/* What "Random" draws from: the voices made for this language when there are
   any, otherwise the studio voices, which read any language. */
export function randomVoice(languageId, library, random = Math.random) {
  const regional = voicesFor(languageId, library).map((v) => v.id);
  const pool = regional.length ? regional : STUDIO_VOICES.map(([name]) => name);
  return pool[Math.floor(random() * pool.length)];
}
