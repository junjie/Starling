# Starling

Text to speech through the Google Gemini API, from a single static page. Paste in
a few API keys, type some text, listen, and save the clip. Made for Chinese
(Mainland and Taiwan) and Vietnamese; any language Gemini reads will work.

There is no server. The page calls Google directly from your browser.

## Using it

1. Get a key from [Google AI Studio](https://aistudio.google.com/api-keys) and
   paste it under **API keys**, one per line.
2. Choose a language and a voice, or leave the voice on Random.
3. Type your text and press **Generate**. Tick **One clip per line** to make one
   clip from each line.
4. Play the clip, then **Download** it, or **Download all** for a zip.

## How the keys work

Keys are used in order. The page stays on one key until Google says it has hit
a limit, then moves to the next:

- **Per-minute limit:** the key rests for as long as Google asks. If every key
  is resting and one is back within 90 seconds, a batch waits for it.
- **Daily limit:** the key rests until midnight Pacific, when Google resets it.
- **Refused:** a bad, expired or blocked key leaves the rotation until you press
  **Try again**.

If a batch stops, the lines it did not reach stay in the text box, so pressing
Generate carries on from there.

**Each key needs its own Google Cloud project.** Google counts limits per
project, not per key, so a second key from the same project adds nothing.

## Languages and voices

Gemini works out the language from the text, so the language menu chooses which
voices are offered rather than changing what is sent. Simplified or Traditional
characters decide the script.

Mainland and Taiwan differ by voice. Google advises against asking for an accent
in the style box, and to pick a regional voice from its Voice Library instead.
The page loads that library with your key and lists the voices that match. If a
language has none, the 30 studio voices are offered: these can read any
language, but in their own accent.

## Where your data goes

- Keys are in this browser's `localStorage` and are sent only to Google, in a
  request header. They are not in this repository.
- Clips are in this browser's IndexedDB. A browser can clear site data, and
  Safari may do so for a site you have not visited in a week, so download what
  you want to keep.
- Every site under the same `github.io` account shares one browser storage
  origin, so another project of yours on that account could read these keys.
- You can restrict a key to this site's address in the Google Cloud console,
  which makes a leaked key much less useful.

## Running it locally

```sh
python3 -m http.server 8010        # modules do not load from file://
node --test "test/*.test.mjs"      # unit tests, Node's built-in runner
```

No build step, no dependencies. Publishing is GitHub Pages serving the `main`
branch as it is.

## Name

The starling is a songbird known for copying sounds, human speech included.

Gemini is a trademark of Google LLC. Starling is an independent project, not
affiliated with or endorsed by Google.
