import {
  callJev,
  getSettings,
  getStats,
  setStats,
  EMPTY_STATS,
} from "./shared.js";
import { RULESET_SIZES } from "./ruleset-sizes.js";

const BADGE_FLUSH_MS = 1500;

// The compiled EasyList/EasyPrivacy rulesets, in load order. Chrome guarantees
// only 30,000 static rules across all installed extensions -- the 330,000 this
// machine grants is not contractual -- so these are enabled greedily within
// whatever budget is actually available rather than all-or-nothing.
const FILTER_RULESETS = Object.keys(RULESET_SIZES);
const COSMETIC_SCRIPT_ID = "jev-cosmetic-generic";

// Every main-world registration is named `jev-mainworld-*`, so they can be
// diffed and cleaned up as one family. Which groups exist, and which hosts each
// covers, comes from filters/scriptlets.txt via tools/compile_scriptlets.py --
// not from this file. That indirection is the point: adding or fixing a rule is
// a filter-list edit, not a code change.
const MAIN_WORLD_PREFIX = "jev-mainworld-";

// The supplements script covers the two jobs a scriptlet cannot: rewriting the
// inline player response, and ending an ad already in flight. See src/youtube.js.
const YOUTUBE_SUPPLEMENT_ID = `${MAIN_WORLD_PREFIX}youtube-supplement`;
const YOUTUBE_SUPPLEMENT_MATCHES = [
  "*://youtube.com/*",
  "*://*.youtube.com/*",
  "*://youtube-nocookie.com/*",
  "*://*.youtube-nocookie.com/*",
];

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
 * Rulesets the user's settings ask for, in priority order. Earlier entries win
 * when the static-rule budget runs short, so the curated rulesets that cover
 * the worst offenders come before the long tail of the filter lists.
 */
function desiredRulesets(settings) {
  if (!settings.enabled) return [];
  const ids = [];
  // The curated ruleset goes first: ~143 rules covering the worst offenders, so
  // it survives a tight budget that the 115,000-rule filter lists may not.
  if (settings.blockAds) ids.push("ads", ...FILTER_RULESETS);
  if (settings.stripTrackingParams) ids.push("tracking_params");
  if (settings.blockRedirects) ids.push("redirects");
  return ids;
}

let lastRuleReport = { active: 0, skipped: [] };

/**
 * Static rulesets ship enabled in the manifest, so anything the user turns off
 * has to be explicitly disabled here.
 *
 * The budget check exists because exceeding it is not graceful: enabling a
 * ruleset that does not fit fails the whole call. Fitting them explicitly means
 * the extension degrades to fewer rules instead of to no protection.
 */
async function applyRulesets(settings) {
  const desired = desiredRulesets(settings);
  const desiredSet = new Set(desired);

  let enabledNow;
  try {
    enabledNow = await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch (error) {
    console.error("[jev] could not read enabled rulesets", error);
    return;
  }

  const toDisable = enabledNow.filter((id) => !desiredSet.has(id));
  const toEnable = desired.filter((id) => !enabledNow.includes(id));

  // getAvailableStaticRuleCount() reports the budget left given what is
  // *currently* enabled, so rules we are about to release have to be added back.
  let budget = 0;
  try {
    budget = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
  } catch (error) {
    console.error("[jev] could not read the static rule budget", error);
  }
  for (const id of toDisable) budget += RULESET_SIZES[id] || 0;

  const affordable = [];
  const skipped = [];
  for (const id of toEnable) {
    const size = RULESET_SIZES[id] || 0;
    if (size <= budget) {
      affordable.push(id);
      budget -= size;
    } else {
      skipped.push({ id, size, budget });
    }
  }

  for (const entry of skipped) {
    console.warn(
      `[jev] not enabling ${entry.id}: needs ${entry.size} static rules, ` +
        `${entry.budget} available. Protection is reduced but still active.`
    );
  }

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: affordable,
      disableRulesetIds: toDisable,
    });
  } catch (error) {
    console.error("[jev] could not update rulesets", error);
    return;
  }

  const activeIds = [...enabledNow.filter((id) => desiredSet.has(id)), ...affordable];
  lastRuleReport = {
    active: activeIds.reduce((sum, id) => sum + (RULESET_SIZES[id] || 0), 0),
    skipped: skipped.map((entry) => entry.id),
  };
}

