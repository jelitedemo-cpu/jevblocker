import { formatCount, getSettings, getStats, resetStats, saveSettings } from "./shared.js";

const el = {
  enabled: document.getElementById("enabled"),
  status: document.getElementById("status"),
  blocked: document.getElementById("statBlocked"),
  hidden: document.getElementById("statHidden"),
  jev: document.getElementById("statJev"),
  judge: document.getElementById("judge"),
  message: document.getElementById("message"),
  rules: document.getElementById("rules"),
  diag: document.getElementById("diag"),
  openOptions: document.getElementById("openOptions"),
  resetStats: document.getElementById("resetStats"),
};

let settings = null;

function say(text) {
  el.message.textContent = text || "";
}

/**
 * Surfaces how many static rules Chrome actually accepted. If the budget was
 * too tight for some rulesets, the extension degrades rather than fails, and
 * the user should be able to see that rather than assume full coverage.
 */
async function renderRules() {
  let report = null;
  try {
    report = await chrome.runtime.sendMessage({ type: "rules:get" });
  } catch {
    report = null;
  }

  if (!report || !report.active) {
    el.rules.textContent = "";
    return;
  }

  const formatted = report.active.toLocaleString("en-US");
  const reduced = Boolean(report.skipped?.length);
  el.rules.classList.toggle("reduced", reduced);
  el.rules.textContent = reduced
    ? `${formatted} rules active — ${report.skipped.length} ruleset(s) did not fit ` +
      `Chrome's budget and are off.`
    : `${formatted} rules active`;
}

/**
 * One line saying what Chrome has actually applied. When something on YouTube
 * misbehaves, this is the difference between "our settings are wrong" and "the
 * loaded copy is older than the settings" -- and there is no other place in the
 * UI where that is visible.
 */
async function renderDiagnostics() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "state:get" });
  } catch {
    state = null;
  }

  if (!state || state.error) {
    el.diag.textContent = "Could not read what Chrome has applied.";
    return;
  }

  const scripts = state.mainWorldScripts;
  const rules = state.allowRules;
  const consistent =
    state.youtubeMode === "allow" ? rules === 2 && scripts === 0 : rules === 0 && scripts > 0;

  el.diag.textContent =
    `Applied: YouTube ${state.youtubeMode} — ${rules} allow-rule(s), ` +
    `${scripts} page script(s)` +
    (consistent ? "" : " — not in sync; reload the extension");
}

async function render() {
  settings = await getSettings();
  const stats = await getStats();

  el.enabled.checked = Boolean(settings.enabled);
  el.blocked.textContent = formatCount(stats.blocked);
  el.hidden.textContent = formatCount(stats.hidden + stats.jevHidden);
  el.jev.textContent = formatCount(stats.jevCalls);

  const youtubeNote =
    settings.youtubeMode === "allow"
      ? " YouTube is allowlisted, so ads play there."
      : "";

  // YouTube only reaches this state by refusing to play, which the user has
  // already noticed by the time they open the popup. Say what happened and
  // where the switch is, rather than reporting "blocklists active" over a dead
  // player.
  const youtubeBlocked =
    settings.youtubeMode !== "allow" && Number(settings.youtubeDetectedAt) > 0;

  // The extension threw the switch itself after seeing the enforcement card.
  // Saying so matters: applied silently, it would look like YouTube has always
  // had ads here, and the user would never connect the two.
  const youtubeRecovered =
    settings.youtubeMode === "allow" && Boolean(settings.youtubeAutoRecovered);

  if (!settings.enabled) {
    el.status.textContent = "Protection is off.";
  } else if (youtubeRecovered) {
    el.status.textContent =
      "YouTube refused to play video, so ad blocking is off for YouTube. " +
      "Switch it back under Settings → YouTube.";
  } else if (youtubeBlocked) {
    el.status.textContent =
      "YouTube is refusing to play video because it detected ad blocking. " +
      "Set YouTube to “Allow” in Settings.";
  } else if (settings.jevEnabled && !settings.jevApiKey) {
    el.status.textContent = "Blocklists active. Add a Jev API key in Settings.";
  } else if (settings.jevEnabled) {
    el.status.textContent = `Blocklists active. Jev judging at ${settings.jevThreshold} confidence.${youtubeNote}`;
  } else {
    el.status.textContent = `Blocklists active. Jev judging is off.${youtubeNote}`;
  }

  el.judge.disabled = !settings.jevEnabled;
  await renderRules();
  await renderDiagnostics();
}

el.enabled.addEventListener("change", async () => {
  settings = await saveSettings({ enabled: el.enabled.checked });
  say("Saved.");
  await render();
});

el.openOptions.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

el.resetStats.addEventListener("click", async () => {
  await resetStats();
  say("Counters cleared.");
  await render();
});

el.judge.addEventListener("click", async () => {
  el.judge.disabled = true;
  say("Asking Jev…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");

    const response = await chrome.tabs.sendMessage(tab.id, { type: "content:judgeNow" });

    if (!response) {
      say("No response from the page.");
    } else if (response.skipped === "protected-site") {
      say(
        "This is a video site, so it is left alone. Its ads are inside the " +
          "video stream — hiding elements here would break the player and " +
          "remove the skip button, not the ad."
      );
    } else if (response.skipped === "missing-api-key") {
      say("Add your Jev API key in Settings first.");
    } else if (response.skipped === "disabled") {
      say("Jev judging is off. Enable it in Settings.");
    } else if (response.error) {
      say(`Jev error: ${response.error}`);
    } else if (response.candidates === 0) {
      say("Nothing on this page looked ad-like enough to ask about.");
    } else {
      const hidden = response.hidden ?? 0;
      say(`Judged ${response.candidates} element(s), hid ${hidden}.`);
    }
  } catch (error) {
    // Happens on chrome:// pages and the Web Store, where content scripts
    // cannot run at all.
    say("This page does not allow extensions to run.");
  } finally {
    el.judge.disabled = false;
    await render();
  }
});

void render();
