/**
 * YouTube ad skipping.
 *
 * This is a fundamentally different job from the rest of the extension.
 * Everywhere else, ads are *separate things* -- a request to a tracker, an
 * iframe from an ad host, an element with `ad` in its class -- and the answer is
 * to block or hide them. YouTube is not like that:
 *
 *   * Ads come from the same hosts as the video (`youtube.com`,
 *     `googlevideo.com`), so a domain blocklist cannot separate them. Blocking
 *     those hosts stops playback, not the ad.
 *   * The ad is frequently stitched into the video stream server-side, so there
 *     is no second request to block at all.
 *   * The ad UI lives inside the player's own DOM, where hiding it does not skip
 *     the ad -- it removes the skip button and leaves a black hole.
 *
 * So the only way through is to patch the player before it can schedule an ad.
 * That is what this file does, and it is what uBlock Origin does. It is an arms
 * race: YouTube changes its internals and this breaks. Everything here is
 * therefore written to fail *safe* -- if a hook cannot be installed, the page
 * behaves exactly as it would with no extension at all. A silently broken ad
 * blocker that also broke playback would be far worse than no ad blocker.
 *
 * The hooks, in the order YouTube uses them:
 *
 *   1. `ytInitialPlayerResponse` -- the page's own inline player data, which is
 *      where an ad-free response can be planted before the player reads it.
 *   2. `fetch` and `XMLHttpRequest` -- the `/youtubei/v1/player` call, whose
 *      response carries `adPlacements`, `playerAds` and `adSlots`.
 *   3. A DOM fallback for anything already in flight, plus the HTML5 `<video>`
 *      element, which the player reuses to play the ad itself.
 *
 * Runs at `document_start` in the page's own world? No -- see the manifest. A
 * content script runs in an isolated world and cannot touch the page's
 * `window.fetch`. The hooks are therefore installed through `chrome.scripting`
 * from the service worker, which is the only way to reach the main world with
 * the permissions this extension already has.
 */