/**
 * The generic cosmetic stylesheet is registered at runtime rather than declared
 * in the manifest so it can be switched off. It applies to every site, so it is
 * the one component a user is likely to want to disable.
 */
const COSMETIC_SCRIPT_DEFINITION = {
  id: COSMETIC_SCRIPT_ID,
  matches: ["http://*/*", "https://*/*"],
  css: ["cosmetic/generic.css"],
  runAt: "document_start",
  allFrames: false,
};

/** Chrome raises this when a registration with the same id already exists. */
function isDuplicateScriptId(error) {
  return /duplicate script id/i.test(String(error?.message || error));
}

async function applyCosmeticScript(settings) {
  const wanted = Boolean(
    settings.enabled && settings.cosmeticSelectors && settings.cosmeticGeneric
  );

  let isOn = false;
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: [COSMETIC_SCRIPT_ID],
    });
    isOn = registered.length > 0;
  } catch (error) {
    console.error("[jev] could not read registered scripts", error);
    return;
  }

  if (wanted === isOn) return;

  try {
    if (wanted) {
      await chrome.scripting.registerContentScripts([COSMETIC_SCRIPT_DEFINITION]);
    } else {
      await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_SCRIPT_ID] });
    }
  } catch (error) {
    // A registration outlives the service worker, and the read above is not
    // guaranteed to have seen one made moments ago. "Duplicate script ID" then
    // means the state we wanted is already in place -- not a failure.
    if (isDuplicateScriptId(error)) return;
    console.error("[jev] could not update the cosmetic stylesheet", error);
  }
}

// ---------------------------------------------------------------- scriptlets

let scriptletGroups = null;

/**
 * The compiled scriptlet groups, read once and kept in memory.
 *
 * Small (a few hundred bytes today), so unlike cosmetic/domains.json there is
 * no cost to holding it.
 */
async function loadScriptletGroups() {
  if (scriptletGroups) return scriptletGroups;
  try {
    const response = await fetch(chrome.runtime.getURL("scriptlets/config.json"));
    const data = await response.json();
    scriptletGroups = Array.isArray(data?.groups) ? data.groups : [];
  } catch (error) {
    console.error("[jev] could not read the scriptlet config", error);
    scriptletGroups = [];
  }
  return scriptletGroups;
}

/**
 * Registers the main-world scripts: one content script per scriptlet group,
 * plus the YouTube supplements.
 *
 * `world: "MAIN"` is load-bearing and cannot be declared in the manifest. A
 * scriptlet has to replace the page's own `window.fetch` and `JSON.parse`; in
 * Chrome's default isolated world it would get its own copies and patch
 * something nothing calls -- which looks like it works and does nothing.
 *
 * `runAt: "document_start"` matters just as much. The page's inline
 * `ytInitialPlayerResponse` and its first player request both land within the
 * first few milliseconds, so a hook installed at document_idle misses the only
 * response there is to clean.
 *
 * A group's config file is listed before the engine so `window.__jevScriptlets`
 * is set by the time the engine reads it; `files` run in order.
 */
