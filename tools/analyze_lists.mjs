#!/usr/bin/env node
/**
 * Reconnaissance for replacing the hand-curated 143-domain blocklist with real
 * community filter lists, the way Brave and uBlock Origin do it.
 *
 * Answers one question with numbers instead of guesswork: of the filters in
 * EasyList and EasyPrivacy, how many could actually be expressed as
 * declarativeNetRequest rules, and how many are cosmetic (CSS hiding)?
 *
 * Lists are cached under .cache/lists/ so re-runs are offline.
 *
 *   node tools/analyze_lists.mjs
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "lists");

const LISTS = [
  ["easylist", "https://easylist.to/easylist/easylist.txt"],
  ["easyprivacy", "https://easylist.to/easylist/easyprivacy.txt"],
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchCached(name, url) {
  const file = join(CACHE, `${name}.txt`);
  if (await exists(file)) {
    const cached = await readFile(file, "utf8");
    console.log(`  ${name.padEnd(12)} cached (${(cached.length / 1024).toFixed(0)} KB)`);
    return cached;
  }

  process.stdout.write(`  ${name.padEnd(12)} downloading... `);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  const text = await response.text();
  await writeFile(file, text, "utf8");
  console.log(`ok (${(text.length / 1024).toFixed(0)} KB)`);
  return text;
}

/**
 * Classify a single filter line.
 *
 * ABP syntax in the wild, roughly:
 *   ! comment  /  [Adblock Plus 2.0] header
 *   @@...                 exception
 *   ...##... / ...#@#...  cosmetic (CSS hiding)
 *   ...#?#... / ...#$#... extended cosmetic (needs a script engine)
 *   ...##+js(...)         scriptlet injection
 *   ||host^ / |http://... / /regex/   network filter
 */
function classify(line) {
  if (!line) return "blank";
  if (line.startsWith("!") || line.startsWith("[")) return "comment";
  if (line.includes("##+js(") || line.includes("#@#+js(")) return "scriptlet";
  if (line.includes("#$#") || line.includes("#@$#")) return "ext-cosmetic";
  if (line.includes("#?#") || line.includes("#@?#")) return "ext-cosmetic";
  if (line.includes("#@#")) return "cosmetic-exception";
  if (line.includes("##")) return "cosmetic";
  if (line.startsWith("@@")) return "exception";
  return "network";
}

/**
 * Can this network filter become a DNR rule?
 *
 * We only need a realistic estimate, so this accepts the shapes that map
 * cleanly and rejects the rest:
 *   ||host^        -> urlFilter, anchored
 *   ||host/path    -> urlFilter
 *   |http://...    -> urlFilter with anchors
 * Rejected: raw /regex/ (counts against a 1000-rule regex quota), filters
 * carrying options DNR has no equivalent for, and anything with a wildcard in
 * the host portion.
 */
const UNSUPPORTED_OPTIONS = [
  "csp=", "redirect=", "redirect-rule=", "inline-script", "inline-font",
  "webrtc", "genericblock", "generichide", "elemhide", "specifichide",
  "empty", "mp4", "set-cookie", "permissions=", "header=", "urltransform=",
];

function toDnrEstimate(filter) {
  const body = filter.startsWith("@@") ? filter.slice(2) : filter;
  const [pattern, optionString] = body.split("$");
  const options = (optionString || "").split(",").filter(Boolean);

  if (/^\/.*\/$/.test(pattern)) return { ok: false, why: "regex" };
  if (options.some((o) => UNSUPPORTED_OPTIONS.some((u) => o.startsWith(u)))) {
    return { ok: false, why: "unsupported-option" };
  }
  if (!pattern) return { ok: false, why: "empty" };
  // A wildcard inside the host portion has no clean urlFilter equivalent.
  if (/\*/.test(pattern.split("/")[2] || pattern)) return { ok: false, why: "host-wildcard" };

  return { ok: true };
}

await mkdir(CACHE, { recursive: true });

console.log("");
console.log("Fetching lists");
console.log("");

const totals = {};
let grand = 0;
let grandDnr = 0;

for (const [name, url] of LISTS) {
  const text = await fetchCached(name, url);

  const counts = {};
  let dnrOk = 0;
  let dnrNo = 0;
  const reasons = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const kind = classify(line);
    counts[kind] = (counts[kind] || 0) + 1;

    if (kind === "network" || kind === "exception") {
      const verdict = toDnrEstimate(line);
      if (verdict.ok) dnrOk += 1;
      else {
        dnrNo += 1;
        reasons[verdict.why] = (reasons[verdict.why] || 0) + 1;
      }
    }
  }

  totals[name] = { counts, dnrOk, dnrNo, reasons };
  grand += Object.values(counts).reduce((a, b) => a + b, 0);
  grandDnr += dnrOk;
}

console.log("");
console.log("Filter breakdown");
console.log("");

const KEYS = [
  "comment", "blank", "network", "exception",
  "cosmetic", "cosmetic-exception", "scriptlet", "ext-cosmetic",
];

for (const [name, data] of Object.entries(totals)) {
  console.log(`  ${name}`);
  for (const key of KEYS) {
    const n = data.counts[key] || 0;
    if (n) console.log(`    ${key.padEnd(20)} ${String(n).padStart(7)}`);
  }
  console.log("");
}

console.log("Network filters vs declarativeNetRequest");
console.log("");
for (const [name, data] of Object.entries(totals)) {
  const total = data.dnrOk + data.dnrNo;
  const pct = total ? ((data.dnrOk / total) * 100).toFixed(1) : "0.0";
  console.log(`  ${name}`);
  console.log(`    convertible   ${String(data.dnrOk).padStart(7)}  (${pct}%)`);
  console.log(`    not           ${String(data.dnrNo).padStart(7)}`);
  for (const [why, n] of Object.entries(data.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`        ${why.padEnd(20)} ${String(n).padStart(6)}`);
  }
  console.log("");
}

console.log("Bottom line");
console.log("");
console.log(`  total lines across both lists : ${grand}`);
console.log(`  network rules we could ship   : ${grandDnr}`);
console.log(`  Chrome static rule ceiling    : 330000`);
console.log(
  `  headroom                      : ${(((330000 - grandDnr) / 330000) * 100).toFixed(1)}% spare`
);
console.log("");
