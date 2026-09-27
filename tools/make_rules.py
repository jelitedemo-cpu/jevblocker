"""Generates the extension's declarativeNetRequest rules from the curated
blocklist that the Android app ships.

Keeping one source of truth means the two clients block the same domains.
Run from the project root:

    python tools/make_rules.py
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BLOCKLIST = ROOT / "app" / "src" / "main" / "assets" / "blocklist.txt"
RULES_DIR = ROOT / "extension" / "rules"

# Resource types for third-party ad and tracker requests. main_frame is
# deliberately excluded: blocking a top-level navigation is a much heavier
# hammer, so it lives in the redirects ruleset where it can be toggled apart.
RESOURCE_TYPES = [
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "csp_report",
    "media",
    "websocket",
    "other",
]

# Domains whose whole purpose is to bounce you somewhere else. These are the
# hops in a redirect chain, so they are blocked on navigation.
REDIRECT_DOMAINS = [
    "adf.ly",
    "sh.st",
    "shorte.st",
    "bc.vc",
    "ouo.io",
    "adfoc.us",
    "exe.io",
    "shrink.me",
    "shrinkearn.com",
    "linkbucks.com",
    "clk.sh",
    "fc.lc",
    "gplinks.in",
    "za.gl",
    "cuty.io",
    "linkvertise.com",
    "linkvertise.net",
    "up-to-down.net",
    "sub2unlock.com",
    "boost.ink",
    "social-unlock.com",
    "propellerads.com",
    "popads.net",
    "popcash.net",
    "adsterra.com",
]


def read_domains():
    if not BLOCKLIST.exists():
        sys.exit(f"blocklist not found: {BLOCKLIST}")

    domains = []
    for raw in BLOCKLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        comment = line.find("#")
        if comment >= 0:
            line = line[:comment].strip()
        if not line:
            continue
        parts = line.split()
        host = parts[1] if len(parts) >= 2 else parts[0]
        host = host.lower().lstrip("*.").rstrip(".")
        if "." not in host or len(host) < 4:
            continue
        if any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-_" for ch in host):
            continue
        if host not in domains:
            domains.append(host)
    return domains


def write_rules(path, entries):
    rules = []
    for index, (domain, resource_types) in enumerate(entries, start=1):
        rules.append(
            {
                "id": index,
                "priority": 1,
                "action": {"type": "block"},
                "condition": {
                    "urlFilter": f"||{domain}^",
                    "resourceTypes": resource_types,
                },
            }
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
    return len(rules)


def main():
    domains = read_domains()

    ad_entries = [(domain, RESOURCE_TYPES) for domain in domains]
    ad_count = write_rules(RULES_DIR / "ads.json", ad_entries)

    redirect_entries = []
    for domain in REDIRECT_DOMAINS:
        redirect_entries.append((domain, ["main_frame", "sub_frame"]))
    # A top-level navigation straight to an ad host is almost always a redirect
    # chain that resolved, so those are blocked on navigation too.
    for domain in domains:
        if domain in REDIRECT_DOMAINS:
            continue
        redirect_entries.append((domain, ["main_frame"]))
    redirect_count = write_rules(RULES_DIR / "redirects.json", redirect_entries)

    print(f"blocklist domains : {len(domains)}")
    print(f"ads.json          : {ad_count} rules")
    print(f"redirects.json    : {redirect_count} rules")

    total = ad_count + redirect_count
    if total > 30_000:
        sys.exit(f"too many static rules ({total}); Chrome guarantees 30,000")


if __name__ == "__main__":
    main()