(() => {
  "use strict";

  if (window.__jevYoutubePatched) return;
  window.__jevYoutubePatched = true;

  const LOG = "[jev:youtube]";

  // -------------------------------------------------------------------------
  // Player response surgery
  // -------------------------------------------------------------------------

  /**
   * Strips the ad fields out of a player response.
   *
   * Mutates in place and returns the number of fields actually removed, so the
   * caller can tell "this was an ad response we cleaned" from "this response had
   * no ads to begin with".
   *
   * Deliberately conservative: only the fields that name an ad are touched.
   * Blanking anything whose purpose is unclear is how a blocker ends up
   * breaking playback, and playback matters more than the ad.
   */
  const AD_FIELDS = [
    "adPlacements", // the pre-roll / mid-roll slots themselves
    "playerAds", // the player-level ad config
    "adSlots", // older slot list
    "adParams", // targeting params handed to the ad server
    "adBreakHeartbeatParams", // lets the client report ad playback back
    "adSafetyReason", // set when YouTube decides an ad cannot be shown
  ];

  function stripAds(response) {
    if (!response || typeof response !== "object") return 0;

    let removed = 0;
    for (const field of AD_FIELDS) {
      const value = response[field];
      if (value === undefined || value === null) continue;
      // An empty array is the shape the player expects for "no ads", so use it
      // where the original was a list and delete the key otherwise.
      if (Array.isArray(value)) {
        if (value.length > 0) {
          response[field] = [];
          removed += 1;
        }
      } else if (typeof value === "object") {
        response[field] = {};
        removed += 1;
      } else {
        delete response[field];
        removed += 1;
      }
    }

    // The player refuses to start when it believes an ad is unavoidable and the
    // ad data is missing. This flag is what says "you may play without one".
    if (response.playerConfig?.adConfig) {
      delete response.playerConfig.adConfig;
      removed += 1;
    }

    return removed;
  }

  /**
   * Pulls a JSON blob out of a JavaScript source string.
   *
   * `ytInitialPlayerResponse` is assigned with a plain object literal, not
   * `JSON.parse`, so it cannot be intercepted by patching a parser -- it has to
   * be found and rewritten as text. Balanced-brace scanning is used rather than
   * a regex because the object contains nested braces and strings that contain
   * braces.
   */
  function extractObject(source, key) {
    const marker = `${key}`;
    const keyAt = source.indexOf(marker);
    if (keyAt === -1) return null;

    const braceAt = source.indexOf("{", keyAt);
    if (braceAt === -1) return null;

    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;

    for (let i = braceAt; i < source.length; i += 1) {
      const ch = source[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }

      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return { start: braceAt, end: i + 1, text: source.slice(braceAt, i + 1) };
        }
      }
    }

    return null;
  }

  function cleanInlinePlayerResponse() {
    const scripts = document.querySelectorAll("script:not([src])");
    let cleaned = 0;

    for (const script of scripts) {
      const source = script.textContent;
      if (!source || !source.includes("ytInitialPlayerResponse") || !source.includes("adPlacements")) {
        continue;
      }

      const found = extractObject(source, "ytInitialPlayerResponse");
      if (!found) continue;

      let parsed;
      try {
        parsed = JSON.parse(found.text);
      } catch {
        continue; // not the shape we expect; leave it exactly as it was
      }

      if (stripAds(parsed) === 0) continue;

      script.textContent =
        source.slice(0, found.start) + JSON.stringify(parsed) + source.slice(found.end);
      cleaned += 1;
    }

    return cleaned;
  }

  // -------------------------------------------------------------------------
  // Network hooks
  // -------------------------------------------------------------------------

  const PLAYER_PATH = "/youtubei/v1/player";

  function isPlayerUrl(url) {
    if (typeof url !== "string") return false;
    return url.includes(PLAYER_PATH);
  }

  /** Cleans a player response on its way back to the page. Never throws. */
  function cleanResponseText(text) {
    if (typeof text !== "string" || !text.includes("adPlacements")) return null;
    try {
      const parsed = JSON.parse(text);
      return stripAds(parsed) > 0 ? JSON.stringify(parsed) : null;
    } catch {
      return null; // partially-chunked body, or not JSON; leave it alone
    }
  }

  function patchFetch() {
    const original = window.fetch;
    if (typeof original !== "function") return false;

    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      const response = await original.call(this, input, init);

      if (!isPlayerUrl(url)) return response;

      try {
        const text = await response.clone().text();
        const cleaned = cleanResponseText(text);
        if (cleaned === null) return response;

        // A fresh Response is returned rather than mutating the original, which
        // is not possible for a body that has already been read.
        return new Response(cleaned, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };

    return true;
  }

  function patchXhr() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto) return false;

    const open = proto.open;
    const send = proto.send;

    proto.open = function (method, url, ...rest) {
      this.__jevUrl = url;
      return open.call(this, method, url, ...rest);
    };

    proto.send = function (...args) {
      if (isPlayerUrl(this.__jevUrl)) {
        this.addEventListener("readystatechange", function () {
          if (this.readyState !== 4) return;
          // `responseText` throws for a responseType of "arraybuffer"/"blob",
          // which the player sometimes uses. Those are left untouched.
          let text;
          try {
            text = this.responseText;
          } catch {
            return;
          }
          const cleaned = cleanResponseText(text);
          if (cleaned === null) return;

          // Override the accessor for this instance only. The player reads
          // `responseText` itself, so this is what it will see.
          Object.defineProperty(this, "responseText", {
            configurable: true,
            get: () => cleaned,
          });
          Object.defineProperty(this, "response", {
            configurable: true,
            get: () => cleaned,
          });
        });
      }
      return send.apply(this, args);
    };

    return true;
  }

  // -------------------------------------------------------------------------
  // Player element guards
  // -------------------------------------------------------------------------

  /**
   * The last line of defence: an ad that slipped through starts the shared
   * `<video>` element playing it, with `ad-showing` set on the player.
   *
   * Seeking to the end and clicking skip is what actually removes the ad. This
   * is deliberately not part of the normal path -- it is a fallback for an ad
   * already in flight -- and it never touches the element when no ad is showing.
   */
  function attachPlayerGuard() {
    let skipped = 0;

    const observer = new MutationObserver(() => {
      const player = document.querySelector(".html5-video-player.ad-showing");
      if (!player) return;

      const video = player.querySelector("video");
      if (video && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration) {
        video.currentTime = video.duration;
        skipped += 1;
      }

      const skip = player.querySelector(
        ".ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern"
      );
      if (skip) {
        skip.click();
        skipped += 1;
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // The player replaces its own nodes on navigation, so the observer is left
    // running rather than torn down.
    return () => skipped;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  const installed = {
    fetch: patchFetch(),
    xhr: patchXhr(),
  };

  const inlineCleaned = cleanInlinePlayerResponse();
  if (inlineCleaned > 0) console.info(LOG, `cleaned ${inlineCleaned} inline player response(s)`);

  attachPlayerGuard();

  // Reported to the service worker so the popup can show that the layer is
  // alive, rather than the user having to guess from YouTube's behaviour.
  window.addEventListener("load", () => {
    try {
      window.postMessage(
        {
          source: "jev-youtube",
          installed,
          inlineCleaned,
        },
        "*"
      );
    } catch {
      /* postMessage is best-effort telemetry only */
    }
  });

  console.info(LOG, "installed", installed);
})();
