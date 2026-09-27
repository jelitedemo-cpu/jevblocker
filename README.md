# Jev Blocker

A system-wide DNS ad and redirect blocker for Android. No root required.

There are two clients in this repo sharing one curated blocklist:

- **`app/`** — the Android app. System-wide DNS filtering, covers every browser
  and app. This document.
- **`extension/`** — a Chrome extension for desktop. Full request-level blocking
  plus Jev-powered judgement of individual page elements. See
  [`extension/README.md`](extension/README.md). Verified working on Chrome 153
  on Windows; run `run-in-chrome.cmd` from the project root to launch it.

It runs a local `VpnService` tunnel that carries **only DNS traffic**, answers
blocked lookups locally with NXDOMAIN, and relays everything else to the
resolver the system was already using. Because the tunnel holds a `/32` route
for each DNS server address and nothing else, all other traffic bypasses it —
there is no userspace TCP stack, no added latency on normal browsing, and no
root.

## What it blocks

Ads and trackers are blocked by domain. This kills most real-world ad redirects,
because the chains people actually hit route through ad and tracker domains:

```
tap a link → tracker-a.com → tracker-b.com → scam site
                 ^                ^
                 both refused before a socket is ever opened
```

## What it cannot block

Stated plainly, because these are the parts that disappoint people:

- **Redirects through first-party or whitelisted domains.** A `window.location`
  hop on an allowed domain, or a same-site interstitial, is invisible at the DNS
  layer.
- **Ads served from the same domain as the page.** Needs DOM access.
- **Private DNS (DoT) must be off.** If it is on, lookups go straight to the
  resolver's IP over TLS and bypass the filter. Check *Settings → Network →
  Private DNS*.
- **Chrome's secure DNS must be off.** *Settings → Privacy → Use secure DNS*.
- **DNS over TCP is not handled.** Only UDP/53 is intercepted. Truncated
  responses may fall back to TCP and time out.
- **MITM interception is deliberately not implemented.** Installing a user CA
  breaks banking apps and anything with certificate pinning.

The content-level work is Stage 2: a WebView-based browser with request
interception and cosmetic filtering. That is also the only place a model like
[Jev](https://docs.typesafe.ai/introduction) becomes useful here — it can judge
whether an ambiguous element is an ad or an interstitial is deceptive, but only
where there is a DOM to ask about.

## Building

This project has no Gradle wrapper. CI installs Gradle 8.13 directly.

Push to GitHub and the `build` workflow runs the unit tests and produces a
downloadable APK:

1. Push this repo to GitHub.
2. Open the **Actions** tab and wait for the `build` workflow.
3. Download the `jev-blocker-debug` artifact from the run summary.
4. Sideload it: `adb install -r jev-blocker-debug/app-debug.apk`

Locally, with JDK 17, the Android SDK and Gradle 8.13 on `PATH`:

```bash
gradle :app:testDebugUnitTest
gradle :app:assembleDebug
```

## Layout

```
app/src/main/java/com/jev/blocker/
  dns/DnsPacket.kt      DNS question parsing, NXDOMAIN construction
  dns/IpPacket.kt       IPv4/IPv6 UDP parse and reply, checksums
  data/DomainSet.kt     domain matching with subdomain semantics
  data/BlocklistStore.kt asset seeding, multi-source download
  data/Stats.kt         query and block counters
  vpn/DnsRelay.kt       tunnel read loop, local answers, upstream relay
  vpn/JevVpnService.kt  tunnel setup and foreground service
  MainActivity.kt       toggle, stats, blocklist management
app/src/test/java/com/jev/blocker/PacketTest.kt
extension/                    Chrome extension, see its own README
run-in-chrome.cmd             Windows launcher and verifier for the extension
tools/verify_packets.py
tools/make_rules.py
tools/make_icons.py
tools/chrome-load-extension.mjs
```

`DnsPacket` and `IpPacket` deliberately have no Android dependencies, so the
byte-level logic runs under plain JVM unit tests.

`tools/make_rules.py` compiles `assets/blocklist.txt` into the extension's
declarativeNetRequest rulesets, so both clients block the same domains from one
source of truth. `tools/make_icons.py` writes the extension's PNG icons using
only the standard library.

`tools/verify_packets.py` is a line-by-line port of those two classes. It exists
so the wire format can be checked without an Android toolchain, which matters
when editing byte offsets:

```bash
python tools/verify_packets.py
```

It caught a real bug during development: the IPv6 UDP checksum was being taken
before the payload was copied into the buffer, so it was checksumming zeros.

## Notes

- The blocklist shipped in `assets/blocklist.txt` is a small starter set so
  filtering works offline on first launch. Use **Download blocklists** to merge
  StevenBlack, Peter Lowe, 1Hosts Lite and OISD.
- Auto-start is left to Android's own **Settings → Network → VPN → Always-on
  VPN** rather than a boot receiver, which avoids background service start
  restrictions.
- The app name uses `Jev`, which is a trademark of TypeSafe AI. Rename it before
  publishing anything to a store.
