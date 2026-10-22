#!/usr/bin/env node
/**
 * Loads the extension into Chrome and verifies it actually started.
 *
 * Chrome 137 removed the --load-extension command line flag, so the supported
 * way to load an unpacked extension programmatically is now the DevTools
 * Protocol command Extensions.loadUnpacked (Chrome 126+). This script drives
 * that, then checks the service worker registered.
 *
 *   node tools/chrome-load-extension.mjs [extensionDir] [--headed] [--keep-open]
 *
 * Uses a throwaway profile so your real Chrome profile is never touched.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const keepOpen = args.includes("--keep-open");
// Chrome reports skipped rules on stderr, but only with logging on. That is the
// only place the reason is ever stated, so it is worth being able to capture it.
const captureLog = args.includes("--capture-log");
const profileArg = args.find((a) => a.startsWith("--profile="));
const explicitProfile = profileArg
  ? profileArg.slice("--profile=".length).replace(/^"|"$/g, "")
  : null;
const target = args.find((a) => !a.startsWith("--")) || "extension";

const EXTENSION_DIR = path.resolve(target);

// A fixed port collides when runs overlap or a previous Chrome has not finished
// releasing it, which shows up as "Chrome did not open a debug port". Asking the
// OS for a free one removes that failure mode.
let PORT = Number(process.env.JEV_CDP_PORT || 0);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createProbeServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const CHROME_CANDIDATES = [
  process.env.JEV_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("chrome.exe not found. Set JEV_CHROME to its full path.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `Chrome did not open a debug port on ${port}: ${lastError?.message || "timeout"}`
  );
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP socket error")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "CDP error"));
        else resolve(message.result);
      }
    });
    return this;
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15000);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Asks Chrome itself which rules match a set of URLs. This is the only way to
 * know the rulesets are genuinely live rather than merely well-formed, and it
 * needs the declarativeNetRequestFeedback permission.
 */
const VERIFY_EXPRESSION = `(async () => {
  const cases = [
    { label: "ad host as image",        url: "https://ad.doubleclick.net/pixel.gif",            type: "image",     want: "ads" },
    { label: "ad host as script",       url: "https://pagead2.googlesyndication.com/x.js",     type: "script",    want: "ads" },
    { label: "ad host as top frame",    url: "https://ads.pubmatic.com/foo",                   type: "main_frame",want: "redirects" },
    { label: "redirector as top frame", url: "https://adf.ly/12345",                           type: "main_frame",want: "redirects" },
    { label: "tracker as xhr",          url: "https://www.google-analytics.com/collect",       type: "xmlhttprequest", want: "ads" },
    { label: "ordinary site",           url: "https://example.com/",                           type: "main_frame",want: null },
    { label: "ordinary site, subframe", url: "https://example.com/embed",                      type: "sub_frame", want: null },
    { label: "tracking params",         url: "https://example.com/p?utm_source=n&gclid=1",     type: "main_frame",want: "tracking_params" },
  ];
  const results = [];
  for (const c of cases) {
    let matched = [];
    let error = null;
    try {
      const outcome = await chrome.declarativeNetRequest.testMatchOutcome({ url: c.url, type: c.type });
      matched = (outcome.matchedRules || []).map((m) => m.rulesetId + "#" + m.ruleId);
    } catch (e) { error = String(e && e.message || e); }
    results.push({ label: c.label, want: c.want, matched, error });
  }
  let enabled = [];
  try { enabled = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) { enabled = ["error: " + e]; }
  let available = null;
  try { available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount(); } catch (e) { available = null; }
  return JSON.stringify({ enabled, available, results });
})()`;

async function verifyRules(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: VERIFY_EXPRESSION, awaitPromise: true, returnByValue: true },
    sessionId
  );

  if (result?.subtype === "error" || !result?.value) {
    console.log(`\nCould not run rule checks: ${result?.description || "no value returned"}`);
    return false;
  }

  const report = JSON.parse(result.value);

  let failures = 0;
  for (const row of report.results) {
    const hit = row.matched.length > 0;
    const wanted = row.want !== null;
    const rulesetOk = !wanted || row.matched.some((m) => m.startsWith(row.want));
    const ok = hit === wanted && rulesetOk && !row.error;

    if (!ok) failures += 1;
    const detail = row.error
      ? `error: ${row.error}`
      : hit
        ? `matched ${row.matched.join(", ")}`
        : "no match";
    console.log(`  ${ok ? "ok  " : "FAIL"} ${row.label.padEnd(22)} ${detail}`);
  }

  return failures === 0;
}

/**
 * Verifies the site-specific cosmetic path: the content script asks the service
 * worker for the selectors matching its host, and the worker walks up the
 * parent domains to find them.
 *
 * The chosen domain is remapped to 127.0.0.1 with --host-resolver-rules, so a
 * real EasyList entry can be exercised without any traffic leaving the machine.
 */
