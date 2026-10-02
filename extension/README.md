# Jev Blocker — Chrome extension

Blocks ads, trackers and redirect chains with Chrome's declarativeNetRequest
engine, then asks **Jev** to judge the elements a blocklist cannot.

> **There is no `.exe` and no Start-menu entry.** This is a browser extension, so
> it lives inside Chrome — you load it once, then reach it from the toolbar
> (the puzzle-piece icon, top right). Nothing to install, nothing to launch.

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
real Chrome, attaches to the service worker, and runs four sections:

**1. Ruleset accounting.** For each ruleset, disables it and reads the
static-rule budget delta, which gives the exact number of rules Chrome is
holding. Those must equal the counts declared in the manifest, exactly. This is
the section that matters most: it is what caught 15 rules being silently
discarded, and it is the only thing that would catch it again.

**2. Rule matching.** Asks Chrome which rules match eight specific URLs,
including two negative cases that must **not** match.

**3. Cosmetic filtering.** Picks a real EasyList entry for a real domain,
remaps that domain to `127.0.0.1`, serves a page containing a matching element,
and asserts it is hidden. This exercises the parent-domain walk in the service
worker, not just the compiler.

**4. End-to-end navigation.** A real page load against a local server asserting
that the landing request arrives as `/landing?keep=1` with `utm_source` and
`gclid` gone, that the ad request never reaches the server, and that **every one
of the 263 testable cosmetic batches applied**.

That last check deserves a note. Extension-injected CSS does not appear in
`document.styleSheets`, so a dropped batch cannot be found by counting parsed
rules. The only reliable question is whether a selector from that batch actually
matched — so every batch gets a test element on the page, and all of them must
come back hidden.

The ad host is remapped to `127.0.0.1` so a failing block rule shows up on our
own server instead of quietly going out to the internet.

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

**Blocklists do the bulk.** The same community lists Brave and uBlock Origin
use — **EasyList** and **EasyPrivacy** — compiled into **115,697
declarativeNetRequest rules** across ten static rulesets. Chrome's `urlFilter`
syntax is deliberately Adblock Plus compatible, so `||ads.example.com^` is valid
in both and most filters transfer verbatim.

`tools/compile_filters.py` does the conversion. It reads the lists from
`.cache/lists/`, maps `$third-party` onto `domainType`, `$script` and friends
onto `resourceTypes`, `$domain=` onto `initiatorDomains`, and turns `@@`
exceptions into priority-2 `allow` rules. Filters it cannot express are dropped
rather than approximated, and it reports every reason.

Alongside those, three small curated rulesets survive as a guaranteed floor:

- `rules/ads.json` — 143 rules for the worst-known offenders
- `rules/redirects.json` — 143 rules blocking top-level navigation to ad redirectors
- `rules/tracking-params.json` — 35 `queryTransform` rules stripping `utm_*`, `gclid`, `fbclid`

They load *first*, so if Chrome's static-rule budget is too tight for the big
rulesets, the extension degrades to fewer rules rather than to none.

**Cosmetic filtering is what makes ads vanish.** A blocklist leaves holes; CSS
hiding removes the element and lets the page reflow. Two layers:

- **Generic** — 13,628 EasyList selectors applying to every site, batched into
  209 KB of CSS. Registered at runtime so it can be switched off.
- **Site-specific** — 16,451 selectors across 7,695 domains, plus 57 wildcard
  entries like `*.amazon`. Served on demand by the service worker, which walks
  up the parent domains so `news.bbc.co.uk` picks up `bbc.co.uk` rules.

The generic set is the only part of the extension that can hide something
legitimate, which is why it has its own toggle separate from the site-specific
rules.

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

## Keeping the lists current

EasyList and EasyPrivacy change daily, so the compiled rules go stale. A
scheduled job re-runs the compiler and the full verification weekly, and commits
only if every check passes.

To do it by hand:

