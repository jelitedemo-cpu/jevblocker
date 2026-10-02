/**
 * Scriptlet engine.
 *
 * This is the piece that makes the extension behave like Brave rather than like
 * a hardcoded special case. Brave's YouTube handling is not a bespoke feature
 * compiled into the browser -- it is uBlock Origin scriptlets, applied through
 * ordinary filter rules. adblock-rust says as much in its own README: it "uses
 * uBlock Origin-compatible resources for scriptlet injection".
 *
 * The consequence that matters is updateability. A rule lives in a text file
 * (extension/filters/scriptlets.txt), not in this file, so when YouTube renames
 * a field the fix is a one-line rule change -- no code change, no new release.
 * A hardcoded patcher has to be rebuilt and reshipped every time.
 *
 * Architecture, mirroring Brave's:
 *
 *   1. filters/scriptlets.txt     rules, uBlock syntax (`##+js(name, args)`)
 *   2. tools/compile_scriptlets.py compiles them to per-host-group configs
 *   3. scriptlets/group-N.js      sets window.__jevScriptlets for that group
 *   4. this file                  runs in the MAIN world at document_start,
 *                                 reads the config, installs the scriptlets
 *
 * Two design rules, both deliberate:
 *
 *   * **Only a fixed library runs.** The rules choose *which* scriptlet and
 *     supply *arguments*; they never supply code. A filter list is data, and
 *     treating it as data is what keeps this from being an arbitrary-code-
 *     execution engine. uBlock and Brave work the same way.
 *   * **Everything fails open.** Every hook is wrapped so that a scriptlet
 *     which throws, or meets a shape it does not understand, leaves the
 *     response exactly as it was. A broken ad blocker that also breaks the page
 *     is worse than no ad blocker.
 */