async function runCosmeticDomainCheck(cdp, domain, selector) {
  const marker = selector.slice(1);
  const seen = [];

  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>jev domain</title></head>` +
        `<body><div id="${marker}">site-specific target</div></body></html>`
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const { targetId } = await cdp.send("Target.createTarget", {
    url: `http://${domain}:${port}/page`,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const expression = `(() => {
    const el = document.getElementById(${JSON.stringify(marker)});
    return JSON.stringify({
      display: el ? getComputedStyle(el).display : null,
      styleInjected: Boolean(document.getElementById("jev-cosmetic-lists")),
      title: document.title,
    });
  })()`;

  // Poll rather than sleep. Navigation timing varies enough that a fixed wait
  // made this check fail roughly one run in three, and a flaky check is worse
  // than no check -- it trains you to ignore failures.
  let parsed = { display: null, styleInjected: false, title: null };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId
      );
      parsed = JSON.parse(result.value);
    } catch {
      /* navigation in flight; the context is replaced mid-load */
    }
    if (parsed.display === "none") break;
    await sleep(250);
  }

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  const ok = parsed.display === "none";
  console.log(
    `  ${ok ? "ok  " : "FAIL"} site-specific rule hides ${selector} on ${domain}`
  );
  if (!ok) {
    // Distinguish "the page never loaded" from "the selector did not apply".
    console.log(`        display=${parsed.display}  style injected=${parsed.styleInjected}`);
    console.log(`        page title=${JSON.stringify(parsed.title)}`);
    console.log(`        server received: ${seen.join(", ") || "(nothing)"}`);
    console.log(
      seen.length === 0
        ? "        -> the request never reached the server; the domain is being blocked"
        : "        -> the page loaded but the selector never applied"
    );
  }
  return ok;
}
/**
 * Picks selectors that are genuinely present in the generated cosmetic output,
 * so the tests cannot drift out of sync with the filter lists.
 *
 * The batching is the risky part: selectors are comma-joined 50 to a rule, so
 * one malformed selector would silently take 49 valid ones down with it.
 * Counting the parsed rules is what catches that.
 */
function cosmeticProbe() {
  const css = readFileSync(path.join(EXTENSION_DIR, "cosmetic", "generic.css"), "utf8");
  const batches = css.split("\n").filter((line) => line.includes("{display:none"));

  // One test element per batch.
  //
  // Extension-injected CSS does not appear in document.styleSheets -- Chrome
  // applies it outside the page's view -- so a dropped batch cannot be found by
  // counting parsed rules. The only reliable question is whether a selector from
  // that batch actually matched something, so every batch gets an element.
  const markers = [];
  for (const batch of batches) {
    const first = batch.split("{")[0].split(",")[0].trim();
    const idMatch = /^#([A-Za-z][\w-]*)$/.exec(first);
    const classMatch = /^\.([A-Za-z][\w-]*)$/.exec(first);
    if (idMatch) markers.push({ kind: "id", name: idMatch[1] });
    else if (classMatch) markers.push({ kind: "class", name: classMatch[1] });
  }

  // Also pick a site-specific entry: a plain domain (no wildcard) whose rules
  // include a simple #id, so a matching element can be built for it.
  const map = JSON.parse(
    readFileSync(path.join(EXTENSION_DIR, "cosmetic", "domains.json"), "utf8")
  );
  let domain = null;
  let domainSelector = null;
  for (const key of Object.keys(map).sort()) {
    if (key.includes("*")) continue;
    if (map[key].length < 5) continue;
    const simple = map[key].find((s) => /^#[A-Za-z][\w-]*$/.test(s));
    if (simple) {
      domain = key;
      domainSelector = simple;
      break;
    }
  }

  return { batchCount: batches.length, markers, domain, domainSelector };
}

/**
 * A real navigation, not a simulated match.
 *
 * One page load asserts three things at once:
 *   - the landing request arrives with its tracking parameters already gone
 *   - the ad request never arrives at all
 *   - a generic cosmetic selector from EasyList actually hides its element
 *
 * The ad host is remapped to 127.0.0.1 with --host-resolver-rules, so if the
 * block rule fails the request lands on our own server and shows up in the log
 * instead of quietly going out to the internet.
 */
async function runEndToEnd(cdp, probe) {
  const seen = [];
  const markers = probe.markers || [];
  const markerHtml = markers
    .map((m, index) =>
      m.kind === "id"
        ? `<div id="${m.name}">batch ${index}</div>`
        : `<div class="${m.name}">batch ${index}</div>`
    )
    .join("");

  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/pixel")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>jev e2e</title></head><body>` +
        `<img src="http://ad.doubleclick.net:${server.address().port}/pixel.gif" ` +
        `width="1" height="1" alt="">` +
        markerHtml +
        `<p>landing</p></body></html>`
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const landing = `http://127.0.0.1:${port}/landing?utm_source=news&gclid=abc&keep=1`;
  const { targetId } = await cdp.send("Target.createTarget", { url: landing });

  // Give the navigation, the redirect and the image request time to settle.
  await sleep(3000);

  // close() alone waits for existing connections to finish, and Chrome holds a
  // keep-alive open indefinitely, so the process would hang forever here.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  const landingRequest = seen.find((url) => url.startsWith("/landing"));
  const pixelRequest = seen.find((url) => url.startsWith("/pixel"));

  // --- cosmetic check -----------------------------------------------------
  let cosmetic = { total: markers.length, hidden: 0, visible: [], error: null };
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const { result } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const list = ${JSON.stringify(markers)};
          let hidden = 0;
          const visible = [];
          for (const m of list) {
            const el = m.kind === "id"
              ? document.getElementById(m.name)
              : document.querySelector("." + m.name);
            if (!el) { visible.push(m.name + " (missing)"); continue; }
            if (getComputedStyle(el).display === "none") hidden += 1;
            else visible.push(m.name);
          }
          return JSON.stringify({ hidden, visible: visible.slice(0, 8) });
        })()`,
        returnByValue: true,
      },
      sessionId
    );
    cosmetic = { ...cosmetic, ...JSON.parse(result.value), error: null };
  } catch (error) {
    cosmetic.error = error.message;
  }

  const cosmeticOk = !cosmetic.error && cosmetic.hidden === cosmetic.total;

  const checks = [
    ["landing request arrived", Boolean(landingRequest)],
    ["utm_source stripped", Boolean(landingRequest) && !landingRequest.includes("utm_source")],
    ["gclid stripped", Boolean(landingRequest) && !landingRequest.includes("gclid")],
    ["other params preserved", Boolean(landingRequest) && landingRequest.includes("keep=1")],
    ["ad request never reached the server", !pixelRequest],
    [
      `every cosmetic batch applied (${cosmetic.hidden}/${cosmetic.total})`,
      cosmeticOk,
    ],
  ];

  let failures = 0;
  for (const [label, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  }
  console.log(`  requested: ${seen.join("  ") || "(nothing)"}`);

  if (!cosmeticOk && !cosmetic.error) {
    console.log(
      `  ${cosmetic.visible.length} batch(es) did not apply, e.g. ${cosmetic.visible.join(", ")}`
    );
    console.log(
      "  A malformed selector takes its whole batch down. Find it with " +
        "tools/find-rejected-rules.mjs logic, or lower the batch size in compile_filters.py."
    );
  }
  if (cosmetic.error) console.log(`  cosmetic check failed to run: ${cosmetic.error}`);

  return failures === 0;
}

/**
 * Per-ruleset rule counts, read from the manifest and the files it points at.
 * The manifest is authoritative: a ruleset not listed there never loads.
 */
function expectedSizes() {
  const manifest = JSON.parse(
    readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")
  );
  const resources = manifest.declarative_net_request?.rule_resources || [];
  const out = {};
  for (const entry of resources) {
    try {
      const rules = JSON.parse(
        readFileSync(path.join(EXTENSION_DIR, entry.path), "utf8")
      );
      out[entry.id] = rules.length;
    } catch (error) {
      out[entry.id] = `unreadable: ${error.message}`;
    }
  }
  return out;
}

/**
 * Measures how many rules Chrome is actually holding for each ruleset, by
 * disabling one at a time and reading the budget delta.
 *
 * This exists because a ruleset can load, report itself enabled, and still have
 * rules dropped -- which is exactly how the 2KB regexFilter limit hid for a
 * whole release. Counting is the only way to be sure.
 */
const ACCOUNTING_EXPRESSION = `(async () => {
  const dnr = chrome.declarativeNetRequest;
  // getAvailableStaticRuleCount() does not necessarily reflect an
  // updateEnabledRulesets() call immediately. A fixed sleep is not enough: at
  // 80ms this read the *pre-disable* budget on roughly one run in four, which
  // made every subsequent delta come out negative (0, -12000, -24000, ...) and
  // reported a total of -887,412 rules. Polling until two consecutive reads
  // agree ties the measurement to the state actually being applied, instead of
  // to a guess about how long that takes.
  const pause = () => new Promise((r) => setTimeout(r, 60));
  const stable = async () => {
    let previous = await dnr.getAvailableStaticRuleCount();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await pause();
      const current = await dnr.getAvailableStaticRuleCount();
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  };

  const enabled = await dnr.getEnabledRulesets();

  await dnr.updateEnabledRulesets({ disableRulesetIds: enabled });
  const allOff = await stable();

  const sizes = {};
  const errors = {};
  for (const id of enabled) {
    try {
      await dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
      const withIt = await stable();
      sizes[id] = allOff - withIt;
      await dnr.updateEnabledRulesets({ disableRulesetIds: [id] });
      await stable();
    } catch (e) {
      errors[id] = String(e && e.message || e);
    }
  }

  // Put everything back the way it was.
  await dnr.updateEnabledRulesets({ enableRulesetIds: enabled });
  const available = await stable();

  return JSON.stringify({ enabled, sizes, errors, available, allOff });
})()`;

async function verifyAccounting(cdp, targetId, expected) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: ACCOUNTING_EXPRESSION, awaitPromise: true, returnByValue: true },
    sessionId
  );

  if (!result?.value) {
    console.log(`\nCould not measure ruleset sizes: ${result?.description || "no value"}`);
    return false;
  }

  const report = JSON.parse(result.value);

  // A ruleset cannot hold a negative number of rules. If one does, the budget
  // counter was read mid-update and the numbers below are meaningless -- say so
  // loudly rather than reporting a phantom ruleset failure.
  const bogus = report.enabled.filter(
    (id) => typeof report.sizes[id] === "number" && report.sizes[id] < 0
  );
  if (bogus.length > 0) {
    console.log(
      `\n  MEASUREMENT FAULT: ${bogus.length} ruleset(s) reported a negative size, ` +
        "which is impossible.\n  The verifier raced Chrome's budget counter; this says " +
        "nothing about the extension. Re-run.\n"
    );
    return false;
  }

  let failures = 0;
  let total = 0;

  for (const id of report.enabled) {
    const want = expected[id];
    const got = report.sizes[id];
    total += typeof got === "number" ? got : 0;

    if (report.errors[id]) {
      failures += 1;
      console.log(`  FAIL ${id.padEnd(18)} ${report.errors[id]}`);
      continue;
    }
    if (want === undefined) {
      console.log(`  ??   ${id.padEnd(18)} loaded but not declared in the manifest`);
      continue;
    }
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${id.padEnd(18)} ${String(got).padStart(7)} rules` +
        (ok ? "" : `   expected ${want}`)
    );
  }

  console.log("");
  console.log(`  total held by Chrome : ${total}`);
  console.log(`  static rules left    : ${report.available}`);

  const declared = Object.values(expected).reduce(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0
  );
  console.log(`  declared in manifest : ${declared}`);
  if (total !== declared) {
    failures += 1;
    console.log(`  MISMATCH: ${declared - total} rules did not load`);
  }

  return failures === 0;
}