```bash
python tools/compile_filters.py     # re-download and recompile
node tools/check-regexes.mjs        # must report zero regexFilters
run-in-chrome.cmd verify            # must pass all four sections
```

`compile_filters.py` warns if `manifest.json` does not declare a ruleset it
generated — a ruleset missing from the manifest never loads and nothing else
reports it.

## Files

```
manifest.json                 MV3, permissions, ruleset wiring
rules/filters-01..10.json     generated — EasyList + EasyPrivacy, ~115k rules
rules/ads.json                curated — worst-known offenders, guaranteed floor
rules/redirects.json          curated — top-level navigation to redirectors
rules/tracking-params.json    curated — 35 queryTransform redirect rules
cosmetic/generic.css          generated — 13,628 selectors in 273 batches
cosmetic/domains.json         generated — 7,695 domains of site-specific rules
src/ruleset-sizes.js          generated — rule counts, for budget fitting
src/background.js             service worker: rulesets, stats, Jev, cosmetic lookup
src/content.js                candidate scoring, cosmetic hiding, Jev questions
src/youtube.js                YouTube player patcher (main world) — see its section
src/shared.js                 settings, stats, the Jev API client
src/popup.*                   toolbar UI and manual judge trigger
src/options.*                 settings and connection test
icons/                        generated by tools/make_icons.py
```

Verify the YouTube patcher with:

```bash
node tools/check-youtube.mjs
```

Regenerate after editing the curated blocklist or the icons:

```bash
python tools/make_rules.py
python tools/make_icons.py
```

## Chrome limits worth knowing

Every one of these cost real debugging time, and none is obvious. They share a
theme: **Chrome drops things quietly.** Nothing throws, nothing logs, and the
extension still reports itself healthy. The rule is to never trust that
something loaded — ask Chrome whether it is there.

**A `regexFilter` over 2 KB once compiled is skipped silently.** The rule does
not exist at runtime. The ruleset still loads, the extension still works, and
`getDisabledRuleIds()` returns an empty array. This has now bitten twice: first
the tracking-parameter rules, then **15 of the 29 regexes** EasyList produced,
rejected with `memoryLimitExceeded`. The compiler therefore emits **no regexes
at all** — they are 29 of 115,000 filters, and the only class whose validity
cannot be established without a browser. `tools/check-regexes.mjs` asserts this
stays true, and `tools/find-rejected-rules.mjs` will bisect any rule Chrome
refuses if one ever reappears.

**The guaranteed static-rule budget is 30,000, not 330,000.** That 30,000 is
shared across every installed extension. This machine grants 330,000, but that
is not contractual. `background.js` therefore fits the rulesets into whatever
budget is actually available and reports what it got, so a tight budget shows
up as reduced protection in the popup rather than as a failed enable call.

**`chrome.runtime.sendMessage` throws synchronously** once the extension context
is invalidated, which happens on every reload during development. A `.catch()`
on the returned promise does not cover it.

**Chrome 137 removed `--load-extension`.** Any launcher built around it silently
does nothing. The supported replacement is the DevTools Protocol command
`Extensions.loadUnpacked`, which is what `run-in-chrome.cmd` drives.

## YouTube and other video sites

**YouTube is handled by a dedicated player patcher, not by the blocklist.**
Everything below about the other video sites still applies to them.

### Why the normal layers cannot do it

YouTube's ads come from the same hosts as the video itself (`youtube.com`,
`googlevideo.com`), so a domain blocklist cannot separate them. Blocking those
hosts would stop playback entirely rather than remove an ad. Increasingly the ads
are stitched into the video stream server-side, which means there is no separate
request to block in the first place.

The cosmetic layer is not a workaround either. YouTube's ad UI lives inside the
player's own DOM, and `AD_HINT` **does** match it — `ytp-ad-skip-button`,
`ytp-ad-module`, `video-ads`, `ytp-ad-player-overlay` all trip the regex. Hiding
those elements does not skip an ad. It removes the skip button, or leaves a black
hole where the player controls used to be.

