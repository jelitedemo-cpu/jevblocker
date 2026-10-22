#!/usr/bin/env node
/**
 * Checks the YouTube setting against the real site.
 *
 * tools/check-youtube.mjs proves the scriptlet engine strips ad fields from a
 * response it is handed. That is a unit test. This asks the harder question:
 * what does YouTube actually do when the extension is installed?
 *
 *   node tools/check-youtube-live.mjs [videoId] [--headed]
 *
 * Needs internet, and deliberately is NOT part of `run-in-chrome.cmd verify`.
 * YouTube changes this behaviour without notice, and a check that depends on a
 * third party's live decisions has no business gating a commit.
 *
 * What it reports per mode:
 *   enforcement -- the "Ad blockers violate YouTube's Terms of Service" card
 *   hasVideo    -- a <video> element with real duration (metadata loaded)
 *   botCheck    -- YouTube refused the automated browser; result inconclusive
 *
 * The card is the signal that matters. If it is absent and a video element
 * loaded, the mode works.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const EXTENSION_DIR = path.join(ROOT, "extension");

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const videoId = args.find((a) => !a.startsWith("--")) || "dQw4w9WgXcQ";
const VIDEO_URL = `https://www.youtube.com/watch?v=${videoId}`;

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
  throw new Error(`Chrome did not open a debug port on ${port}: ${lastError?.message || "timeout"}`);
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
      /* already gone */
    }
  }
}

/**
 * Read from the page rather than inferred from network activity.
 *
 * `textContent` instead of `innerText`: the latter forces layout on a page that
 * is still streaming, and the check runs while the player is settling.
 */
const PROBE_EXPRESSION = `(() => {
  const text = document.body ? document.body.textContent : "";
  const video = document.querySelector("video");
  const duration = video && Number.isFinite(video.duration) ? Math.round(video.duration) : null;
  return JSON.stringify({
    href: location.href,
    title: document.title,
    enforcement: /ad blockers? violate youtube'?s terms of service/i.test(text),
    enforcementNode: Boolean(document.querySelector("ytd-enforcement-message-view-model")),
    hasVideo: Boolean(video),
    duration,
    readyState: video ? video.readyState : null,
    botCheck: /confirm you.?re not a bot|sign in to confirm/i.test(text),
    consent: /before you continue to youtube/i.test(text),
  });
})()`;

async function setMode(cdp, workerTargetId, mode) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: workerTargetId,
    flatten: true,
  });
  const { result } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        const stored = await chrome.storage.local.get("settings");
        const base = stored.settings || {};
        await chrome.storage.local.set({ settings: { ...base, youtubeMode: ${JSON.stringify(mode)} } });
        await new Promise((r) => setTimeout(r, 900));
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        return JSON.stringify({
          allowRules: rules.filter((r) => r.id === 9001 || r.id === 9002).length,
          mainWorldScripts: scripts.filter((s) => s.id.startsWith("jev-mainworld-")).length,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  return result?.value ? JSON.parse(result.value) : null;
}

async function probeMode(cdp, workerTargetId, mode) {
  const applied = await setMode(cdp, workerTargetId, mode);

  const { targetId } = await cdp.send("Target.createTarget", { url: VIDEO_URL });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  // Poll rather than sleep a fixed amount. The player resolves on its own
  // schedule and the enforcement card can appear seconds after the video looks
  // ready, so stopping at the first good reading would be wrong.
  let best = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression: PROBE_EXPRESSION, returnByValue: true },
        sessionId
      );
      if (result?.value) {
        const parsed = JSON.parse(result.value);
        if (parsed.href.includes("youtube.com/watch")) {
          best = parsed;
          if (parsed.enforcement || parsed.botCheck || parsed.consent) break;
          if (parsed.hasVideo && parsed.duration > 0) {
            // Give the card a further moment to show up before believing this.
            await sleep(2500);
            const { result: again } = await cdp.send(
              "Runtime.evaluate",
              { expression: PROBE_EXPRESSION, returnByValue: true },
              sessionId
            );
            if (again?.value) best = JSON.parse(again.value);
            break;
          }
        }
      }
    } catch {
      /* navigation in flight */
    }
    await sleep(500);
  }

  try {
    await cdp.send("Target.closeTarget", { targetId });
  } catch {
    /* already gone */
  }

  return { applied, probe: best };
}