/**
 * Reproduces the settings-sync race behind
 *   "Duplicate script ID 'jev-cosmetic-generic'".
 *
 * A settings change reaches the service worker from four places at once --
 * onInstalled, onStartup, storage.onChanged, and the module-level call -- so
 * several syncs overlap and every one of them reads Chrome's content-script
 * state before any of them writes it. The burst below recreates that overlap on
 * demand rather than waiting for an install to happen to hit it.
 *
 * console.error is patched for the duration because this failure is reported
 * through console.error rather than thrown.
 */
const RACE_EXPRESSION = `(async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => (a && a.message) || String(a)).join(" "));
    original.apply(console, args);
  };

  let backup = null;
  let hadSettings = false;
  try {
    const stored = await chrome.storage.local.get("settings");
    hadSettings = Object.prototype.hasOwnProperty.call(stored, "settings");
    // Restored below: this must not be destructive when run against a real
    // profile, and a partial write would otherwise drop the user's options.
    backup = hadSettings ? JSON.parse(JSON.stringify(stored.settings)) : null;

    const base = stored.settings || {};

    // Turn the stylesheet off first. The race only exists while the script is
    // absent -- every overlapping run reads "not registered" and then tries to
    // register -- so a burst against an already-registered script would pass
    // even on the broken code and prove nothing.
    await chrome.storage.local.set({
      settings: { ...base, cosmeticGeneric: false },
    });
    await new Promise((r) => setTimeout(r, 1200));

    // Six overlapping changes that all want it back on.
    errors.length = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        chrome.storage.local.set({
          settings: { ...base, cosmeticGeneric: true, jevMinIntervalMs: 1000 + i },
        })
      )
    );
    await new Promise((r) => setTimeout(r, 2500));

    if (hadSettings) await chrome.storage.local.set({ settings: backup });
    else await chrome.storage.local.remove("settings");
    await new Promise((r) => setTimeout(r, 800));
  } finally {
    console.error = original;
  }

  let registered = null;
  try {
    const found = await chrome.scripting.getRegisteredContentScripts({
      ids: ["jev-cosmetic-generic"],
    });
    registered = found.length;
  } catch (e) {
    registered = "error: " + e.message;
  }

  const duplicates = errors.filter((e) => /duplicate script id/i.test(e));
  return JSON.stringify({
    registered,
    duplicateErrors: duplicates.length,
    otherErrors: errors.length - duplicates.length,
    sample: errors.slice(0, 2),
  });
})()`;

