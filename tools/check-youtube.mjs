#!/usr/bin/env node
/**
 * Verifies the YouTube ad patcher actually reaches the page's main world.
 *
 *   node tools/check-youtube.mjs
 *
 * Three things worth proving, none of which can be checked by reading source:
 *
 *   1. The registration is created the way the patcher needs it -- `world:
 *      "MAIN"` and `runAt: "document_start"`. A content script in Chrome's
 *      default isolated world gets its own `fetch`; patching that would look
 *      like it worked and change nothing.
 *   2. The patched `fetch` in the *page's* world really does rewrite a player
 *      response in flight.
 *   3. A response with nothing to strip comes back byte-identical. Playback
 *      data must survive; a blocker that breaks video is worse than no blocker.
 *
 * The local server has to speak HTTPS. `youtube.com` is HSTS-preloaded, so
 * Chrome silently rewrites `http://www.youtube.com/...` to `https://` before it
 * ever hits the resolver -- a plain HTTP server is never reached and the page
 * loads as an error document. A self-signed cert plus
 * `--ignore-certificate-errors` gets a real document onto a real youtube.com
 * origin, which is what makes the manifest's match patterns fire.
 *
 * `--host-resolver-rules` then points that name at 127.0.0.1, so the whole path
 * runs end to end without touching the real YouTube.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"),
  ".."
);
const EXTENSION_DIR = path.join(ROOT, "extension");

const CHROME_CANDIDATES = [
  process.env.JEV_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
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

/** A throwaway cert for www.youtube.com, so the origin looks real to Chrome. */
function makeCert(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", key, "-out", cert,
      "-days", "2", "-nodes",
      "-subj", "/CN=www.youtube.com",
      "-addext", "subjectAltName=DNS:www.youtube.com,DNS:youtube.com,DNS:*.youtube.com",
    ],
    { stdio: "ignore" }
  );
  if (result.status !== 0 || !existsSync(key) || !existsSync(cert)) {
    throw new Error("could not generate a test certificate (is openssl on PATH?)");
  }
  return { key, cert };
}

async function waitForEndpoint(port, timeoutMs = 25000) {
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
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || "CDP error"));
        else entry.resolve(message.result);
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

// A player response as YouTube shapes it: ad fields alongside the data the
// player needs to actually play the video.
const AD_RESPONSE = {
  adPlacements: [{ adSlotLoggingData: { a: 1 } }, { adSlotLoggingData: { b: 2 } }],
  playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
  adParams: "targeting=yes",
  streamingData: { formats: [{ itag: 137, mimeType: "video/mp4" }] },
  videoDetails: { videoId: "abcdefghijk", title: "A real video" },
};

