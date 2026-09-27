#!/usr/bin/env node
/**
 * Asks Chrome whether it actually supports each regexFilter we emit.
 *
 * chrome.declarativeNetRequest.isRegexSupported() reports both whether a regex
 * is usable and, when it is not, the reason. That is the only way to find out:
 * an unsupported regex does not fail the ruleset, it just quietly removes one
 * rule from it.
 *
 *   node tools/check-regexes.mjs
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const RULES_DIR = path.join(ROOT, "extension", "rules");
const PORT = Number(process.env.JEV_CDP_PORT || 9237);

const CHROME_CANDIDATES = [
  process.env.JEV_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("chrome.exe not found");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not open a debug port");
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
      }, 30000);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* gone */
    }
  }
}

// Collect every regexFilter in every generated ruleset.
const found = [];
for (const file of readdirSync(RULES_DIR).filter((f) => f.endsWith(".json")).sort()) {
  let rules;
  try {
    rules = JSON.parse(readFileSync(path.join(RULES_DIR, file), "utf8"));
  } catch {
    continue;
  }
  for (const rule of rules) {
    if (rule?.condition?.regexFilter) {
      found.push({ ruleset: file.replace(".json", ""), id: rule.id, regex: rule.condition.regexFilter });
    }
  }
}

console.log(`\nregexFilters found: ${found.length}\n`);
if (found.length === 0) process.exit(0);

const dir = mkdtempSync(path.join(tmpdir(), "jev-regex-probe-"));
const profile = mkdtempSync(path.join(tmpdir(), "jev-regex-profile-"));
writeFileSync(
  path.join(dir, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "jev regex probe",
    version: "1.0.0",
    permissions: ["declarativeNetRequest"],
    background: { service_worker: "sw.js" },
  }),
  "utf8"
);
writeFileSync(path.join(dir, "sw.js"), "void 0;\n", "utf8");

const expression = `(async () => {
  const list = ${JSON.stringify(found.map((f) => f.regex))};
  const out = [];
  for (const regex of list) {
    try {
      out.push(await chrome.declarativeNetRequest.isRegexSupported({ regex }));
    } catch (e) {
      out.push({ isSupported: null, reason: String(e && e.message || e) });
    }
  }
  return JSON.stringify(out);
})()`;

const child = spawn(
  findChrome(),
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let cdp;
try {
  const version = await waitForEndpoint(PORT);
  cdp = await new Cdp(version.webSocketDebuggerUrl).connect();
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: dir });

  let worker = null;
  for (let attempt = 0; attempt < 30 && !worker; attempt += 1) {
    await sleep(200);
    const { targetInfos } = await cdp.send("Target.getTargets");
    worker = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(loaded.id));
  }
  if (!worker) throw new Error("service worker never appeared");

  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );

  const outcomes = JSON.parse(result.value);
  let unsupported = 0;

  found.forEach((entry, index) => {
    const outcome = outcomes[index] || {};
    if (outcome.isSupported) return;
    unsupported += 1;
    console.log(`  UNSUPPORTED  ${entry.ruleset} rule ${entry.id}`);
    console.log(`      reason : ${outcome.reason ?? "(none given)"}`);
    console.log(`      regex  : ${entry.regex.slice(0, 150)}`);
    console.log("");
  });

  console.log(
    unsupported === 0
      ? `all ${found.length} regexFilters are supported`
      : `${unsupported} of ${found.length} regexFilters are NOT supported and are being dropped`
  );
  console.log("");
} finally {
  cdp?.close();
  child.kill();
  await sleep(400);
  for (const target of [dir, profile]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* Windows lock */
    }
  }
}