async function verifySettingsRace(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: RACE_EXPRESSION, awaitPromise: true, returnByValue: true },
    sessionId
  );

  if (!result?.value) {
    console.log(`  FAIL could not run the race check: ${result?.description || "no value"}`);
    return false;
  }

  const report = JSON.parse(result.value);
  const noDuplicates = report.duplicateErrors === 0;
  const registeredOnce = report.registered === 1;

  console.log(
    `  ${noDuplicates ? "ok  " : "FAIL"} six overlapping settings changes raise no error` +
      (noDuplicates
        ? report.otherErrors
          ? `  (${report.otherErrors} other error(s))`
          : ""
        : `  (${report.duplicateErrors} duplicate-id error(s))`)
  );
  console.log(
    `  ${registeredOnce ? "ok  " : "FAIL"} cosmetic script registered exactly once` +
      ` (${report.registered})`
  );
  for (const line of report.sample || []) console.log(`        ${line}`);

  return noDuplicates && registeredOnce;
}

/**
 * Checks the YouTube allowlist actually does something.
 *
 * Switching the mode to "allow" is supposed to install two `allowAllRequests`
 * dynamic rules and take them away again on the way back. Both halves are
 * asserted, because the dangerous failure is the second one: leaving the rules
 * behind means blocking silently stops working on YouTube forever, with nothing
 * in the UI to show for it.
 */