async function main() {
  if (!existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`no manifest.json in ${EXTENSION_DIR}`);
  }

  const chromePath = findChrome();
  const port = await freePort();
  const profileDir = mkdtempSync(path.join(tmpdir(), "jev-yt-live-"));

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "about:blank",
  ];
  if (!headed) chromeArgs.unshift("--headless=new");

  console.log(`chrome : ${chromePath}`);
  console.log(`video  : ${VIDEO_URL}`);
  console.log(`mode   : ${headed ? "headed" : "headless"}\n`);

  const child = spawn(chromePath, chromeArgs, { stdio: "ignore" });
  let cdp;

  try {
    const version = await waitForEndpoint(port);
    cdp = await new Cdp(version.webSocketDebuggerUrl).connect();

    const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });

    let worker = null;
    for (let attempt = 0; attempt < 20 && !worker; attempt += 1) {
      await sleep(250);
      const { targetInfos } = await cdp.send("Target.getTargets");
      worker = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(loaded.id));
    }
    if (!worker) throw new Error("extension loaded but no service worker appeared");

    const results = [];
    for (const mode of ["block", "allow"]) {
      process.stdout.write(`probing youtubeMode="${mode}"… `);
      const outcome = await probeMode(cdp, worker.targetId, mode);
      results.push({ mode, ...outcome });
      const p = outcome.probe;
      console.log(
        p
          ? `enforcement=${p.enforcement} video=${p.hasVideo} duration=${p.duration}`
          : "no reading"
      );
    }

    console.log("");
    console.log("mode   applied (rules/scripts)   enforcement   video   verdict");
    let inconclusive = 0;

    for (const row of results) {
      const p = row.probe;
      const applied = `${row.applied?.allowRules ?? "?"}r / ${row.applied?.mainWorldScripts ?? "?"}s`;

      if (!p) {
        console.log(`${row.mode.padEnd(6)} ${applied.padEnd(23)} ?             ?       no reading`);
        inconclusive += 1;
        continue;
      }

      if (p.botCheck || p.consent) {
        console.log(
          `${row.mode.padEnd(6)} ${applied.padEnd(23)} inconclusive  ${p.hasVideo ? "yes" : "no"}     ` +
            `YouTube served ${p.botCheck ? "a bot check" : "a consent wall"}`
        );
        inconclusive += 1;
        continue;
      }

      const verdict = p.enforcement
        ? "DETECTED — playback blocked"
        : p.hasVideo && p.duration > 0
          ? "ok — no enforcement card, player loaded"
          : "unclear — no card but no player either";

      console.log(
        `${row.mode.padEnd(6)} ${applied.padEnd(23)} ${String(p.enforcement).padEnd(13)} ` +
          `${(p.hasVideo ? "yes" : "no").padEnd(7)} ${verdict}`
      );
    }

    console.log("");
    if (inconclusive === results.length) {
      console.log(
        "INCONCLUSIVE — YouTube would not serve a player to an automated browser.\n" +
          "Run with --headed, or check by hand: set the mode in Settings and reload a video."
      );
      process.exitCode = 2;
      return;
    }

    const allow = results.find((r) => r.mode === "allow")?.probe;
    const block = results.find((r) => r.mode === "block")?.probe;

    const blockUsable = block && !block.botCheck && !block.consent;
    const allowUsable = allow && !allow.botCheck && !allow.consent;

    // This check is only evidence if blocking mode actually got caught. When it
    // does not, the allow run cannot fail no matter what the extension does --
    // there is no card to suppress -- and reporting PASS would be a test that
    // passes on broken code. That is exactly what the first version did.
    if (blockUsable && !block.enforcement) {
      console.log(
        "INCONCLUSIVE — YouTube did not detect blocking mode on this video, so the\n" +
          "               allow run proves nothing: there was no card to suppress.\n" +
          "               Pass a monetised video id to make the comparison real:\n" +
          "               node tools/check-youtube-live.mjs <videoId>"
      );
      if (allowUsable && allow.enforcement) process.exitCode = 1;
      else process.exitCode = 2;
      return;
    }

    if (blockUsable && block.enforcement) {
      console.log(
        "NOTE — blocking mode is detected on this video. That is the expected state\n" +
          "       of the arms race, and the reason the setting exists."
      );
      if (allowUsable) {
        console.log(
          allow.enforcement
            ? "FAIL — the card survived the switch to allow. Our allow path is incomplete;\n" +
                "       check that both dynamic rules exist AND both scripts are gone."
            : "PASS — blocking was detected, and switching to allow cleared it."
        );
        process.exitCode = allow.enforcement ? 1 : 0;
      }
      return;
    }

    if (allowUsable && allow.enforcement) {
      console.log(
        "FAIL — even with YouTube allowed, the enforcement card appeared. Detection is\n" +
          "       not coming from this extension."
      );
      process.exitCode = 1;
    }
  } finally {
    cdp?.close();
    child.kill();
    await sleep(900);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a lock */
    }
  }
}

main().catch((error) => {
  console.error(`\nFAIL — ${error.message}`);
  process.exitCode = 1;
});
