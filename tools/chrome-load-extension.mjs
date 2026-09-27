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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const keepOpen = args.includes("--keep-open");
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
  console.log(`rulesets enabled : ${report.enabled.join(", ") || "(none)"}`);
  console.log(`static rules left: ${report.available}`);
  console.log("");

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
 * A real navigation, not a simulated match.
 *
 * One page load asserts two things at once:
 *   - the landing request arrives with its tracking parameters already gone
 *   - the ad request never arrives at all
 *
 * The ad host is remapped to 127.0.0.1 with --host-resolver-rules, so if the
 * block rule fails the request lands on our own server and shows up in the log
 * instead of quietly going out to the internet.
 */
async function runEndToEnd(cdp) {
  const seen = [];

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
        `<p>landing</p></body></html>`
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const landing = `http://127.0.0.1:${port}/landing?utm_source=news&gclid=abc&keep=1`;
  await cdp.send("Target.createTarget", { url: landing });

  // Give the navigation, the redirect and the image request time to settle.
  await sleep(3000);

  // close() alone waits for existing connections to finish, and Chrome holds a
  // keep-alive open indefinitely, so the process would hang forever here.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  const landingRequest = seen.find((url) => url.startsWith("/landing"));
  const pixelRequest = seen.find((url) => url.startsWith("/pixel"));

  const checks = [
    ["landing request arrived", Boolean(landingRequest)],
    ["utm_source stripped", Boolean(landingRequest) && !landingRequest.includes("utm_source")],
    ["gclid stripped", Boolean(landingRequest) && !landingRequest.includes("gclid")],
    ["other params preserved", Boolean(landingRequest) && landingRequest.includes("keep=1")],
    ["ad request never reached the server", !pixelRequest],
  ];

  let failures = 0;
  for (const [label, ok] of checks) {
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  }
  console.log(`  requested: ${seen.join("  ") || "(nothing)"}`);

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
    "--host-resolver-rules=MAP ad.doubleclick.net 127.0.0.1",
    "about:blank",
  ];
  if (!headed) chromeArgs.unshift("--headless=new");

  console.log(`chrome    : ${chromePath}`);
  console.log(`extension : ${EXTENSION_DIR}`);
  console.log(`mode      : ${headed ? "headed" : "headless"}\n`);

  const child = spawn(chromePath, chromeArgs, { stdio: "ignore" });
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
    console.log("\nRule checks (asked of Chrome, not assumed):\n");

    const rulesOk = await verifyRules(cdp, worker.targetId);

    console.log("\nEnd-to-end (real navigation against a local server):\n");
    const e2eOk = await runEndToEnd(cdp);

    const passed = rulesOk && e2eOk;
    if (!passed) process.exitCode = 1;

    console.log(
      passed
        ? "\nPASS — extension loads, rules match, and blocking works on a real page."
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
