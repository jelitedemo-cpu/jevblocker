export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const DEFAULT_SETTINGS = {
  enabled: true,
  blockAds: true,
  blockRedirects: true,
  stripTrackingParams: true,
  cosmeticSelectors: true,

  // The 13,600 generic cosmetic selectors from EasyList apply to *every* site,
  // which is what makes ads vanish and the layout reflow. It is also the only
  // part of the extension that can hide something legitimate, so it gets its
  // own switch, separate from the always-safe domain-scoped selectors.
  cosmeticGeneric: true,

  // YouTube is the one site where blocking reliably gets detected, and the
  // penalty is severe: the video does not play at all, just a "Ad blockers
  // violate YouTube's Terms of Service" card.
  //
  //   "block" -- best effort. Scriptlets strip the ad fields and the player
  //              guard ends an ad that slips through. Works until YouTube
  //              notices, then playback stops entirely.
  //   "allow" -- stop touching the site. Ads play, the video always works.
  //
  // This is not a problem that gets solved once. YouTube ships the
  // countermeasure and every blocker plays catch-up; Adblock Plus and AdBlock
  // both document "allowlist the site" as the fix, because it is the only one
  // that stays fixed.
  youtubeMode: "block",

  // Set when the enforcement screen is actually seen, so the popup can explain
  // what happened instead of leaving the user with a dead player. Cleared when
  // the mode changes.
  youtubeDetectedAt: 0,

  jevEnabled: false,
  jevApiKey: "",
  jevModel: "jev-latest",
  jevThreshold: 0.8,
  jevMaxCandidates: 8,
  jevMinIntervalMs: 2500,
  jevDelayMs: 1500,
};

const SETTINGS_KEY = "settings";
const STATS_KEY = "stats";

export const EMPTY_STATS = {
  blocked: 0,
  hidden: 0,
  jevCalls: 0,
  jevHidden: 0,
  inputTokens: 0,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getStats() {
  const stored = await chrome.storage.local.get(STATS_KEY);
  return { ...EMPTY_STATS, ...(stored[STATS_KEY] || {}) };
}

export async function setStats(stats) {
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

export async function resetStats() {
  await setStats({ ...EMPTY_STATS });
}

/**
 * Turns a TypeSafe error response into something a human can act on.
 *
 * The server reports two *different* auth failures, verified against the live
 * API, and they indict different things:
 *
 *   403 "Must supply an API key!"            -> the Authorization header was not
 *                                               understood. That is our bug.
 *   401 "Cannot authenticate with the server" -> the header was understood and
 *                                               the key inside it was rejected.
 *                                               That is the key's problem.
 */
function describeJevError(status, rawBody) {
  let message = "";
  let errorType = "";

  try {
    const parsed = JSON.parse(rawBody);
    message = parsed?.detail?.message || "";
    errorType = parsed?.detail?.error_type || "";
  } catch {
    message = String(rawBody || "").slice(0, 200);
  }

  switch (status) {
    case 401:
      return (
        `Key rejected (401). ${message || "The server did not accept this API key."} ` +
        "Jev is in early access, so a key that exists in the console but has not " +
        "been activated yet fails exactly like this."
      );
    case 403:
      return (
        `No API key recognised (403). ${message} ` +
        "This is a bug in the extension, not a problem with your key."
      );
    case 422:
      return `Jev rejected the request as malformed (422). ${message}`;
    case 429:
      return "Rate limited by Jev (429). Wait a moment and try again.";
    case 529:
      return "Jev is overloaded (529). Try again shortly.";
    default:
      const tail = message || errorType;
      return `Jev API ${status}${tail ? ` — ${tail}` : ""}`;
  }
}

/**
 * Calls the TypeSafe evaluation endpoint.
 *
 * This runs only in the service worker. The API key is never handed to a
 * content script, so a hostile page cannot read it out of the DOM.
 */
export async function callJev({ apiKey, model, state, questions }) {
  const response = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: model || DEFAULT_SETTINGS.jevModel,
      questions,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* body already consumed or unreadable */
    }
    throw new Error(describeJevError(response.status, detail));
  }

  return response.json();
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
