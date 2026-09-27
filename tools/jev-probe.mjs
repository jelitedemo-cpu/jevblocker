#!/usr/bin/env node
/**
 * Live probe for the TypeSafe / Jev endpoint.
 *
 * Purpose: verify the exact request the Chrome extension sends actually works
 * against the real API, and that the response shape is what content.js expects.
 * The extension's Jev path is otherwise unexercised, and a schema mismatch
 * there fails *silently* -- the extension would simply hide nothing.
 *
 * The key is read from ./.jev-key (gitignored) and never printed.
 *
 *   node tools/jev-probe.mjs            # full probe
 *   node tools/jev-probe.mjs --raw      # also dump the raw response body
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// Primary file is the visible one; the dotfile is kept as a fallback.
const KEY_FILES = [join(ROOT, "jev-api-key.txt"), join(ROOT, ".jev-key")];
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const RAW = process.argv.includes("--raw");

// ---------------------------------------------------------------- key loading

/**
 * Reads the first non-comment, non-blank line of the key file. Comment lines
 * start with "#", which lets the file carry its own usage header.
 */
async function loadKey() {
  let raw = null;
  let used = null;

  for (const candidate of KEY_FILES) {
    try {
      raw = await readFile(candidate, "utf8");
      used = candidate;
      break;
    } catch {
      /* try the next candidate */
    }
  }

  if (raw === null) {
    fail(
      `No key file found. Looked for:\n\n` +
        KEY_FILES.map((p) => `    ${p}`).join("\n") +
        `\n\nCreate jev-api-key.txt in the project root and paste your key into it.`
    );
  }

  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));

  if (!line) {
    fail(
      `No key found in ${used}\n\n` +
        `The file exists but every line is blank or starts with "#".\n` +
        `Add your key on its own line at the bottom, then save.`
    );
  }

  const key = line.replace(/^["']|["']$/g, "").trim();
  if (!key) fail(`Key line in ${used} is empty.`);

  // Fingerprint lets us confirm which key loaded without leaking it.
  const fp = `${key.slice(0, 4)}...${key.slice(-2)} (${key.length} chars)`;
  return { key, fp, file: used };
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------- request bodies

/**
 * Mirrors describe() in extension/src/content.js. Two elements: one that is
 * unambiguously an ad, one that is unambiguously page content. A working model
 * should separate them.
 */
const STATE = {
  page: {
    host: "news.example.com",
    title: "City council approves transit plan",
    url: "https://news.example.com/2026/09/transit-plan",
  },
  note: "Each question carries its own element under `element`. Judge it on its own merits.",
};

const QUESTIONS = {
  el_0: {
    type: "noul",
    instructions: {
      element: {
        tag: "ins",
        id: "aswift_2",
        classes: "adsbygoogle",
        role: null,
        aria_label: "Advertisement",
        data_attributes: { "data-ad-slot": "7788990011", "data-ad-client": "ca-pub-1234" },
        width_px: 300,
        height_px: 250,
        position: "static",
        z_index: "auto",
        iframe_src_host: null,
        visible_text: "",
        page_host: "news.example.com",
      },
      question:
        "Is `element` an advertisement, sponsored placement, or ad container on this page?",
    },
    criteria: {
      true: "Clearly an ad: an ad slot, ad iframe, sponsored unit or advert container",
      false:
        "Page content, navigation, a widget, a comment box, or a normal embedded frame",
    },
  },
  el_1: {
    type: "noul",
    instructions: {
      element: {
        tag: "div",
        id: "article-body",
        classes: "prose article-content",
        role: "article",
        aria_label: null,
        data_attributes: null,
        width_px: 720,
        height_px: 1840,
        position: "static",
        z_index: "auto",
        iframe_src_host: null,
        visible_text:
          "The council voted 7-2 on Tuesday to fund the long-delayed east-side transit line.",
        page_host: "news.example.com",
      },
      question:
        "Is `element` an advertisement, sponsored placement, or ad container on this page?",
    },
    criteria: {
      true: "Clearly an ad: an ad slot, ad iframe, sponsored unit or advert container",
      false:
        "Page content, navigation, a widget, a comment box, or a normal embedded frame",
    },
  },
};

// --------------------------------------------------------------------- calling

async function call(key, questions) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: STATE, model: MODEL, questions }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    fail(
      `Request never completed: ${error?.message || error}\n\n` +
        `This is a network-layer failure, not an API rejection. Check connectivity.`
    );
  }

  const ms = Date.now() - started;
  const text = await response.text();

  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    parseError = error;
  }

  return { status: response.status, ok: response.ok, ms, text, json, parseError };
}

/**
 * The server uses two distinct auth failures, and they point at different
 * causes. Measured against the live API:
 *
 *   403 "Must supply an API key!"        -> the header itself was not understood
 *                                           (missing, wrong name, no "Bearer ")
 *   401 "Cannot authenticate with the server" -> the header was understood and
 *                                           the key inside it was rejected
 *
 * A 403 therefore means *our* code is wrong; a 401 means the key is wrong.
 */
