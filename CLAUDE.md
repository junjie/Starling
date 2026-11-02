# CLAUDE.md

Guidance for working on Starling. The README is the user-facing documentation;
read it first. This covers what it does not.

## What this is

A static page that makes speech with the Google Gemini API, on a ring of the
user's own keys. Served as-is from GitHub Pages at
https://junjie.github.io/Starling/ (capital S; lowercase is a 404). No build
step, no npm dependencies, no server. Keep it that way.

```sh
python3 -m http.server 8010 --bind 127.0.0.1   # preview; not file://
node --test "test/*.test.mjs"                  # unit tests
```

The browser check drives the real page in WebKit with Google's API faked. It
needs Playwright, which is not a dependency here, and finds it from the folder
it is run in, so run it from a folder that has Playwright installed:

```sh
cd ../LearnWithAri/tools && node ../../starling/test/browser-check.mjs
```

It writes `starling.png` and `starling-phone.png` there. Look at them after a
visual change.

## How the code is laid out

- `keyring.js`: which key is next, and how a failure is classified. Pure.
- `gemini.js`: the speech and voice-list calls. `speak()` is the only place
  that knows the request shape.
- `voices.js`: studio voices and which library voices match each language.
- `audio.js`, `opus.js`: WAV and Ogg files. `zip.js`: Download all.
- `clips.js`: IndexedDB. `app.js`: all the DOM.

## Rules the code keeps

- Keys live in `localStorage` only and go only to Google, in the
  `x-goog-api-key` header, never a URL. Nothing else may leave the page; the
  CSP in `index.html` enforces it.
- `junjie.github.io/*` is one origin shared with the owner's other projects, so
  every storage name carries the `starling` prefix. Changing that prefix strands
  saved keys and clips, so do not do it casually.
- The referrer policy must stay `strict-origin`: a key restricted to this
  website is refused without it.
- The product name must not contain "Gemini". Google's API brand guidance says
  a third-party name must be wholly its own. Saying it works with the Google
  Gemini API is fine, and the footer carries the trademark line.
- Code from nejra0031/languageStudy-web may not be copied: that repo has no
  licence. `opus.js` and `wavSamples` came across only because Lin Junjie wrote
  them.
- Facts about Google worth remembering: quota is per project, not per key;
  daily limits reset at midnight Pacific; the language is detected from the
  text; Google says to use a regional voice for an accent, not the style text.

## Conventions

- Comments explain why, in full sentences. UI labels are sentence case.
- User-visible changes update the README in the same commit.
- One logical change per commit, imperative subject, prose body.
- Never add Claude attribution to commits or PRs.
- Never push without being asked: a push to `main` updates the live site.
- Push over SSH: `origin` is `git@github.com:junjie/Starling.git`. `gh` is not
  logged in.
- Each address has its own browser storage, so keys saved at localhost are not
  on the live site.

## Where it stands

Verified with a real key: the Voice Library list loads, and shows two Mainland
voices (Concierge 1, Tech Advisor 1).

Not yet verified against the real API (tests fake it):
- whether the Voice Library has Taiwan or Vietnamese voices;
- that Google accepts a website-restricted key with the current referrer policy;
- the failure bodies `classifyFailure` expects for real limits;
- how well the style box steers speed in Mandarin or Vietnamese.

Idea not built: a playback speed control on each clip, using
`audio.playbackRate`, as languageStudy-web's Dictation does. Browsers keep the
pitch by default. It would not change the downloaded file.

The name: Canonical has a speech-to-text tool called Myna, which is why this is
not called that. No text-to-speech product called Starling was found, but no
trademark register has been searched.