const YOUTUBE_ALLOW_EXPRESSION = `(async () => {
  const dnr = chrome.declarativeNetRequest;
  const settle = () => new Promise((r) => setTimeout(r, 600));

  const stored = await chrome.storage.local.get("settings");
  const had = Object.prototype.hasOwnProperty.call(stored, "settings");
  const base = stored.settings || {};
  // Restored at the end: this must not clobber a real profile's options.
  const backup = had ? JSON.parse(JSON.stringify(stored.settings)) : null;

  const out = {};
  try {
    await chrome.storage.local.set({ settings: { ...base, youtubeMode: "allow" } });
    await settle();

    const rules = (await dnr.getDynamicRules()).filter((r) => r.id === 9001 || r.id === 9002);
    out.allowRules = rules.length;
    out.allAllowAllRequests = rules.every((r) => r.action.type === "allowAllRequests");

    const outcome = await dnr.testMatchOutcome({
      url: "https://www.youtube.com/watch?v=abc",
      type: "main_frame",
    });
    out.allowMatched = (outcome.matchedRules || []).some((m) => m.ruleId === 9001);

    await chrome.storage.local.set({ settings: { ...base, youtubeMode: "block" } });
    await settle();
    out.rulesAfterBlock = (await dnr.getDynamicRules())
      .filter((r) => r.id === 9001 || r.id === 9002).length;
  } finally {
    if (had) await chrome.storage.local.set({ settings: backup });
    else await chrome.storage.local.remove("settings");
    await settle();
  }

  return JSON.stringify(out);
})()`;

async function verifyYoutubeAllowlist(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: YOUTUBE_ALLOW_EXPRESSION, awaitPromise: true, returnByValue: true },
    sessionId
  );

  if (!result?.value) {
    console.log(`  FAIL could not run the allowlist check: ${result?.description || "no value"}`);
    return false;
  }

  const report = JSON.parse(result.value);

  const installed =
    report.allowRules === 2 && report.allAllowAllRequests && report.allowMatched;
  const removed = report.rulesAfterBlock === 0;

  console.log(
    `  ${installed ? "ok  " : "FAIL"} "allow" installs allowAllRequests rules that match YouTube` +
      (installed ? "" : `  (${report.allowRules} rule(s), matched=${report.allowMatched})`)
  );
  console.log(
    `  ${removed ? "ok  " : "FAIL"} switching back to "block" removes them` +
      (removed ? "" : `  (${report.rulesAfterBlock} left behind)`)
  );

  return installed && removed;
}

/**
 * Opens the options page and checks the controls the code looks up by id.
 *
 * `options.js` resolves every field with getElementById at load time, so a
 * renamed or mistyped id fails silently: the page renders, saving works, and
 * that one setting is simply never read or written. Nothing else in the suite
 * would notice, which is exactly why this check exists.
 */
const OPTIONS_EXPRESSION = `(() => {
  const ids = [
    "enabled", "blockAds", "blockRedirects", "stripTrackingParams",
    "cosmeticSelectors", "cosmeticGeneric", "youtubeMode",
    "jevEnabled", "jevApiKey", "jevModel",
  ];
  const missing = ids.filter((id) => !document.getElementById(id));
  const select = document.getElementById("youtubeMode");
  return JSON.stringify({
    href: location.href,
    missing,
    youtubeValue: select ? select.value : null,
    youtubeOptions: select ? [...select.options].map((o) => o.value) : [],
    hasSave: Boolean(document.getElementById("save")),
  });
})()`;

/**
 * Opens `url` in a new tab and evaluates `expression` in it once it is really
 * there. Returns null when the page never loaded.
 *
 * `createTarget` returns while the target is still on about:blank, so a report
 * is only accepted once the URL contains `hrefFragment` -- otherwise the empty
 * document is measured and every control looks missing.
 */
async function evaluateInNewPage(cdp, url, expression, hrefFragment, accept = () => true) {
  const { targetId } = await cdp.send("Target.createTarget", { url });

  let report = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !report) {
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result?.value) {
        const candidate =
          typeof result.value === "string" ? JSON.parse(result.value) : result.value;
        if (String(candidate.href || "").includes(hrefFragment) && accept(candidate)) {
          report = candidate;
        }
      } else if (process.env.JEV_DEBUG_STATE && result) {
        console.log("  debug:", JSON.stringify(result).slice(0, 300));
      }
    } catch (error) {
      if (process.env.JEV_DEBUG_STATE) console.log("  debug throw:", error.message.slice(0, 200));
      /* still navigating, or the page has not rendered yet */
    }
    if (!report) await sleep(250);
  }

  try {
    await cdp.send("Target.closeTarget", { targetId });
  } catch {
    /* already gone */
  }

  return report;
}

