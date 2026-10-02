/**
 * YouTube supplements: the two things a scriptlet cannot do.
 *
 * Most of what used to live here -- hooking `fetch`, `XMLHttpRequest` and
 * `Response.json` to strip ad fields -- has moved to the scriptlet engine
 * (src/scriptlets.js) driven by filters/scriptlets.txt. That is the Brave-shaped
 * half: the field names are now rules in a text file, so when YouTube renames
 * one, the fix is a one-line filter edit rather than a new build.
 *
 * Two jobs genuinely do not fit a scriptlet, and both live here.
 *
 * --- 1. The inline player response -------------------------------------------
 *
 * YouTube writes `ytInitialPlayerResponse` into the page as an object literal
 * inside a `<script>` tag. `json-prune` hooks `JSON.parse`, which never sees it,
 * so the scriptlets miss this copy entirely.
 *
 * The obvious approach -- scan the inline scripts and rewrite the ad fields out
 * of the text -- does not actually work, and it is worth saying why, because it
 * looks like it should. This file runs at `document_start`, which is *before*
 * the parser has reached those script tags. There is nothing to find yet. By the
 * time there is, YouTube's own code has already read the value and scheduled the
 * ad. A pass that runs early enough finds nothing; a pass that finds something
 * runs too late. (The first version of this file made exactly that mistake.)
 *
 * The fix is to stop scanning and start intercepting. A setter is installed on
 * `window.ytInitialPlayerResponse` before any page script runs, so the page's
 * own assignment -- `var ytInitialPlayerResponse = {...}`, which routes through
 * the setter -- hands the value straight to us to clean on the way in.
 *
 * --- 2. Ads already in flight ------------------------------------------------
 *
 * Once an ad starts, the player reuses the same `<video>` element to play it.
 * Seeking to the end and clicking skip is what actually ends it. This is a
 * fallback, not the main path -- the scriptlets mean there should be nothing to
 * skip -- but an ad that slips through is exactly when a fallback earns its
 * place.
 *
 * This file must NOT patch fetch or XHR. The scriptlet engine already does, and
 * two layers wrapping the same function is how you get a response processed
 * twice, or a wrapper silently bypassed.
 */

(() => {
  "use strict";

  if (window.__jevYoutubeSupplements) return;
  window.__jevYoutubeSupplements = true;

  const LOG = "[jev:youtube]";

  /**
   * Ad fields, and why each one is listed.
   *
   * Kept in step with filters/scriptlets.txt by hand. The list is short and
   * changes rarely, and generating it would mean the compiler had to emit JS as
   * well as JSON -- more machinery than the duplication is worth.
   */
  const AD_FIELDS = [
    "adPlacements", // the pre-roll / mid-roll slots themselves
    "playerAds", // the player-level ad config
    "adSlots", // older slot list, still present on some surfaces
    "adParams", // targeting params handed to the ad server
    "adBreakHeartbeatParams", // lets the client report ad playback back
    "adSafetyReason", // set when YouTube decides an ad cannot be shown
  ];

  /**
   * Empties the ad fields in a player response, in place.
   *
   * Returns how many fields actually changed, so callers can tell "this was an
   * ad-bearing response we cleaned" from "there was nothing to do".
   *
   * Only fields that name an ad are touched. Blanking anything whose purpose is
   * unclear is how a blocker ends up breaking playback, and playback matters
   * more than the ad.
   */
  function stripAds(response) {
    if (!response || typeof response !== "object") return 0;

    let removed = 0;
    for (const field of AD_FIELDS) {
      const value = response[field];
      if (value === undefined || value === null) continue;
      // The player reads an empty list as "no ads", so keep the type where the
      // original was a list and delete the key otherwise.
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

    // The player refuses to start when it believes an ad is unavoidable but the
    // ad data is missing. Removing this config is what says "play without one".
    if (response.playerConfig?.adConfig) {
      delete response.playerConfig.adConfig;
      removed += 1;
    }

    return removed;
  }

  /**
   * Intercepts the page's own assignment of `ytInitialPlayerResponse`.
   *
   * A plain data property would be overwritten by the page's `var` statement, so
   * this is an accessor: the setter cleans the value on the way in, the getter
   * hands the player the cleaned object. Defined as early as possible -- that is
   * the entire point, since it is the only moment where this can still beat
   * YouTube's own code.
   */
  function trapInlinePlayerResponse() {
    let value;
    let cleaned = 0;

    try {
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next) => {
          try {
            if (stripAds(next) > 0) cleaned += 1;
          } catch {
            /* leave the value as the page set it */
          }
          value = next;
        },
      });
    } catch (error) {
      // Something already claimed the property. Not fatal: the scriptlets still
      // cover the fetched player response, which is the main path.
      console.warn(LOG, "could not trap ytInitialPlayerResponse", error);
      return null;
    }

    return () => cleaned;
  }

  // -------------------------------------------------------------------------
  // Ads already in flight
  // -------------------------------------------------------------------------

  /**
   * Ends an ad that is already playing.
   *
   * Only acts when `ad-showing` is set on the player, so the `<video>` element is
   * never touched during normal playback -- seeking the user's own video to the
   * end would be a far worse bug than any ad.
   */
  function attachPlayerGuard() {
    const skipSelector = [
      ".ytp-ad-skip-button",
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-modern",
    ].join(", ");

    const observer = new MutationObserver(() => {
      let player;
      try {
        player = document.querySelector(".html5-video-player.ad-showing");
      } catch {
        return;
      }
      if (!player) return;

      const skip = player.querySelector(skipSelector);
      if (skip) {
        try {
          skip.click();
        } catch {
          /* gone between the query and the click */
        }
      }

      const video = player.querySelector("video");
      if (
        video &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.currentTime < video.duration
      ) {
        try {
          video.currentTime = video.duration;
        } catch {
          /* not seekable yet */
        }
      }
    });

    // The player replaces its own nodes on navigation, so the observer is left
    // running rather than torn down and reattached.
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  const readCleanedCount = trapInlinePlayerResponse();

  // Belt and braces: if the trap could not be installed, the value is still
  // reachable once the DOM exists. This is late enough that the player may
  // already have read it, so it is a safety net rather than the mechanism.
  if (!readCleanedCount) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        try {
          if (window.ytInitialPlayerResponse) stripAds(window.ytInitialPlayerResponse);
        } catch {
          /* nothing to do */
        }
      },
      { once: true }
    );
  }

  attachPlayerGuard();
})();
