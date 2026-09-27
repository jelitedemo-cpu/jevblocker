(() => {
  "use strict";

  const HIDDEN_ATTR = "data-jev-hidden";
  const STYLE_ID = "jev-blocker-style";
  const LOG = "[jev]";

  // High-precision selectors only. Anything ambiguous is left to Jev, because a
  // generic selector that hides a real page element is worse than a missed ad.
  const STATIC_SELECTORS = [
    "ins.adsbygoogle",
    "iframe[id^='google_ads_iframe']",
    "iframe[id^='aswift_']",
    "iframe[name^='google_ads_iframe']",
    "iframe[name^='aswift_']",
    "div[id^='div-gpt-ad']",
    "div[id^='google_ads_']",
    "div[data-ad-slot]",
    "div[data-ad-client]",
    "div[data-google-query-id]",
    "div[class*='advertisement']",
    "div[id*='advertisement']",
    "div[class*='adsbygoogle']",
    "[aria-label='Advertisement']",
    "[aria-label='advertisement']",
  ];

// Whole-segment matching, so "download" and "shadow" do not trip it.
const AD_HINT =
  /(^|[-_])(ad|ads|advert|advertisement|sponsor|sponsored|dfp|gpt|preroll|interstitial)([-_]|$)/i;

/**
 * Sites the cosmetic layer must not touch.
 *
 * Video sites serve their ads from the same hosts as the video itself, so a
 * domain blocklist cannot reach them -- blocking `googlevideo.com` would break
 * playback rather than remove an ad. Their ad UI also lives inside the player's
 * own DOM, where hiding an element does not skip the ad: it removes the skip
 * button, or leaves a black hole where the player controls were.
 *
 * Note that AD_HINT *does* match these internals -- `ytp-ad-skip-button`,
 * `ytp-ad-module`, `video-ads` all trip it. That is precisely why the guard
 * exists. Blocking YouTube ads needs player-level script patching, which is a
 * different technique with a permanent maintenance cost; pretending otherwise
 * is worse than declining.
 */
const PROTECTED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "netflix.com",
  "twitch.tv",
  "vimeo.com",
  "disneyplus.com",
  "primevideo.com",
  "hulu.com",
  "dailymotion.com",
];

function isProtectedHost(host = location.hostname) {
  const h = String(host || "").toLowerCase();
  return PROTECTED_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

  let settings = null;
  let passes = 0;
  let judgedSignatures = new Set();

  function safeHost(value) {
    try {
      return new URL(value, location.href).hostname || null;
    } catch {
      return null;
    }
  }

  /**
   * sendMessage throws synchronously once the extension is reloaded, which
   * happens on every reload during development. Callers only care whether an
   * answer came back, so failures collapse to null.
   */
  async function safeSend(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".jev-hidden{display:none !important;visibility:hidden !important;height:0 !important;}";
    (document.head || document.documentElement).appendChild(style);
  }

  function hide(el, reason) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.hasAttribute(HIDDEN_ATTR)) return false;
    el.setAttribute(HIDDEN_ATTR, reason);
    el.classList.add("jev-hidden");
    return true;
  }

  function applyStaticSelectors() {
    let count = 0;
    for (const selector of STATIC_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (hide(el, "static")) count += 1;
      }
    }
    return count;
  }

  /**
   * Domain-scoped cosmetic selectors from EasyList, looked up by the service
   * worker. These are written for a specific site, so unlike the generic set
   * they are unlikely to hide something legitimate.
   *
   * The generic set is not handled here: it is registered as a real stylesheet
   * by background.js, so Chrome applies it natively at document_start instead
   * of paying for 13,000 selectors over the message channel on every page.
   */
  async function applyCosmeticLists() {
    const response = await safeSend({ type: "cosmetic:get", host: location.hostname });
    const selectors = response?.selectors || [];
    if (selectors.length === 0) return 0;

    const style = document.createElement("style");
    style.id = "jev-cosmetic-lists";
    style.textContent = selectors
      .map((selector) => `${selector}{display:none !important}`)
      .join("\n");
    (document.head || document.documentElement).appendChild(style);

    // Count what actually matched, so the counter reflects reality rather than
    // the size of the ruleset.
    let matched = 0;
    for (const selector of selectors) {
      try {
        matched += document.querySelectorAll(selector).length;
      } catch {
        /* a selector the browser will not parse; it is simply inert */
      }
    }
    return matched;
  }

  function adLikeness(el, style, rect) {
    let score = 0;
    const tag = el.tagName;
    const id = el.id || "";
    const cls = typeof el.className === "string" ? el.className : "";
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;

    if (AD_HINT.test(id)) score += 3;
    if (AD_HINT.test(cls)) score += 3;
    if (/advert|sponsor|promoted/i.test(label)) score += 3;

    if (el.hasAttribute("data-ad-slot") || el.hasAttribute("data-ad-client")) score += 4;

    if (tag === "IFRAME") {
      const host = safeHost(el.src);
      if (host && host !== location.hostname) score += 2;
      if (host && AD_HINT.test(host)) score += 3;
    }

    if (tag === "INS") score += 2;

    if (style.position === "fixed" || style.position === "sticky") score += 1;
    const z = Number.parseInt(style.zIndex, 10);
    if (Number.isFinite(z) && z > 1000) score += 1;

    const text = (el.innerText || "").trim();
    if (/^(advertisement|sponsored|promoted)\b/i.test(text)) score += 3;
    if (rect.width * rect.height >= 90_000) score += 1;

    return score;
  }

  function collectCandidates(limit) {
    const found = [];
    let nodes;
    try {
      nodes = document.querySelectorAll("iframe, ins, div, section, aside, form");
    } catch {
      return found;
    }

    for (const el of nodes) {
      if (el.hasAttribute(HIDDEN_ATTR)) continue;
      if (el.parentElement && el.parentElement.closest(`[${HIDDEN_ATTR}]`)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 50) continue;
      if (rect.width * rect.height < 15_000) continue;

      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (Number.parseFloat(style.opacity) < 0.1) continue;

      const score = adLikeness(el, style, rect);
      if (score < 4) continue;

      found.push({ el, rect, style, score });
    }

    found.sort((a, b) => b.score - a.score);
    return found.slice(0, limit);
  }

  function describe(el, rect, style) {
    const data = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && Object.keys(data).length < 8) {
        data[attr.name] = String(attr.value).slice(0, 60);
      }
    }

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: typeof el.className === "string" ? el.className.slice(0, 140) : null,
      role: el.getAttribute("role"),
      aria_label: el.getAttribute("aria-label"),
      data_attributes: Object.keys(data).length ? data : null,
      width_px: Math.round(rect.width),
      height_px: Math.round(rect.height),
      position: style.position,
      z_index: style.zIndex,
      iframe_src_host: el.tagName === "IFRAME" ? safeHost(el.src) : null,
      visible_text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
      page_host: location.hostname,
    };
  }

  /**
   * One call, one question per candidate. The docs call this speculative
   * fan-out: questions are evaluated in parallel and in isolation, so adding
   * candidates costs almost no extra latency and cannot cause context rot.
   */
  function buildQuestions(candidates) {
    const questions = {};

    candidates.forEach((candidate, index) => {
      questions[`el_${index}`] = {
        type: "noul",
        instructions: {
          element: describe(candidate.el, candidate.rect, candidate.style),
          question:
            "Is `element` an advertisement, sponsored placement, or ad container on this page?",
        },
        criteria: {
          true: "Clearly an ad: an ad slot, ad iframe, sponsored unit or advert container",
          false:
            "Page content, navigation, a widget, a comment box, or a normal embedded frame",
        },
      };
    });

    return questions;
  }

  function signatureOf(candidates) {
    return candidates
      .map((c) => `${c.el.tagName}:${c.el.id}:${Math.round(c.rect.width)}x${Math.round(c.rect.height)}`)
      .join("|");
  }

  async function runJevPass({ force = false } = {}) {
    // Checked first, so an explicit "Judge this page" click on YouTube reports
    // why nothing happened instead of silently doing nothing.
    if (isProtectedHost()) {
      return { skipped: "protected-site" };
    }
    if (!settings || !settings.enabled || !settings.jevEnabled) {
      return { skipped: "disabled" };
    }
    if (!settings.jevApiKey) {
      return { skipped: "missing-api-key" };
    }

    const candidates = collectCandidates(settings.jevMaxCandidates || 8);
    if (candidates.length === 0) {
      return { candidates: 0, hidden: 0 };
    }

    const signature = signatureOf(candidates);
    if (!force && judgedSignatures.has(signature)) {
      return { skipped: "already-judged" };
    }

    const state = {
      page: {
        host: location.hostname,
        title: document.title.slice(0, 120),
        url: location.href.slice(0, 200),
      },
      note: "Each question carries its own element under `element`. Judge it on its own merits.",
    };

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "jev:judge",
        state,
        questions: buildQuestions(candidates),
      });
    } catch (error) {
      console.warn(LOG, "judge request failed", error);
      return { error: String(error?.message || error) };
    }

    if (!response || response.error || response.skipped) {
      if (response?.skipped) console.info(LOG, "skipped:", response.skipped);
      if (response?.error) console.warn(LOG, "api error:", response.error);
      return response || { error: "no response" };
    }

    judgedSignatures.add(signature);

    const threshold = Number(settings.jevThreshold) || 0.8;
    const answers = response.answers || {};
    let hidden = 0;
    const verdicts = [];

    candidates.forEach((candidate, index) => {
      const answer = answers[`el_${index}`];
      if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") return;

      verdicts.push({ index, probability: answer.noul, tag: candidate.el.tagName });

      if (answer.noul >= threshold && hide(candidate.el, `jev:${answer.noul.toFixed(2)}`)) {
        hidden += 1;
      }
    });

    if (verdicts.length) {
      console.info(LOG, "verdicts", verdicts);
    }

    if (hidden > 0) {
      await safeSend({ type: "stats:bump", patch: { hidden, jevHidden: hidden } });
    }

    return { candidates: candidates.length, hidden, verdicts };
  }

  /**
   * Two passes: one immediately, one after ads have had a chance to inject
   * themselves. Anything beyond that is left alone to keep the cost bounded.
   */
  function schedulePasses() {
    void runJevPass();

    const delay = Number(settings?.jevDelayMs) || 1500;
    if (passes >= 2) return;
    passes += 1;
    setTimeout(() => void runJevPass(), delay);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "content:judgeNow") {
      runJevPass({ force: true })
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error) }));
      return true;
    }
    return false;
  });

  async function init() {
    settings = await safeSend({ type: "settings:get" });
    if (!settings || !settings.enabled) return;

    // On video sites only the network rules apply. See PROTECTED_HOSTS.
    if (isProtectedHost()) {
      console.info(LOG, `leaving ${location.hostname} alone: player internals are not ours to hide`);
      return;
    }

    injectStyle();

    let staticHidden = 0;
    if (settings.cosmeticSelectors) {
      staticHidden = applyStaticSelectors();
      const listHidden = await applyCosmeticLists();
      const total = staticHidden + listHidden;
      if (total > 0) {
        await safeSend({ type: "stats:bump", patch: { hidden: total } });
      }
    }

    schedulePasses();
  }

  void init();
})();