async function applyMainWorldScripts(settings) {
  const on = Boolean(settings.enabled && settings.blockYoutubeAds);

  const wanted = [];
  if (on) {
    const groups = await loadScriptletGroups();
    for (const group of groups) {
      wanted.push({
        id: MAIN_WORLD_PREFIX + group.id,
        matches: group.matches,
        js: [group.file, "src/scriptlets.js"],
      });
    }
    wanted.push({
      id: YOUTUBE_SUPPLEMENT_ID,
      matches: YOUTUBE_SUPPLEMENT_MATCHES,
      js: ["src/youtube.js"],
    });
  }

  const wantedIds = new Set(wanted.map((entry) => entry.id));

  let registered;
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch (error) {
    console.error("[jev] could not read registered scripts", error);
    return;
  }

  const currentIds = registered
    .map((script) => script.id)
    .filter((id) => id.startsWith(MAIN_WORLD_PREFIX));

  const toRemove = currentIds.filter((id) => !wantedIds.has(id));
  const toAdd = wanted.filter((entry) => !currentIds.includes(entry.id));

  if (toRemove.length === 0 && toAdd.length === 0) return;

  try {
    if (toRemove.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    }
    if (toAdd.length > 0) {
      await chrome.scripting.registerContentScripts(
        toAdd.map((entry) => ({
          id: entry.id,
          matches: entry.matches,
          js: entry.js,
          runAt: "document_start",
          world: "MAIN",
          allFrames: false,
        }))
      );
    }
  } catch (error) {
    // A registration outlives the service worker, so a read taken moments ago
    // may not have seen one just made. That is the state we wanted anyway.
    if (isDuplicateScriptId(error)) return;
    console.error("[jev] could not update the main-world registrations", error);
  }
}

// ---------------------------------------------------------------- cosmetic lookup

let cosmeticDomains = null;

/**
 * domains.json is 500 KB, so it is read once and kept in memory rather than
 * shipped to every content script on every page.
 */
async function loadCosmeticDomains() {
  if (cosmeticDomains) return cosmeticDomains;
  try {
    const response = await fetch(chrome.runtime.getURL("cosmetic/domains.json"));
    cosmeticDomains = await response.json();
  } catch (error) {
    console.error("[jev] could not load the cosmetic domain map", error);
    cosmeticDomains = {};
  }
  return cosmeticDomains;
}

/**
 * Collects selectors for the host and each of its parent domains, so
 * `news.bbc.co.uk` picks up rules written for `bbc.co.uk`. Stops before the
 * bare public suffix, which would match far too much.
 *
 * Also checks the `*.name` form, which is how EasyList's `name.*` entries are
 * stored -- those mean "this name under any TLD" and would otherwise never
 * match, since a real hostname never contains a literal asterisk.
 */
function selectorsForHost(map, host) {
  const parts = String(host || "").toLowerCase().split(".");
  const out = [];

  for (let i = 0; i < parts.length - 1; i += 1) {
    const found = map[parts.slice(i).join(".")];
    if (found) out.push(...found);

    const wildcard = map["*." + parts.slice(i, parts.length - 1).join(".")];
    if (wildcard) out.push(...wildcard);
  }

  return [...new Set(out)];
}

async function handleCosmeticGet({ host }) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.cosmeticSelectors) return { selectors: [] };
  const map = await loadCosmeticDomains();
  return { selectors: selectorsForHost(map, host) };
}

// A settings change reaches us from four places at once -- onInstalled,
// onStartup, storage.onChanged (which onInstalled itself triggers by writing
// the defaults) and the module-level call at the bottom of this file. Each one
// ends in read-then-writing Chrome's ruleset and content-script state, so
// overlapping runs all read "not registered yet" and all try to register; every
// run after the first then throws "Duplicate script ID". Chaining the runs
// means each read sees the previous write.
let syncChain = Promise.resolve();
let syncQueued = false;

function syncFromSettings() {
  // Collapse a burst of requests into one pending run. A request that arrives
  // while a run is in flight still queues another, so the newest settings are
  // always the ones left applied.
  if (syncQueued) return syncChain;
  syncQueued = true;

  const run = async () => {
    syncQueued = false;
    const settings = await getSettings();
    await applyRulesets(settings);
    await applyCosmeticScript(settings);
    await applyMainWorldScripts(settings);
    await updateBadge();
  };

  syncChain = syncChain.then(run, run).catch((error) => {
    // Keep the chain alive: one failure must not wedge every later sync.
    console.error("[jev] settings sync failed", error);
  });
  return syncChain;
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

    case "cosmetic:get":
      handleCosmeticGet(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ selectors: [], error: String(error) }));
      return true;

    case "rules:get":
      sendResponse(lastRuleReport);
      return false;

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
