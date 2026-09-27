import { callJev, getSettings, saveSettings } from "./shared.js";

const fields = {
  enabled: document.getElementById("enabled"),
  blockAds: document.getElementById("blockAds"),
  blockRedirects: document.getElementById("blockRedirects"),
  stripTrackingParams: document.getElementById("stripTrackingParams"),
  cosmeticSelectors: document.getElementById("cosmeticSelectors"),
  jevEnabled: document.getElementById("jevEnabled"),
  jevApiKey: document.getElementById("jevApiKey"),
  jevModel: document.getElementById("jevModel"),
  jevThreshold: document.getElementById("jevThreshold"),
  jevMaxCandidates: document.getElementById("jevMaxCandidates"),
  jevMinInterval: document.getElementById("jevMinInterval"),
};

const outs = {
  jevThreshold: document.getElementById("jevThresholdOut"),
  jevMaxCandidates: document.getElementById("jevMaxCandidatesOut"),
  jevMinInterval: document.getElementById("jevMinIntervalOut"),
};

const result = document.getElementById("result");

const CHECKBOXES = [
  "enabled",
  "blockAds",
  "blockRedirects",
  "stripTrackingParams",
  "cosmeticSelectors",
  "jevEnabled",
];

function renderOutputs() {
  outs.jevThreshold.textContent = Number(fields.jevThreshold.value).toFixed(2);
  outs.jevMaxCandidates.textContent = fields.jevMaxCandidates.value;
  outs.jevMinInterval.textContent = fields.jevMinInterval.value;
}

function say(text, isError = false) {
  result.textContent = text || "";
  result.classList.toggle("error", Boolean(isError));
}

function collect() {
  const patch = {};
  for (const key of CHECKBOXES) patch[key] = fields[key].checked;
  patch.jevApiKey = fields.jevApiKey.value.trim();
  patch.jevModel = fields.jevModel.value.trim() || "jev-latest";
  patch.jevThreshold = Number(fields.jevThreshold.value);
  patch.jevMaxCandidates = Number(fields.jevMaxCandidates.value);
  patch.jevMinIntervalMs = Number(fields.jevMinInterval.value);
  return patch;
}

async function load() {
  const settings = await getSettings();

  for (const key of CHECKBOXES) fields[key].checked = Boolean(settings[key]);
  fields.jevApiKey.value = settings.jevApiKey || "";
  fields.jevModel.value = settings.jevModel || "jev-latest";
  fields.jevThreshold.value = settings.jevThreshold;
  fields.jevMaxCandidates.value = settings.jevMaxCandidates;
  fields.jevMinInterval.value = settings.jevMinIntervalMs;

  renderOutputs();
}

for (const key of ["jevThreshold", "jevMaxCandidates", "jevMinInterval"]) {
  fields[key].addEventListener("input", renderOutputs);
}

document.getElementById("save").addEventListener("click", async () => {
  await saveSettings(collect());
  say("Saved.");
});

document.getElementById("test").addEventListener("click", async () => {
  const apiKey = fields.jevApiKey.value.trim();
  if (!apiKey) {
    say("Enter an API key first.", true);
    return;
  }

  say("Calling Jev…");
  const started = performance.now();

  try {
    const data = await callJev({
      apiKey,
      model: fields.jevModel.value.trim() || "jev-latest",
      state: "This is a connection test from the Jev Blocker browser extension.",
      questions: {
        reachable: {
          type: "noul",
          instructions: "Is this text a connection test?",
          criteria: {
            true: "It is clearly a connection test",
            false: "It is something else",
          },
        },
      },
    });

    const answer = data?.answers?.reachable;
    const ms = Math.round(performance.now() - started);
    say(
      `OK — ${data?.model || "model"} answered ${answer?.noul ?? "?"} in ${ms} ms ` +
        `(${data?.usage?.input_tokens ?? 0} input tokens).`
    );
  } catch (error) {
    say(String(error?.message || error), true);
  }
});

void load();