async function verifyOptionsPage(cdp, extensionId) {
  // Waiting for `href` alone is not enough: during navigation the URL commits
  // before the document is parsed, so a reading taken in that window sees the
  // right address and an empty body -- every control reported missing. Poll
  // until the controls are there, then take whatever is left after four
  // seconds, because a control that is genuinely gone should be reported, not
  // waited out.
  const started = Date.now();
  const report = await evaluateInNewPage(
    cdp,
    `chrome-extension://${extensionId}/src/options.html`,
    OPTIONS_EXPRESSION,
    "options.html",
    (candidate) => candidate.missing.length === 0 || Date.now() - started > 4000
  );

  if (!report) {
    console.log("  FAIL options page did not load");
    return false;
  }

  const controlsOk = report.missing.length === 0;
  const selectOk =
    report.youtubeValue === "block" || report.youtubeValue === "allow";

  console.log(
    `  ${controlsOk ? "ok  " : "FAIL"} every control the script looks up exists` +
      (controlsOk ? "" : `  (missing: ${report.missing.join(", ")})`)
  );
  console.log(
    `  ${selectOk ? "ok  " : "FAIL"} youtube mode select reads a valid value` +
      (selectOk ? ` (${report.youtubeValue})` : ` (${report.youtubeValue})`)
  );

  return controlsOk && selectOk;
}

/**
 * The popup renders its own "Applied:" line by asking the background what Chrome
 * has installed. That line is only trustworthy if the answer matches reality --
 * otherwise it sends people hunting the wrong problem -- so read the rendered
 * text and compare it with Chrome's actual state.
 *
 * The background cannot be asked directly: a service worker does not receive
 * its own `runtime.sendMessage`, so evaluating `state:get` there hangs forever.
 * Going through the popup is both the only route and the better test, because it
 * exercises the same path the user sees.
 */
/**
 * When YouTube serves the enforcement card the extension is supposed to throw
 * the switch itself rather than wait for someone to find a setting. This drives
 * that path the way the content script does -- from a page context, since a
 * service worker cannot message itself.
 *
 * The second report is the interesting one: recovery must be inert once the
 * mode is already "allow", or the tab reload it triggers would loop forever.
 */
async function evalOnTarget(cdp, targetId, expression) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  return result;
}

async function readSettings(cdp, targetId) {
  const result = await evalOnTarget(
    cdp,
    targetId,
    `(async () => JSON.stringify((await chrome.storage.local.get("settings")).settings || null))()`
  );
  return result?.value ? JSON.parse(result.value) : null;
}

async function writeSettings(cdp, targetId, value) {
  const body =
    value === null
      ? `await chrome.storage.local.remove("settings");`
      : `await chrome.storage.local.set({ settings: ${JSON.stringify(value)} });`;
  await evalOnTarget(cdp, targetId, `(async () => { ${body} })()`);
}

async function verifyYoutubeRecovery(cdp, workerTargetId, extensionId) {
  const popupUrl = `chrome-extension://${extensionId}/src/popup.html`;
  const backup = await readSettings(cdp, workerTargetId);

  try {
    await writeSettings(cdp, workerTargetId, {
      ...(backup || {}),
      enabled: true,
      youtubeMode: "block",
      youtubeDetectedAt: 0,
      youtubeAutoRecovered: false,
    });
    await sleep(1000);

    // Fire the report from a page, the way the content script does -- a service
    // worker never receives its own sendMessage. The tab is expected to navigate
    // out from under us, because that reload IS the fix working, so the result
    // is read from storage instead of from the page.
    await evaluateInNewPage(
      cdp,
      popupUrl,
      `(() => {
        void chrome.runtime.sendMessage({ type: "youtube:detected" });
        return JSON.stringify({ href: location.href, fired: true });
      })()`,
      "popup.html"
    );

    let after = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      after = await readSettings(cdp, workerTargetId);
      if (after && after.youtubeMode === "allow" && after.youtubeAutoRecovered) break;
      await sleep(250);
    }

    const recovered = Boolean(
      after &&
        after.youtubeMode === "allow" &&
        after.youtubeAutoRecovered &&
        Number(after.youtubeDetectedAt) > 0
    );
    console.log(
      `  ${recovered ? "ok  " : "FAIL"} seeing the card switches YouTube to allow by itself` +
        (recovered ? "" : `  (mode=${after?.youtubeMode}, flag=${after?.youtubeAutoRecovered})`)
    );

    // A second report must be inert. This is the difference between recovering
    // once and reloading the tab forever: the card is still on screen while the
    // page is being replaced, so a handler that always acts would loop.
    const second = await evaluateInNewPage(
      cdp,
      popupUrl,
      `(async () => {
        const reply = await chrome.runtime.sendMessage({ type: "youtube:detected" });
        return JSON.stringify({ href: location.href, ignored: Boolean(reply && reply.ignored) });
      })()`,
      "popup.html"
    );
    const idempotent = Boolean(second && second.ignored);
    console.log(
      `  ${idempotent ? "ok  " : "FAIL"} a second report is ignored, so the reload cannot loop`
    );

    return recovered && idempotent;
  } finally {
    await writeSettings(cdp, workerTargetId, backup);
    await sleep(900);
  }
}