function explain(status) {
  switch (status) {
    case 200:
      return null;
    case 401:
      return (
        "The key was found in the request and rejected. The request format is " +
        "correct -- this is the key value itself.\n\n" +
        "  Usual causes:\n" +
        "    - key truncated or mistyped when copied from the console\n" +
        "    - key revoked or rotated\n" +
        "    - account still on the Jev early-access waitlist, so the key is not live yet\n\n" +
        "  Check it at https://console.typesafe.ai (Keys page) and re-copy the whole value."
      );
    case 403:
      return (
        "No API key was recognised in the request. This is a bug in the request, " +
        "not in the key.\n\n" +
        "  Expected exactly:  Authorization: Bearer <API_KEY>\n" +
        "  A bare key, an x-api-key header, or a missing header all produce this."
      );
    case 404:
      return "Endpoint or model not found. Check the path and the model name.";
    case 422:
    case 400:
      return (
        "Request rejected as malformed. The schema in this probe does not match " +
        "the API. The response body names the offending field."
      );
    case 429:
      return "Rate limited. Back off and retry.";
    case 529:
      return "TypeSafe is overloaded. Retry after a short delay.";
    default:
      return status >= 500 ? "Server-side error at TypeSafe." : "Unexpected status.";
  }
}

// --------------------------------------------------------------- shape checks

/**
 * content.js does:
 *   const answer = answers[`el_${index}`];
 *   if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") return;
 *
 * If any of these assumptions are wrong, the extension silently hides nothing.
 * This is the single most valuable thing the probe can tell us.
 */
function checkShape(json) {
  const notes = [];

  if (!json || typeof json !== "object") {
    notes.push({ ok: false, text: "Response is not a JSON object." });
    return notes;
  }

  const answers = json.answers;
  if (!answers || typeof answers !== "object") {
    const keys = Object.keys(json);
    notes.push({
      ok: false,
      text: `No \`answers\` object at the top level. Keys present: ${keys.join(", ") || "(none)"}`,
    });
    return notes;
  }
  notes.push({ ok: true, text: "`answers` object present." });

  for (const id of Object.keys(QUESTIONS)) {
    const answer = answers[id];
    if (!answer) {
      notes.push({ ok: false, text: `\`answers.${id}\` missing.` });
      continue;
    }
    if (answer.type !== "noul") {
      notes.push({
        ok: false,
        text: `\`answers.${id}.type\` is ${JSON.stringify(answer.type)}, expected "noul".`,
      });
      continue;
    }
    if (typeof answer.noul !== "number") {
      notes.push({
        ok: false,
        text: `\`answers.${id}.noul\` is ${JSON.stringify(answer.noul)}, expected a number.`,
      });
      continue;
    }
    notes.push({ ok: true, text: `\`answers.${id}\` -> noul ${answer.noul}` });
  }

  return notes;
}

// ------------------------------------------------------------------------ run

const { key, fp, file } = await loadKey();

console.log("");
console.log(`  endpoint : ${ENDPOINT}`);
console.log(`  model    : ${MODEL}`);
console.log(`  key      : ${fp}`);
console.log(`  read from: ${file.replace(ROOT, ".")}`);
console.log(`  questions: ${Object.keys(QUESTIONS).length}`);
console.log("");

const result = await call(key, QUESTIONS);

console.log(`  status   : ${result.status}  (${result.ms} ms)`);
console.log("");

const problem = explain(result.status);
if (problem) {
  console.log(`  FAIL  ${problem}`);
  if (result.text) {
    console.log("");
    console.log("  Response body:");
    console.log(
      result.text
        .slice(0, 1200)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")
    );
  }
  console.log("");
  process.exit(1);
}

if (result.parseError) {
  console.log(`  FAIL  Status 200 but the body is not JSON (${result.parseError.message}).`);
  console.log("");
  console.log(`    ${result.text.slice(0, 600)}`);
  console.log("");
  process.exit(1);
}

console.log("  PASS  API accepted the request.");
console.log("");
console.log("  Response shape (what content.js depends on):");
for (const note of checkShape(result.json)) {
  console.log(`    ${note.ok ? "ok  " : "FAIL"} ${note.text}`);
}

if (result.json?.usage) {
  console.log("");
  console.log(
    `  usage    : ${result.json.usage.input_tokens} in / ${result.json.usage.output_tokens} out` +
      `  (served by ${result.json.model})`
  );
}

// The model is only useful here if it separates an obvious ad from obvious page
// content. Two mid-range numbers would mean the criteria need sharpening.
const adScore = result.json?.answers?.el_0?.noul;
const contentScore = result.json?.answers?.el_1?.noul;
if (typeof adScore === "number" && typeof contentScore === "number") {
  const separation = adScore - contentScore;
  console.log("");
  console.log(`  el_0 (obvious ad)     : ${adScore}`);
  console.log(`  el_1 (article body)   : ${contentScore}`);
  console.log(
    `  separation            : ${separation.toFixed(3)}  ` +
      (separation > 0.4
        ? "-> discriminates correctly"
        : "-> too close, the criteria need sharpening")
  );
}

if (RAW) {
  console.log("");
  console.log("  Raw response:");
  console.log(
    JSON.stringify(result.json, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")
  );
}

console.log("");