(() => {
  "use strict";

  const LOG = "[jev:scriptlets]";

  const config = Array.isArray(window.__jevScriptlets) ? window.__jevScriptlets : [];
  if (config.length === 0) return;

  // The config file runs immediately before this one, but a re-injected script
  // must not double-wrap fetch. Each hook checks its own marker.
  const installed = {};

  // -------------------------------------------------------------------------
  // Property-path pruning
  // -------------------------------------------------------------------------

  /**
   * Walks a dot-separated path and deletes the property at the end of it.
   *
   * Supports the two uBlock wildcards that appear in real rules:
   *   `[]`  apply the rest of the path to every element of an array
   *   `*`   apply the rest of the path to every own property of an object
   *
   * Returns true if anything was removed, so callers can avoid rebuilding a
   * response that did not change.
   */
  function prunePath(target, parts) {
    if (!target || typeof target !== "object") return false;

    const [head, ...rest] = parts;
    if (head === undefined || head === "") return false;

    if (head === "[]") {
      if (!Array.isArray(target)) return false;
      let removed = false;
      for (const item of target) {
        if (prunePath(item, rest)) removed = true;
      }
      return removed;
    }

    if (head === "*") {
      // `*` with nothing after it would delete every property, which is a
      // response-destroying rule rather than an ad-blocking one. Refuse it.
      if (rest.length === 0) return false;
      let removed = false;
      for (const key of Object.keys(target)) {
        if (prunePath(target[key], rest)) removed = true;
      }
      return removed;
    }

    if (rest.length === 0) {
      if (!Object.prototype.hasOwnProperty.call(target, head)) return false;
      try {
        delete target[head];
        return true;
      } catch {
        return false; // non-configurable; leave it
      }
    }

    return prunePath(target[head], rest);
  }

  function pruneAll(payload, paths) {
    let removed = 0;
    for (const path of paths) {
      if (prunePath(payload, path.split("."))) removed += 1;
    }
    return removed;
  }

  /** Parses a scriptlet's first argument into a list of paths. */
  function pathsFrom(args) {
    const raw = String(args[0] || "").trim();
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // json-prune -- hooks JSON.parse and Response.json
  // -------------------------------------------------------------------------

  function installJsonPrune(paths) {
    if (paths.length === 0) return false;
    if (installed.jsonPrune) return true;
    installed.jsonPrune = true;

    const originalParse = JSON.parse;
    JSON.parse = function (...args) {
      const result = originalParse.apply(this, args);
      try {
        if (result && typeof result === "object") pruneAll(result, paths);
      } catch {
        /* leave it untouched */
      }
      return result;
    };

    // `Response.json` is a separate path into the same data and is not covered
    // by patching JSON.parse.
    if (typeof Response === "function" && Response.prototype?.json) {
      const originalJson = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const result = await originalJson.apply(this, args);
        try {
          if (result && typeof result === "object") pruneAll(result, paths);
        } catch {
          /* leave it untouched */
        }
        return result;
      };
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // json-prune-fetch-response -- hooks fetch
  // -------------------------------------------------------------------------

  function installJsonPruneFetch(paths) {
    if (paths.length === 0) return false;
    if (installed.fetch) return true;
    installed.fetch = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") return false;

    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);

      try {
        // Only JSON is worth reading. Checking the header first means every
        // image, script and video segment on the page passes straight through
        // without being buffered -- this hook is global, so the cheap early
        // exit is what keeps it from costing anything.
        const type = response.headers.get("content-type") || "";
        if (type && !type.includes("json")) return response;

        const parsed = JSON.parse(await response.clone().text());
        if (!parsed || typeof parsed !== "object") return response;
        if (pruneAll(parsed, paths) === 0) return response;

        // The body has already been read from the clone, so a fresh Response is
        // returned rather than mutating one that cannot be mutated.
        return new Response(JSON.stringify(parsed), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };

    return true;
  }

  // -------------------------------------------------------------------------
  // json-prune-xhr-response -- hooks XMLHttpRequest
  // -------------------------------------------------------------------------

  function installJsonPruneXhr(paths) {
    if (paths.length === 0) return false;
    if (installed.xhr) return true;
    installed.xhr = true;

    const proto = window.XMLHttpRequest?.prototype;
    if (!proto) return false;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function (method, url, ...rest) {
      this.__jevUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    proto.send = function (...args) {
      this.addEventListener("readystatechange", function () {
        if (this.readyState !== 4) return;
        try {
          // Throws for responseType "arraybuffer"/"blob", which the player uses
          // for media. Those carry no ad data, so leaving them alone is correct.
          const text = this.responseText;
          if (!text) return;

          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object") return;
          if (pruneAll(parsed, paths) === 0) return;

          const cleaned = JSON.stringify(parsed);
          Object.defineProperty(this, "responseText", { configurable: true, get: () => cleaned });
          Object.defineProperty(this, "response", { configurable: true, get: () => cleaned });
        } catch {
          /* not JSON, or not readable; leave it */
        }
      });
      return originalSend.apply(this, args);
    };

    return true;
  }

  // -------------------------------------------------------------------------
  // set-constant -- pin a property on window to a fixed value
  // -------------------------------------------------------------------------

  const CONSTANTS = {
    undefined: undefined,
    false: false,
    true: true,
    null: null,
    "": "",
    "[]": [],
    "{}": {},
    noopFunc: () => {},
    trueFunc: () => true,
    falseFunc: () => false,
    throwFunc: () => {
      throw new Error();
    },
  };

  function constantFrom(token) {
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, token)) return CONSTANTS[token];
    const n = Number(token);
    if (Number.isInteger(n) && n >= 0 && n <= 0x7fff) return n;
    return undefined;
  }

  /**
   * Defines `window.a.b.c = value` so the value survives the page assigning
   * over it.
   *
   * The page usually assigns the whole chain at once -- `ytInitialPlayerResponse
   * = {...}` -- after this runs, so the last segment needs a getter that keeps
   * returning the constant, and intermediate segments need setters that rebuild
   * the chain when the page replaces them.
   */
  function setConstant(path, value) {
    const parts = String(path).split(".").filter(Boolean);
    if (parts.length === 0) return false;

    let host = window;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      const existing = host[key];
      if (existing && typeof existing === "object") {
        host = existing;
        continue;
      }
      const child = {};
      try {
        Object.defineProperty(host, key, {
          configurable: true,
          get: () => child,
          set: (next) => {
            // The page replaced the object; graft the remaining path onto it.
            if (next && typeof next === "object") {
              Object.defineProperty(next, parts[i + 1], {
                configurable: true,
                get: () => value,
                set: () => {},
              });
            }
          },
        });
      } catch {
        return false;
      }
      host = child;
    }

    try {
      Object.defineProperty(host, parts[parts.length - 1], {
        configurable: true,
        get: () => value,
        set: () => {},
      });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  const applied = [];

  for (const entry of config) {
    const name = String(entry?.name || "").trim();
    const args = Array.isArray(entry?.args) ? entry.args : [];
    const paths = pathsFrom(args);

    let ok = false;
    switch (name) {
      case "json-prune":
        ok = installJsonPrune(paths);
        break;
      case "json-prune-fetch-response":
        ok = installJsonPruneFetch(paths);
        break;
      case "json-prune-xhr-response":
        ok = installJsonPruneXhr(paths);
        break;
      case "set-constant":
      case "set":
        ok = setConstant(args[0], constantFrom(String(args[1] ?? "")));
        break;
      default:
        // An unknown scriptlet is a rule for a scriptlet this engine does not
        // implement. Say so rather than failing silently, but carry on.
        console.warn(LOG, `unknown scriptlet: ${name}`);
        break;
    }

    if (ok) applied.push(name);
  }

  if (applied.length > 0) {
    console.info(LOG, `installed on ${location.hostname}:`, applied.join(", "));
  }
})();
