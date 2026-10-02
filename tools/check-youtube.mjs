#!/usr/bin/env node
/**
 * Verifies the YouTube ad blocking pipeline in a real Chrome.
 *
 *   node tools/check-youtube.mjs
 *
 * The pipeline has two halves, and both are covered here:
 *
 *   * the **scriptlet engine** (src/scriptlets.js), driven by rules compiled
 *     from filters/scriptlets.txt -- this is the Brave-shaped half, and it does
 *     the work for anything the page obtains through `fetch`, `XHR` or
 *     `JSON.parse`;
 *   * the **supplements** (src/youtube.js) -- the inline `ytInitialPlayerResponse`
 *     trap and the skip-button fallback, which a scriptlet cannot express.
 *
 * Neither half can be validated by reading the source, because the whole point
 * is what the *page* observes. So this asserts against the page's own view:
 *
 *   1. the registrations exist with `world: "MAIN"` and `runAt: "document_start"`
 *      -- in the isolated world every hook would patch a copy nothing calls;
 *   2. `window.__jevScriptlets` is set before the engine reads it;
 *   3. a player response fetched by the page comes back with its ad fields gone;
 *   4. `JSON.parse` sees the same treatment;
 *   5. the page's own `ytInitialPlayerResponse` assignment is cleaned in flight;
 *   6. an ad-free response and a non-JSON response are byte-identical.
 *
 * (6) is the one that matters most. A blocker that mangles responses it should
 * not touch breaks sites, and that is worse than an ad.
 *
 * The local server has to speak HTTPS. `youtube.com` is HSTS-preloaded, so
 * Chrome rewrites `http://www.youtube.com/...` to `https://` before the resolver
 * runs -- a plain HTTP server is never reached and the page loads as an error
 * document. A throwaway cert plus `--ignore-certificate-errors` gets a real
 * document onto a real youtube.com origin, which is what makes the match
 * patterns fire. `--host-resolver-rules` then points the name at 127.0.0.1.
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

// The inline assignment is deliberately at top level, not inside the async
// function: `var` inside a function would create a local binding and never
// touch `window`, so it would not exercise the trap at all.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>yt probe</title>
<script>
var ytInitialPlayerResponse = {
  adPlacements: [{ a: 1 }, { b: 2 }],
  playerAds: [{}],
  adParams: "inline=yes",
  streamingData: { formats: [{ itag: 137, mimeType: "video/mp4" }] },
  videoDetails: { videoId: "abcdefghijk", title: "A real video" }
};
</script>
</head><body>
<script>
window.__probe = { done: false };
window.__probe.scriptletsLoaded = Array.isArray(window.__jevScriptlets);
window.__probe.inline = window.ytInitialPlayerResponse;

(async () => {
  try {
    const adRes = await fetch("/youtubei/v1/player?probe=ad", { method: "POST" });
    window.__probe.ad = await adRes.json();

    const cleanRes = await fetch("/youtubei/v1/player?probe=clean", { method: "POST" });
    window.__probe.clean = await cleanRes.json();

    window.__probe.parsed = JSON.parse(
      '{"adPlacements":[{"x":1}],"playerAds":[{}],"streamingData":{"formats":[{"itag":137}]}}'
    );

    window.__probe.other = await (await fetch("/other")).text();
  } catch (e) {
    window.__probe.error = String(e);
  }
  window.__probe.done = true;
})();
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
    }
  );

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
      "--ignore-certificate-errors",
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
          return JSON.stringify(scripts
            .filter((s) => s.id.startsWith("jev-mainworld-"))
            .map((s) => ({ id: s.id, world: s.world, runAt: s.runAt, files: s.js, matches: s.matches.length })));
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      swSession
    );
    const regs = JSON.parse(regResult.value);
    const group = regs.find((r) => r.id === "jev-mainworld-g1");
    const supplement = regs.find((r) => r.id === "jev-mainworld-youtube-supplement");

    check("scriptlet group is registered", Boolean(group), JSON.stringify(regs.map((r) => r.id)));
    check("supplements script is registered", Boolean(supplement));
    check(
      'group registered with world:"MAIN"',
      group?.world === "MAIN",
      `got ${group?.world}`
    );
    check("group registered at document_start", group?.runAt === "document_start", `got ${group?.runAt}`);
    check(
      "config file is listed before the engine",
      Array.isArray(group?.files) &&
        group.files[0].startsWith("scriptlets/") &&
        group.files[1] === "src/scriptlets.js",
      JSON.stringify(group?.files)
    );

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
    const parsed = probe.parsed || {};
    const inline = probe.inline || {};

    check("scriptlet config reached the page", probe.scriptletsLoaded === true);

    // --- scriptlet engine: fetch ------------------------------------------
    //
    // json-prune *deletes* the named properties; it does not empty them. That is
    // uBlock's documented behaviour and it is what the rules here inherit, so
    // the assertion is absence rather than an empty array. (The supplements
    // script empties arrays instead -- see the inline checks below -- and both
    // shapes read as "no ads" to the player.)
    check(
      "fetch: adPlacements removed",
      !("adPlacements" in ad),
      `got ${JSON.stringify(ad.adPlacements)}`
    );
    check(
      "fetch: playerAds removed",
      !("playerAds" in ad),
      `got ${JSON.stringify(ad.playerAds)}`
    );
    check("fetch: adParams removed", !("adParams" in ad), `got ${JSON.stringify(ad.adParams)}`);
    check("fetch: streamingData intact", ad.streamingData?.formats?.[0]?.itag === 137);
    check("fetch: videoDetails intact", ad.videoDetails?.videoId === "abcdefghijk");

    // --- scriptlet engine: JSON.parse -------------------------------------
    check(
      "JSON.parse: adPlacements removed",
      !("adPlacements" in parsed),
      `got ${JSON.stringify(parsed.adPlacements)}`
    );
    check("JSON.parse: streamingData intact", parsed.streamingData?.formats?.[0]?.itag === 137);

    // --- supplements: inline trap -----------------------------------------
    check(
      "inline ytInitialPlayerResponse: adPlacements emptied",
      JSON.stringify(inline.adPlacements) === "[]",
      `got ${JSON.stringify(inline.adPlacements)}`
    );
    check(
      "inline ytInitialPlayerResponse: playerAds emptied",
      JSON.stringify(inline.playerAds) === "[]",
      `got ${JSON.stringify(inline.playerAds)}`
    );
    check("inline: streamingData intact", inline.streamingData?.formats?.[0]?.itag === 137);
    check("inline: videoDetails intact", inline.videoDetails?.videoId === "abcdefghijk");

    // --- the safety properties --------------------------------------------
    check(
      "ad-free response is byte-identical",
      JSON.stringify(clean) === JSON.stringify(CLEAN_RESPONSE),
      `got ${JSON.stringify(clean)}`
    );
    check("non-JSON response is untouched", probe.other === "untouched", `got ${JSON.stringify(probe.other)}`);
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
  console.log("YouTube ad blocking pipeline");
  console.log("");
  for (const line of results) console.log(line);
  console.log("");
  console.log(
    failed === 0
      ? "PASS - scriptlets strip the ad fields, the inline response is cleaned in flight,\n       and responses with nothing to strip are untouched."
      : `FAIL - ${failed} check(s) failed.`
  );
  console.log("");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\ncheck-youtube.mjs failed:", error.message, "\n");
  process.exit(1);
});