const POPUP_EXPRESSION = `(async () => {
  const ids = [
    "enabled", "status", "statBlocked", "statHidden", "statJev",
    "judge", "message", "rules", "diag", "openOptions", "resetStats",
  ];
  const missing = ids.filter((id) => !document.getElementById(id));
  const diag = document.getElementById("diag");
  const text = diag ? diag.textContent.trim() : "";

  let truth = null;
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    truth = {
      allowRules: rules.filter((r) => r.id === 9001 || r.id === 9002).length,
      mainWorld: scripts.filter((s) => s.id.startsWith("jev-mainworld-")).length,
    };
  } catch (error) {
    truth = { error: String(error) };
  }

  const line = /^Applied: YouTube (block|allow) — (\\d+) allow-rule\\(s\\), (\\d+) page script\\(s\\)/.exec(
    text
  );
  const consistent = Boolean(
    line &&
      truth &&
      !truth.error &&
      Number(line[2]) === truth.allowRules &&
      Number(line[3]) === truth.mainWorld
  );

  return JSON.stringify({
    href: location.href,
    missing,
    diag: text,
    truth,
    consistent,
    ready: text.startsWith("Applied:"),
  });
})()`;

async function verifyPopupPage(cdp, extensionId) {
  // A reading taken while the settings sync is still running shows a mode from
  // storage next to rule counts from Chrome, which disagree for a few hundred
  // milliseconds. Prefer a reading where they agree; after four seconds take
  // whatever is there, because a lasting disagreement is the bug worth reporting
  // rather than something to wait out.
  const started = Date.now();
  const report = await evaluateInNewPage(
    cdp,
    `chrome-extension://${extensionId}/src/popup.html`,
    POPUP_EXPRESSION,
    "popup.html",
    (candidate) =>
      candidate.missing.length > 0 ||
      (candidate.ready && (candidate.consistent || Date.now() - started > 4000))
  );

  if (!report) {
    console.log("  FAIL popup did not load");
    return false;
  }

  const controlsOk = report.missing.length === 0;
  console.log(
    `  ${controlsOk ? "ok  " : "FAIL"} every control popup.js looks up exists` +
      (controlsOk ? "" : `  (missing: ${report.missing.join(", ")})`)
  );

  const appliedOk = /^Applied: YouTube (block|allow) — \d+ allow-rule\(s\), \d+ page script\(s\)$/.test(
    report.diag
  );
  console.log(
    `  ${appliedOk ? "ok  " : "FAIL"} the applied-state line reports a real mode` +
      (appliedOk ? `  (${report.diag})` : `  (got: ${report.diag || "nothing"})`)
  );

  // The line is a claim about Chrome's state. Verify the claim.
  const reported = /^Applied: YouTube (block|allow) — (\d+) allow-rule\(s\), (\d+) page script\(s\)/.exec(
    report.diag
  );
  const matches =
    reported && report.truth && !report.truth.error
      ? Number(reported[2]) === report.truth.allowRules &&
        Number(reported[3]) === report.truth.mainWorld
      : false;
  console.log(
    `  ${matches ? "ok  " : "FAIL"} the applied-state line matches Chrome` +
      (matches
        ? `  (${report.truth.allowRules} allow-rule(s), ${report.truth.mainWorld} script(s))`
        : `  (Chrome has ${report.truth?.allowRules}/${report.truth?.mainWorld})`)
  );

  return controlsOk && appliedOk && matches;
}