const CLEAN_RESPONSE = {
  streamingData: { formats: [{ itag: 137, mimeType: "video/mp4" }] },
  videoDetails: { videoId: "abcdefghijk", title: "A real video" },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>yt probe</title></head><body>
<script>
window.__probe = { done: false };
(async () => {
  try {
    const adRes = await fetch("/youtubei/v1/player?probe=ad", { method: "POST" });
    window.__probe.ad = await adRes.json();

    const cleanRes = await fetch("/youtubei/v1/player?probe=clean", { method: "POST" });
    window.__probe.clean = await cleanRes.json();

    // A non-player URL must pass through untouched.
    const other = await fetch("/other");
    window.__probe.other = await other.text();
  } catch (e) {
    window.__probe.error = String(e);
  }
  window.__probe.done = true;
})();

// Whether the page sees the patched fetch is the whole point of world:"MAIN".
window.__probe.fetchPatched = typeof window.fetch === "function" &&
  String(window.fetch).includes("original.call");
</script>
<p>probe</p></body></html>`;

async function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), "jev-yt-"));
  const { key, cert } = makeCert(workDir);

  // Both must be read as buffers: tls treats a *string* `key` as PEM content,
  // not as a filename, and fails with a decoder error if given a path.
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
    if (req.url.startsWith("/youtubei/v1/player")) {
      const body = req.url.includes("probe=ad") ? AD_RESPONSE : CLEAN_RESPONSE;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.url === "/other") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("untouched");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const appPort = server.address().port;

  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "jev-yt-profile-"));

  const child = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Accept the throwaway cert so the youtube.com origin resolves.
      "--ignore-certificate-errors",
      // Point the real name at the local server.
      `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${appPort}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let cdp;
  let failed = 0;
  const results = [];
  const check = (label, ok, detail = "") => {
    if (ok) results.push(`  ok   ${label}`);
    else {
      failed += 1;
      results.push(`  FAIL ${label}${detail ? `  -- ${detail}` : ""}`);
    }
  };

  try {
    const version = await waitForEndpoint(port);
    cdp = await new Cdp(version.webSocketDebuggerUrl).connect();
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });

    let worker = null;
    for (let attempt = 0; attempt < 40 && !worker; attempt += 1) {
      await sleep(200);
      const { targetInfos } = await cdp.send("Target.getTargets");
      worker = targetInfos.find(
        (t) => t.type === "service_worker" && t.url.includes(loaded.id)
      );
    }
    if (!worker) throw new Error("extension service worker never appeared");

    const { sessionId: swSession } = await cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    });

    const { result: regResult } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          const yt = scripts.find((s) => s.id === "jev-youtube");
          return JSON.stringify(yt
            ? { found: true, world: yt.world, runAt: yt.runAt, matches: yt.matches }
            : { found: false });
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      swSession
    );
    const reg = JSON.parse(regResult.value);
    check("jev-youtube script is registered", reg.found === true);
    check('registered with world:"MAIN"', reg.world === "MAIN", `got ${reg.world}`);
    check("registered at document_start", reg.runAt === "document_start", `got ${reg.runAt}`);

    await sleep(600);

    const watchUrl = `https://www.youtube.com:${appPort}/watch`;
    const { targetId } = await cdp.send("Target.createTarget", { url: watchUrl });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    let probe = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(250);
      try {
        const { result } = await cdp.send(
          "Runtime.evaluate",
          {
            expression: "JSON.stringify(window.__probe || {})",
            returnByValue: true,
          },
          sessionId
        );
        const parsed = JSON.parse(result.value || "{}");
        if (parsed.done) {
          probe = parsed;
          break;
        }
      } catch {
        /* page still navigating */
      }
    }

    if (!probe) {
      const { result: state } = await cdp.send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({href: location.href, title: document.title, body: document.body ? document.body.innerText.slice(0,120) : null})",
          returnByValue: true,
        },
        sessionId
      );
      throw new Error(`the probe never completed; page was ${state.value}`);
    }

    const ad = probe.ad || {};
    const clean = probe.clean || {};

    check("page sees the patched fetch (main world)", probe.fetchPatched === true);

    check(
      "ad response: adPlacements emptied",
      JSON.stringify(ad.adPlacements) === "[]",
      `got ${JSON.stringify(ad.adPlacements)}`
    );
    check(
      "ad response: playerAds emptied",
      JSON.stringify(ad.playerAds) === "[]",
      `got ${JSON.stringify(ad.playerAds)}`
    );
    check("ad response: adParams removed", !("adParams" in ad), `got ${JSON.stringify(ad.adParams)}`);

    // The point of all of it: playback data must survive.
    check("ad response: streamingData intact", ad.streamingData?.formats?.[0]?.itag === 137);
    check("ad response: videoDetails intact", ad.videoDetails?.videoId === "abcdefghijk");

    check(
      "clean response: ad-free stays ad-free",
      JSON.stringify(clean) === JSON.stringify(CLEAN_RESPONSE),
      `got ${JSON.stringify(clean)}`
    );
    check("non-player URL is untouched", probe.other === "untouched", `got ${JSON.stringify(probe.other)}`);
    check("no page-side error", !probe.error, probe.error || "");
  } finally {
    cdp?.close();
    child.kill();
    await sleep(400);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [profile, workDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows lock */
      }
    }
  }

  console.log("");
  console.log("YouTube ad patcher");
  console.log("");
  for (const line of results) console.log(line);
  console.log("");
  console.log(
    failed === 0
      ? "PASS - the patcher reaches the page and strips ads without touching playback data."
      : `FAIL - ${failed} check(s) failed.`
  );
  console.log("");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\ncheck-youtube.mjs failed:", error.message, "\n");
  process.exit(1);
});
