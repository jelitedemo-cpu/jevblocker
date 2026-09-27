import {
  callJev,
  getSettings,
  getStats,
  setStats,
  EMPTY_STATS,
} from "./shared.js";

const BADGE_FLUSH_MS = 1500;

const pending = { ...EMPTY_STATS };
let flushTimer = null;
let lastJevAt = 0;

function queueStat(patch) {
  for (const [key, value] of Object.entries(patch)) {
    pending[key] = (pending[key] || 0) + value;
  }
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushStats();
  }, BADGE_FLUSH_MS);
}

async function flushStats() {
  const patch = { ...pending };
  for (const key of Object.keys(pending)) pending[key] = 0;

  const stats = await getStats();
  const next = { ...stats };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = (next[key] || 0) + value;
  }
  await setStats(next);
  await updateBadge(next);
}

async function updateBadge(stats) {
  const current = stats || (await getStats());
  const total = current.blocked + current.hidden + current.jevHidden;
  await chrome.action.setBadgeText({ text: total > 0 ? String(Math.min(total, 9999)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#0F6E56" });
}

/**
 * Static rulesets ship enabled in the manifest, so anything the user turns off
 * has to be explicitly disabled here.
 */
async function applyRulesets(settings) {
  const enable = [];
  const disable = [];

  const wanted = [
    ["ads", settings.enabled && settings.blockAds],
    ["redirects", settings.enabled && settings.blockRedirects],
    ["tracking_params", settings.enabled && settings.stripTrackingParams],
  ];

  for (const [id, on] of wanted) {
    (on ? enable : disable).push(id);
  }

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
  } catch (error) {
    console.error("[jev] could not update rulesets", error);
  }
}

async function syncFromSettings() {
  const settings = await getSettings();
  await applyRulesets(settings);
  await updateBadge();
}

async function handleJudge({ state, questions }) {
  const settings = await getSettings();

  if (!settings.enabled) return { skipped: "extension-disabled" };
  if (!settings.jevEnabled) return { skipped: "jev-disabled" };
  if (!settings.jevApiKey) return { skipped: "missing-api-key" };

  const now = Date.now();
  const wait = settings.jevMinIntervalMs - (now - lastJevAt);
  if (wait > 0) return { skipped: "rate-limited", retryInMs: wait };

  // Claim the slot before awaiting so two tabs cannot race through together.
  lastJevAt = now;

  try {
    const data = await callJev({
      apiKey: settings.jevApiKey,
      model: settings.jevModel,
      state,
      questions,
    });

    queueStat({ jevCalls: 1, inputTokens: data?.usage?.input_tokens || 0 });
    return { answers: data?.answers || {}, model: data?.model };
  } catch (error) {
    // Release the slot so a transient failure does not block the next page.
    lastJevAt = 0;
    return { error: String(error?.message || error) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncFromSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void syncFromSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    void syncFromSettings();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  switch (message.type) {
    case "jev:judge":
      handleJudge(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error) }));
      return true;

    case "stats:bump":
      queueStat(message.patch || {});
      sendResponse({ ok: true });
      return false;

    case "stats:get":
      getStats()
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error) }));
      return true;

    case "settings:get":
      getSettings()
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error) }));
      return true;

    case "settings:set":
      chrome.storage.local
        .set({ settings: message.settings })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: String(error) }));
      return true;

    default:
      return false;
  }
});

// Only available for unpacked extensions, which is exactly the testing case.
// Counts are best-effort: packed builds simply show zero here.
if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(() => {
    queueStat({ blocked: 1 });
  });
}

void syncFromSettings();
