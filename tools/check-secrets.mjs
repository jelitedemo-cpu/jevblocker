#!/usr/bin/env node
/**
 * Refuses to commit anything that looks like a credential.
 *
 * The Jev API key belongs in `chrome.storage` at runtime and in
 * `jev-api-key.txt` while testing -- both of which stay out of git. The way
 * that goes wrong is not a decision, it is a moment: pasting a key into
 * `extension/src/shared.js` to try something, then committing with `-A`.
 *
 * Run by hand:
 *   node tools/check-secrets.mjs          # staged changes
 *   node tools/check-secrets.mjs --all    # every tracked file
 *
 * Exit 0 clean, 1 on a finding. Deliberately pattern-based and narrow: a check
 * that cries wolf gets bypassed with --no-verify, and then it protects nothing.
 */
import { execFileSync } from "node:child_process";

const PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  {
    // The one that actually catches the paste-into-source accident.
    name: "assigned secret literal",
    re: /\b(api[_-]?key|apikey|secret|token|password|passwd|bearer)\b\s*[:=]\s*["'`][^"'`\s]{16,}["'`]/i,
  },
];

// Extensions that are credentials by definition. A `.env` is only committed by
// accident, so it counts as one.
const FORBIDDEN_FILES = /(^|\/)\.env(\.|$)|\.(pem|p12|pfx|jks|keystore|ppk)$|(^|\/)id_(rsa|ed25519)$/i;

function git(args, input) {
  return execFileSync("git", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .filter(Boolean);
}

function trackedFiles() {
  return git(["ls-files"]).split("\n").filter(Boolean);
}

function contentOf(file, staged) {
  try {
    // `:path` reads the index, which is what a commit would record -- not the
    // working tree, where the secret might already have been removed.
    return staged ? git(["show", `:${file}`]) : git(["show", `HEAD:${file}`]);
  } catch {
    return "";
  }
}

const all = process.argv.includes("--all");
const files = all ? trackedFiles() : stagedFiles();

if (files.length === 0) {
  console.log("secrets: nothing to check");
  process.exit(0);
}

const findings = [];

for (const file of files) {
  if (FORBIDDEN_FILES.test(file)) {
    findings.push({ file, line: 0, name: "credential file", sample: file });
    continue;
  }

  const text = contentOf(file, !all);
  if (!text) continue;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Long minified rules files are full of base64-ish noise; skip anything
    // absurdly long rather than inventing findings out of a filter list.
    if (line.length > 4000) continue;
    for (const { name, re } of PATTERNS) {
      const match = re.exec(line);
      if (!match) continue;
      findings.push({
        file,
        line: i + 1,
        name,
        // Show enough to find it, never enough to leak it.
        sample: match[0].slice(0, 12) + "…",
      });
      break;
    }
  }
}

if (findings.length === 0) {
  console.log(`secrets: ${files.length} file(s) clean`);
  process.exit(0);
}

console.error(`\nsecrets: ${findings.length} finding(s) -- not committing this.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.name}  (${f.sample})`);
}
console.error(
  "\nIf this is a false positive, re-run with `git commit --no-verify`.\n" +
    "If it is real: take the value out, move it to jev-api-key.txt or the\n" +
    "extension's settings, and rotate it -- anything committed once should be\n" +
    "treated as leaked even if you rewrite the commit.\n"
);
process.exit(1);
