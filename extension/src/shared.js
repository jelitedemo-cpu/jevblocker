export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const DEFAULT_SETTINGS = {
  enabled: true,
  blockAds: true,
  blockRedirects: true,
  stripTrackingParams: true,
  cosmeticSelectors: true,

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
    throw new Error(`Jev API ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  return response.json();
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