### What the patcher does

`src/youtube.js` runs in the page's **main world** at `document_start` and
removes the ad fields from the player response before the player ever reads them:
`adPlacements`, `playerAds`, `adSlots`, `adParams`, `adBreakHeartbeatParams`, and
`playerConfig.adConfig`. With those gone there is nothing to schedule, so no
pre-roll and no mid-roll.

Three things make this work, and all three are load-bearing:

- **`world: "MAIN"`.** A normal content script runs in an isolated world with its
  own `window.fetch`. Patching that would look like it worked and change nothing.
  The registration is made from the service worker via
  `chrome.scripting.registerContentScripts`, which is the only way to reach the
  main world with the permissions this extension already has.
- **`runAt: "document_start"`.** The player caches its response early. A hook
  installed after it lands misses the first — and usually the only — request.
- **`Response` reconstruction in `fetch`.** The body is read from a clone and a
  new `Response` is returned, because a body that has already been read cannot be
  mutated in place.

It fails safe by construction. If a hook cannot be installed, or a body is not
JSON, or the shape is unfamiliar, the response is passed through untouched — the
page behaves exactly as it would with no extension at all. Playback data
(`streamingData`, `videoDetails`) is never modified; only fields that name an ad
are touched. A blocker that breaks video is worse than no blocker.

### The honest caveat

This depends on YouTube's internal field names, so it is an arms race. It is what
uBlock Origin does, and like uBlock Origin it will occasionally need updating when
YouTube changes its internals. The difference from the rest of the extension is
that the rest degrades gracefully on its own, while this one needs a human to
notice and fix it. Turn it off with **Skip YouTube ads** in Settings if it ever
misbehaves — playback is never at risk, only ad removal.

Verify it with:

```
node tools/check-youtube.mjs
```

That test serves a fake player response over HTTPS on a real `youtube.com` origin
(HSTS-preloaded, so the server must speak TLS) and asserts that the page's own
`fetch` is patched, that ad fields are stripped, and that an ad-free response
comes back byte-identical.

### Other video sites

Netflix, Twitch, Vimeo, Disney+, Prime Video, Hulu and Dailymotion are still left
alone: `content.js` carries a `PROTECTED_HOSTS` list and does nothing at all on
those hosts. Network rules still apply there — blocking `doubleclick.net` is
harmless and occasionally helps — but no element is ever hidden, and no Jev call
is made. Pressing **Judge this page** on one of them says so rather than failing
silently.

Protected hosts: `youtube.com`, `youtu.be`, `youtube-nocookie.com`, `netflix.com`,
`twitch.tv`, `vimeo.com`, `disneyplus.com`, `primevideo.com`, `hulu.com`,
`dailymotion.com`. YouTube is on this list too — the cosmetic layer still must not
touch it — but the patcher handles it through a separate path.

## Known limitations

- **Generic cosmetic filtering can hide something legitimate.** 13,628
  selectors applying to every site is a lot of surface area. It is why the
  toggle exists. If a site loses content it should have kept, turn off
  **Hide generic ad patterns on every site** and report it upstream to EasyList.
- **First-party ads still survive.** An ad served from the page's own domain
  gets past the network layer. Jev is what catches those, and only when it can
  see them.
- **`chrome.declarativeNetRequest` cannot inspect response bodies**, so
  redirects implemented in page JavaScript on an allowed domain are out of
  reach for the blocking layer.
- **Three Brave capabilities are out of reach entirely.** CNAME uncloaking needs
  to resolve DNS itself, fingerprint randomisation needs to patch the browser's
  canvas and audio APIs, and response-body filtering needs engine-level access.
  An extension cannot do any of them, no matter how it is written.
- **The blocked counter is best-effort.** It reads `onRuleMatchedDebug`, which
  Chrome only exposes to unpacked extensions. A packed build will show zero.
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
