# Jev Blocker — Chrome extension

Blocks ads, trackers and redirect chains with Chrome's declarativeNetRequest
engine, then asks **Jev** to judge the elements a blocklist cannot.

> **Chrome for Android does not support extensions — as of mid-2026 it still has
> no extension support at all.** This works in desktop Chrome. For Android, see
> the note at the bottom.

## Running it on Windows

Verified against **Chrome 153.0.8010.53 on Windows**. Two ways in.

### One click

From the project root, double-click `run-in-chrome.cmd` — or from a terminal:

```cmd
run-in-chrome.cmd          :: launch Chrome with the extension loaded
run-in-chrome.cmd verify   :: check it loads and that blocking works
```

This launches Chrome with a dedicated profile at
`%LOCALAPPDATA%\JevBlocker\chrome-profile`, so your normal profile is never
touched and your Jev API key survives between runs. It needs Node.js on `PATH`;
if it is missing, the script prints the manual steps instead.

### Manual

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Pin the toolbar icon

> **Chrome 137 removed the `--load-extension` flag.** Any launcher built around
> it silently does nothing on current Chrome. The supported replacement is the
> DevTools Protocol command `Extensions.loadUnpacked`, which is what
> `run-in-chrome.cmd` drives.

## What "verify" actually checks

`run-in-chrome.cmd verify` is not a smoke test. It loads the extension into a
real Chrome, attaches to the service worker, and then:

- asks Chrome which rules match eight specific URLs, including two negative
  cases that must **not** match
- performs a real navigation to a local server and asserts the outcome: the
  landing request arrives as `/landing?keep=1` with `utm_source` and `gclid`
  gone, and the ad request never reaches the server at all

The ad host is remapped to `127.0.0.1` for that last check, so a failing block
rule shows up on our own server instead of quietly going out to the internet.

## Add your Jev API key

Click the toolbar icon → **Settings** → paste the key into **API key** → **Save**
→ **Test Jev connection**.

The key is stored in `chrome.storage.local` for this browser profile only. It is
read **only by the extension's service worker** and is never handed to a content
script, so a page cannot read it out of the DOM. Please don't paste it into a
chat window — type it into the settings field directly.

Jev judging is **off by default**. Turn on **Use Jev** when you want it, so you
can compare how the page behaves with and without it.

## How the two halves work

**Blocklists do the bulk.** 143 domains compiled into 286 declarativeNetRequest
rules, generated from the same curated list the Android app uses:

- `rules/ads.json` — blocks third-party requests to ad and tracker hosts
- `rules/redirects.json` — blocks top-level navigation to known ad redirectors,
  which is what kills a redirect chain
- `rules/tracking-params.json` — strips `utm_*`, `gclid`, `fbclid` and friends
  from addresses using a `queryTransform` redirect

**Jev handles the ambiguous residue.** A blocklist can only match a domain. It
cannot tell whether *this particular div* is an ad. So the content script:

1. Scores every visible element for ad-likeness — id and class segments matching
   `ad`/`advert`/`sponsor`, cross-origin iframes, `data-ad-slot`, fixed
   positioning, suspicious z-index, "Advertisement" text
2. Keeps the top N (default 8) and describes each one compactly
3. Sends **one** request containing one `noul` question per candidate
4. Hides any element whose probability clears the confidence threshold

Step 3 is the point. Every question is evaluated in parallel and in isolation
against the same state, so eight candidates cost barely more than one and cannot
degrade each other — TypeSafe calls this speculative fan-out. A page that would
need eight sequential LLM calls needs one Jev call.

Confidence gating is what makes it safe: at the default `0.80`, an element has
to be clearly an ad before anything is hidden.

## Testing it

Start with **Jev off** and confirm the blocklist side works:

- Open a news site. The blocked counter should climb.
- Check a URL with tracking params — `?utm_source=...` should be gone from the
  address bar after the page loads.
- `chrome://extensions` → **Errors** should be empty.

Then turn **Jev on** and use **Judge this page with Jev** in the popup. The popup
reports how many elements it judged and how many it hid, and the console logs
each verdict with its probability so you can see the reasoning. If it is hiding
things it should not, raise the threshold.

## Files

```
manifest.json                 MV3, permissions, ruleset wiring
rules/ads.json                generated — third-party ad and tracker blocking
rules/redirects.json          generated — navigation blocking for redirectors
rules/tracking-params.json    hand-written — one queryTransform redirect rule
src/background.js             service worker: rulesets, stats, Jev calls
src/content.js                candidate scoring, cosmetic hiding, Jev questions
src/shared.js                 settings, stats, the Jev API client
src/popup.*                   toolbar UI and manual judge trigger
src/options.*                 settings and connection test
icons/                        generated by tools/make_icons.py
```

Regenerate the rules after editing the blocklist:

```bash
python tools/make_rules.py
python tools/make_icons.py
```

## Two Chrome limits worth knowing

Both of these cost real debugging time, and neither is obvious.

**A `regexFilter` over 2KB of compiled memory is skipped silently.** The rule
simply does not exist at runtime — the ruleset still loads, the extension still
works, and `getDisabledRuleIds()` still returns an empty array. There is no
error anywhere. The tracking-parameter rules originally used one `regexFilter`
with 29 alternatives and were dropped for this reason. They now use `urlFilter`,
which has no such limit. If you add regex rules, keep them small.

**`chrome.runtime.sendMessage` throws synchronously** once the extension context
is invalidated, which happens on every reload during development. A `.catch()`
on the returned promise does not cover it.

## Known limitations

- **Ad personalisation is not the same as ad removal.** Blocking the ad domain
  leaves the space empty; it does not reflow the layout.
- **First-party ads survive.** An ad served from the page's own domain is
  invisible to a domain blocklist. Jev is what catches those, and only when it
  can see them.
- **`chrome.declarativeNetRequest` cannot inspect response bodies**, so
  redirects implemented in page JavaScript on an allowed domain are out of
  reach for the blocking layer.
- **The blocked counter is best-effort.** It reads
  `onRuleMatchedDebug`, which Chrome only exposes to unpacked extensions. A
  packed build will show zero there.
- **Jev judging costs money.** It is very cheap — output tokens are free and
  input is $0.042/M — but it is not zero. The minimum-gap setting exists to stop
  a tab-happy session from hammering the API.
- **Not published to the Web Store**, and the name uses a TypeSafe AI trademark.
  Rename before publishing.

## Android

Chrome for Android has no extension support, so this file cannot be loaded
there. Your options:

1. **The Android app in this repo** (`app/`) — system-wide DNS filtering, already
   built, no root.
2. **A Chromium fork that loads Chrome extensions** — Edge Canary and Kiwi
   Browser both accept unpacked Chrome extensions. This extension should load in
   either, though `declarativeNetRequest` behaviour varies by fork and version.
3. **Firefox for Android** with uBlock Origin, which is the zero-effort option.
