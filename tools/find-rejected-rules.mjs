#!/usr/bin/env node
/**
 * Finds the exact rules Chrome silently refuses to store.
 *
 * Chrome accepts a ruleset file, reports the ruleset as enabled, and then keeps
 * fewer rules than the file contained -- with no warning anywhere. The only way
 * to find the offenders is to measure: split the rules into chunks, load each
 * chunk as its own ruleset, and count what Chrome actually holds. Chunks that
 * come up short get split again until the individual rules are isolated.
 *
 * Builds throwaway extensions in a temp directory, so the real extension is
 * never touched.
 *
 *   node tools/find-rejected-rules.mjs extension/rules/filters-05.json
 *   node tools/find-rejected-rules.mjs extension/rules/filters-05.json --rounds=3
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
const roundsArg = args.find((a) => a.startsWith("--rounds="));
const MAX_ROUNDS = roundsArg ? Number(roundsArg.split("=")[1]) : 3;
const SPLIT = 40;
const PORT = Number(process.env.JEV_CDP_PORT || 9231);

if (!input) {
  console.error("usage: node tools/find-rejected-rules.mjs <ruleset.json> [--rounds=N]");
  process.exit(1);
}

const CHROME_CANDIDATES = [
  process.env.JEV_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error("chrome.exe not found. Set JEV_CHROME.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
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

const MEASURE = `(async () => {
  const dnr = chrome.declarativeNetRequest;
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const ids = await dnr.getEnabledRulesets();

  await dnr.updateEnabledRulesets({ disableRulesetIds: ids });
  await settle();
  const allOff = await dnr.getAvailableStaticRuleCount();

  const sizes = {};
  for (const id of ids) {
    await dnr.updateEnabledRulesets({ enableRulesetIds: [id] });
    await settle();
    sizes[id] = allOff - await dnr.getAvailableStaticRuleCount();
    await dnr.updateEnabledRulesets({ disableRulesetIds: [id] });
    await settle();
  }
  return JSON.stringify({ sizes, allOff });
})()`;

/** Builds a throwaway extension whose only rules are the given chunks. */
function buildTestExtension(chunks) {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rule-probe-"));
  mkdirSync(path.join(dir, "rules"), { recursive: true });

  const ruleResources = [];
  chunks.forEach((rules, index) => {
    const id = `chunk-${String(index).padStart(3, "0")}`;
    writeFileSync(
      path.join(dir, "rules", `${id}.json`),
      JSON.stringify(rules),
      "utf8"
    );
    ruleResources.push({ id, enabled: true, path: `rules/${id}.json` });
  });

  const manifest = {
    manifest_version: 3,
    name: "jev rule probe",
    version: "1.0.0",
    permissions: [
      "declarativeNetRequest",
      "declarativeNetRequestFeedback",
      "storage",
    ],
    background: { service_worker: "sw.js" },
    declarative_net_request: { rule_resources: ruleResources },
  };

  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  // A service worker is required for a target to attach to; it does nothing so
  // it cannot interfere with the measurements.
  writeFileSync(path.join(dir, "sw.js"), "void 0;\n", "utf8");

  return dir;
}

async function measure(chunks) {
  const chromePath = findChrome();
  const dir = buildTestExtension(chunks);
  const profile = mkdtempSync(path.join(tmpdir(), "jev-probe-profile-"));

  const child = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
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
      worker = targetInfos.find(
        (t) => t.type === "service_worker" && t.url.includes(loaded.id)
      );
    }
    if (!worker) throw new Error("service worker never appeared");

    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    });
    const { result } = await cdp.send(
      "Runtime.evaluate",
      { expression: MEASURE, awaitPromise: true, returnByValue: true },
      sessionId
    );
    return JSON.parse(result.value).sizes;
  } finally {
    cdp?.close();
    child.kill();
    await sleep(400);
    for (const target of [dir, profile]) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* Windows lock; harmless */
      }
    }
  }
}

const source = JSON.parse(readFileSync(input, "utf8"));
console.log(`\nsource : ${input}`);
console.log(`rules  : ${source.length}`);
console.log("");

let suspects = source.map((rule, index) => ({ rule, index }));

for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const perChunk = Math.ceil(suspects.length / SPLIT);
  const chunks = [];
  for (let i = 0; i < suspects.length; i += perChunk) {
    chunks.push(suspects.slice(i, i + perChunk));
  }

  console.log(`round ${round}: ${suspects.length} candidates in ${chunks.length} chunks`);

  const sizes = await measure(chunks.map((chunk) => chunk.map((s) => s.rule)));

  const short = [];
  chunks.forEach((chunk, index) => {
    const id = `chunk-${String(index).padStart(3, "0")}`;
    const held = sizes[id];
    if (held !== chunk.length) {
      short.push({ chunk, held, lost: chunk.length - held });
    }
  });

  if (short.length === 0) {
    console.log(`  no shortfall at this granularity -- every rule loaded.`);
    console.log("\nNothing rejected.\n");
    process.exit(0);
  }

  const lost = short.reduce((sum, entry) => sum + entry.lost, 0);
  console.log(`  ${short.length} chunk(s) short, ${lost} rule(s) missing`);

  suspects = short.flatMap((entry) => entry.chunk);

  if (suspects.length <= SPLIT || perChunk === 1) break;
}

console.log(`\n${suspects.length} rule(s) isolated. Chrome rejects:\n`);
for (const { rule, index } of suspects.slice(0, 40)) {
  console.log(`  source index ${index}`);
  console.log(`    ${JSON.stringify(rule)}`);
}
if (suspects.length > 40) console.log(`  ... and ${suspects.length - 40} more`);
console.log("");