async function main() {
  if (!existsSync(EXTENSION_DIR)) {
    throw new Error(`extension folder not found: ${EXTENSION_DIR}`);
  }
  if (!existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`no manifest.json in ${EXTENSION_DIR}`);
  }

  const chromePath = findChrome();

  // Ask the OS for a free port unless one was pinned via JEV_CDP_PORT. A fixed
  // port collides when runs overlap or a previous Chrome has not released it,
  // which surfaced as a confusing "Chrome did not open a debug port" failure.
  if (!PORT) PORT = await freePort();

  // Read before Chrome starts, because the cosmetic probe picks a domain that
  // then has to be added to the host-resolver rules.
  const probe = cosmeticProbe();

  // An explicit profile persists between runs, so a saved API key survives.
  // Without one, a throwaway profile is used and cleaned up afterwards.
  const profileDir = explicitProfile
    ? path.resolve(explicitProfile)
    : mkdtempSync(path.join(tmpdir(), "jev-chrome-profile-"));
  const ephemeralProfile = !explicitProfile;
  if (explicitProfile) mkdirSync(profileDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--disable-background-networking",
    // Keeps the end-to-end ad request on this machine instead of the internet.
    "--host-resolver-rules=" +
      ["ad.doubleclick.net", probe.domain]
        .filter(Boolean)
        .map((host) => `MAP ${host} 127.0.0.1`)
        .join(", "),
    "about:blank",
  ];
  if (!headed) chromeArgs.unshift("--headless=new");
  if (captureLog) {
    chromeArgs.push("--enable-logging=stderr", "--v=1");
  }

  console.log(`chrome    : ${chromePath}`);
  console.log(`extension : ${EXTENSION_DIR}`);
  console.log(`mode      : ${headed ? "headed" : "headless"}`);
  console.log(`cdp port  : ${PORT}${process.env.JEV_CDP_PORT ? " (pinned)" : " (auto)"}\n`);

  const child = spawn(chromePath, chromeArgs, {
    stdio: captureLog ? ["ignore", "pipe", "pipe"] : "ignore",
  });

  const logLines = [];
  if (captureLog) {
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (/declarative_net_request|ruleset|rule with id|skipped|invalid/i.test(line)) {
          logLines.push(line.trim());
        }
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
  }
  let cdp;

  try {
    const version = await waitForEndpoint(PORT);
    console.log(`chrome version : ${version.Browser}`);

    cdp = await new Cdp(version.webSocketDebuggerUrl).connect();

    const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    console.log(`extension id   : ${loaded.id}`);

    // Give the service worker a moment to spin up, then look for it.
    let worker = null;
    for (let attempt = 0; attempt < 20 && !worker; attempt += 1) {
      await sleep(250);
      const { targetInfos } = await cdp.send("Target.getTargets");
      worker = targetInfos.find(
        (t) => t.type === "service_worker" && t.url.includes(loaded.id)
      );
    }

    if (!worker) {
      console.log("\nFAIL — extension loaded but no service worker target appeared.");
      console.log("       Check chrome://extensions for errors.");
      process.exitCode = 1;
      return;
    }

    console.log(`service worker : ${worker.url}`);

    const expected = expectedSizes();
    console.log("\nRuleset accounting (rules Chrome actually holds):\n");
    const accountingOk = await verifyAccounting(cdp, worker.targetId, expected);

    console.log("\nRule checks (asked of Chrome, not assumed):\n");
    const rulesOk = await verifyRules(cdp, worker.targetId);

    console.log("\nSettings sync (overlapping changes):\n");
    const raceOk = await verifySettingsRace(cdp, worker.targetId);

    console.log("\nYouTube allowlist:\n");
    const youtubeOk = await verifyYoutubeAllowlist(cdp, worker.targetId);

    console.log("\nYouTube recovery (the card appears):\n");
    const recoveryOk = await verifyYoutubeRecovery(cdp, worker.targetId, loaded.id);
    // The recovery check writes settings twice; let the sync chain settle so the
    // popup below is not measured mid-flight.
    await sleep(1200);

    console.log("\nOptions page:\n");
    const optionsOk = await verifyOptionsPage(cdp, loaded.id);

    console.log("\nPopup:\n");
    const popupOk = await verifyPopupPage(cdp, loaded.id);

    console.log("\nCosmetic filtering (site-specific rules):\n");
    const domainOk = probe.domain
      ? await runCosmeticDomainCheck(cdp, probe.domain, probe.domainSelector)
      : true;

    // The generic stylesheet is registered at runtime, so let the service worker
    // finish before navigating to a page that expects it.
    await sleep(1200);

    console.log("\nEnd-to-end (real navigation against a local server):\n");
    const e2eOk = await runEndToEnd(cdp, probe);

    const passed =
      accountingOk &&
      rulesOk &&
      raceOk &&
      youtubeOk &&
      recoveryOk &&
      optionsOk &&
      popupOk &&
      domainOk &&
      e2eOk;
    if (!passed) process.exitCode = 1;

    if (captureLog && logLines.length) {
      console.log("\nChrome log (rule warnings):\n");
      const unique = [...new Set(logLines)];
      for (const line of unique.slice(0, 40)) console.log(`  ${line}`);
      if (unique.length > 40) console.log(`  ... and ${unique.length - 40} more`);
    } else if (captureLog) {
      console.log("\nChrome log: no rule warnings captured.");
    }

    console.log(
      passed
        ? "\nPASS — rulesets load in full, rules match, and blocking works on a real page."
        : "\nFAIL — something above did not behave as intended."
    );
  } finally {
    cdp?.close();
    if (!keepOpen) {
      child.kill();
      // Chrome takes a moment to release its profile lock and sockets on
      // Windows; starting the next run too soon is what produced port failures.
      await sleep(900);
      if (ephemeralProfile) {
        try {
          rmSync(profileDir, { recursive: true, force: true });
        } catch {
          /* Windows may still hold a lock; harmless */
        }
      }
    } else {
      console.log(`\nChrome left running on port ${PORT}`);
      console.log(`profile: ${profileDir}`);
    }
  }
}

main().catch((error) => {
  console.error(`\nFAIL — ${error.message}`);
  process.exitCode = 1;
});
