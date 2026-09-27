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
const PORT = Number(process.env.JEV_CDP_PORT || 9223);

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
  throw new Error(`Chrome did not open a debug port: ${lastError?.message || "timeout"}`);
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

  const server = createServer((req, res) => {
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
  await sleep(2500);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  let parsed = { display: null, styleInjected: false, error: null };
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const { result } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const el = document.getElementById(${JSON.stringify(marker)});
          return JSON.stringify({
            display: el ? getComputedStyle(el).display : null,
            styleInjected: Boolean(document.getElementById("jev-cosmetic-lists")),
          });
        })()`,
        returnByValue: true,
      },
      sessionId
    );
    parsed = { ...JSON.parse(result.value), error: null };
  } catch (error) {
    parsed.error = error.message;
  }

  const ok = parsed.display === "none";
  console.log(
    `  ${ok ? "ok  " : "FAIL"} site-specific rule hides ${selector} on ${domain}` +
      (ok ? "" : `   (display=${parsed.display}, style injected=${parsed.styleInjected})`)
  );
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
  // updateEnabledRulesets() call immediately. Without this settle, readings are
  // taken mid-update and rules appear to be missing when they are not.
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const enabled = await dnr.getEnabledRulesets();

  await dnr.updateEnabledRulesets({ disableRulesetIds: enabled });
  await settle();
  const allOff = await dnr.getAvailableStaticRuleCount();

  const sizes = {};
  const errors = {};
  for (const id of enabled) {
    try {
      await dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
      await settle();
      const withIt = await dnr.getAvailableStaticRuleCount();
      sizes[id] = allOff - withIt;
      await dnr.updateEnabledRulesets({ disableRulesetIds: [id] });
      await settle();
    } catch (e) {
      errors[id] = String(e && e.message || e);
    }
  }

  // Put everything back the way it was.
  await dnr.updateEnabledRulesets({ enableRulesetIds: enabled });
  await settle();
  const available = await dnr.getAvailableStaticRuleCount();

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

async function main() {
  if (!existsSync(EXTENSION_DIR)) {
    throw new Error(`extension folder not found: ${EXTENSION_DIR}`);
  }
  if (!existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`no manifest.json in ${EXTENSION_DIR}`);
  }

  const chromePath = findChrome();

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
  console.log(`mode      : ${headed ? "headed" : "headless"}\n`);

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

    console.log("\nCosmetic filtering (site-specific rules):\n");
    const domainOk = probe.domain
      ? await runCosmeticDomainCheck(cdp, probe.domain, probe.domainSelector)
      : true;

    // The generic stylesheet is registered at runtime, so let the service worker
    // finish before navigating to a page that expects it.
    await sleep(1200);

    console.log("\nEnd-to-end (real navigation against a local server):\n");
    const e2eOk = await runEndToEnd(cdp, probe);

    const passed = accountingOk && rulesOk && domainOk && e2eOk;
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
      await sleep(500);
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
