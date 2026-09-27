#!/usr/bin/env python3
"""
Compile Adblock Plus filter lists into Chrome declarativeNetRequest rulesets.

This replaces the hand-curated 143-domain blocklist with the same community
lists Brave and uBlock Origin use. Chrome's `urlFilter` syntax is deliberately
ABP-compatible -- `||ads.example.com^` is valid in both -- so most filters
transfer nearly verbatim. The work is in the options: `$third-party`,
`$script`, `$domain=` and `@@` exceptions all need mapping onto DNR fields.

Two Chrome limits shape the output:

  * The guaranteed static-rule floor is 30,000, shared across all installed
    extensions. This machine grants 330,000, but that is not contractual, so
    rules are chunked into separate rulesets that can be dropped from the end
    if the budget runs short. See background.js.
  * A `regexFilter` over 2KB once compiled is skipped *silently*. `urlFilter`
    has no such limit, so regexes are used only where there is no alternative
    and are capped hard.

Usage:
    python tools/compile_filters.py                # full rebuild
    python tools/compile_filters.py --no-download  # use the cache only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "lists"
RULES_DIR = ROOT / "extension" / "rules"
COSMETIC_DIR = ROOT / "extension" / "cosmetic"

LISTS = [
    ("easylist", "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy", "https://easylist.to/easylist/easyprivacy.txt"),
]

# Rules per emitted ruleset. Small enough that losing one from the end costs
# little, large enough to stay well under the 100-ruleset manifest ceiling.
CHUNK_SIZE = 12_000

# Hard ceilings. Deliberately below Chrome's numbers so we fail loudly in the
# compiler rather than silently in the browser.
MAX_TOTAL_RULES = 160_000
MAX_REGEX_RULES = 400  # Chrome allows 1000; leave headroom for other extensions.
MAX_URLFILTER_LEN = 900  # urlFilter is exempt from the 2KB regex cap, but keep it sane.

# ---------------------------------------------------------------------------
# Option mapping
# ---------------------------------------------------------------------------

# ABP resource type -> DNR ResourceType. Types absent here have no DNR
# equivalent and cause the whole filter to be skipped.
TYPE_MAP = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "object": "object",
    "xmlhttprequest": "xmlhttprequest",
    "subdocument": "sub_frame",
    "document": "main_frame",
    "ping": "ping",
    "beacon": "ping",
    "websocket": "websocket",
    "media": "media",
    "font": "font",
    "other": "other",
    "popup": "main_frame",
    "csp_report": "csp_report",
    "object-subrequest": "object",
    "webbundle": "webbundle",
}

ALL_DNR_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
    "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
    "other",
]
# `webtransport` and `webbundle` exist in newer Chrome but not in the 116
# baseline this extension declares. A rule naming an unsupported type is
# rejected whole, so they are left out rather than risk it.

DNR_ACTIONS = {"block", "allow", "allowAllRequests", "redirect", "upgradeScheme", "modifyHeaders"}
DNR_DOMAIN_TYPES = {"firstParty", "thirdParty"}

# Options that cannot be expressed. A filter carrying one is dropped whole,
# because dropping just the option would over-block.
UNSUPPORTED_OPTIONS = {
    "csp", "redirect", "redirect-rule", "inline-script", "inline-font",
    "webrtc", "genericblock", "generichide", "elemhide", "specifichide",
    "empty", "mp4", "set-cookie", "permissions", "header", "urltransform",
    "uritransform", "replace", "removeparam", "removeheader", "cookie",
    "method", "to", "from", "reason", "denyallow", "strict1p", "strict3p",
    "inline-script", "ghide", "shide", "ehide",
}

# Recognised but deliberately ignored rather than fatal.
IGNORED_OPTIONS = {"match-case", "collapse", "donottrack", "important", "all"}

RESOURCE_TYPE_OPTIONS = set(TYPE_MAP.keys())

DOMAIN_RE = re.compile(r"^[a-z0-9.\-*]+$", re.IGNORECASE)

# Chrome validates initiatorDomains as hostnames. EasyList contains entries that
# are not -- `wayfair.*` from a wildcard scope, `[::1]` and `[::]` from IPv6
# literals -- and a rule carrying one is rejected outright rather than having
# the bad entry ignored. Measured: filters-05 and filters-07 each lost rules
# this way.
HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)"
    r"[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*$",
    re.IGNORECASE,
)


def is_hostname(value: str) -> bool:
    return bool(HOSTNAME_RE.match(value))


@dataclass
class Stats:
    seen: int = 0
    converted: int = 0
    regex: int = 0
    dropped: int = 0
    deduplicated: int = 0
    reasons: dict = field(default_factory=dict)

    def drop(self, why: str) -> None:
        self.dropped += 1
        self.reasons[why] = self.reasons.get(why, 0) + 1


@dataclass
class Rule:
    """A compiled DNR rule plus the filter it came from, for diagnostics."""

    rule: dict
    source: str


# ---------------------------------------------------------------------------
# Filter parsing
# ---------------------------------------------------------------------------


def is_ascii(value: str) -> bool:
    return all(ord(c) < 128 for c in value)


def split_filter(text: str) -> tuple[str, list[str]]:
    """Split a filter into its pattern and its option list.

    Only the last `$` separates options; earlier ones may be literal.
    """
    if "$" not in text:
        return text, []
    head, _, tail = text.rpartition("$")
    if not head:
        return text, []
    # A `$` inside a regex literal is not an option separator.
    if head.startswith("/") and not head.endswith("/"):
        return text, []
    return head, [o for o in tail.split(",") if o]


def convert_pattern(pattern: str, stats: Stats, source: str) -> dict | None:
    """Turn an ABP pattern into DNR filter fields (urlFilter or regexFilter)."""
    if not pattern:
        stats.drop("empty-pattern")
        return None

    if not is_ascii(pattern):
        stats.drop("non-ascii")
        return None

    # Raw regexes are NOT emitted.
    #
    # Chrome compiles every regexFilter against a 2KB memory budget and drops
    # any that exceed it -- silently. Measured with
    # chrome.declarativeNetRequest.isRegexSupported(): 15 of the 29 regexes
    # EasyList produces were rejected with `memoryLimitExceeded`, and those
    # rules simply vanished from the ruleset. The failure is invisible: the
    # ruleset still reports itself enabled and nothing logs a warning.
    #
    # This is the same limit that hid in the tracking-parameter rules earlier in
    # this project, so it has now cost real debugging time twice. Regexes are 29
    # of 115,000 filters, and they are the only rule class whose validity cannot
    # be established without a browser -- so rather than ship rules that may or
    # may not exist, none are shipped. tools/check-regexes.mjs asserts this
    # stays true.
    if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
        stats.drop("regex-not-emitted")
        return None

    if len(pattern) > MAX_URLFILTER_LEN:
        stats.drop("pattern-too-long")
        return None

    # A wildcard in the host portion has no clean urlFilter equivalent.
    host_part = pattern
    for prefix in ("||", "|"):
        if host_part.startswith(prefix):
            host_part = host_part[len(prefix):]
            break
    host_part = host_part.split("/")[0].split("^")[0]
    if "*" in host_part:
        stats.drop("host-wildcard")
        return None

    return {"urlFilter": pattern}


def convert_filter(text: str, is_exception: bool, stats: Stats) -> Rule | None:
    """Convert one ABP network filter into a DNR rule, or None."""
    stats.seen += 1
    source = ("@@" if is_exception else "") + text

    pattern, options = split_filter(text)

    rule: dict = {}

    # --- pattern -----------------------------------------------------------
    pattern_fields = convert_pattern(pattern, stats, source)
    if pattern_fields is None:
        return None
    rule.update(pattern_fields)

    # --- options -----------------------------------------------------------
    domain_type = None
    resource_types: list[str] = []
    excluded_types: list[str] = []
    initiator_domains: list[str] = []
    excluded_initiator_domains: list[str] = []
    is_important = False
    document_exception = False

    for option in options:
        negated = option.startswith("~")
        name = option[1:] if negated else option

        if name == "important" and not negated:
            is_important = True
            continue
        if name in IGNORED_OPTIONS:
            continue

        # Options carrying a value (`redirect=noopjs`, `removeparam=utm_x`) must
        # be matched on the part before the `=`, or they fall through to the
        # catch-all below and get mislabelled as unknown.
        base_name = name.split("=", 1)[0]
        if base_name in UNSUPPORTED_OPTIONS:
            stats.drop(f"unsupported-option:{base_name}")
            return None

        if name == "third-party":
            domain_type = "firstParty" if negated else "thirdParty"
            continue
        if name == "first-party":
            domain_type = "thirdParty" if negated else "firstParty"
            continue

        if name.startswith("domain="):
            for entry in name[len("domain="):].split("|"):
                entry = entry.strip().lower()
                if not entry:
                    continue
                negated_entry = entry.startswith("~")
                host = entry[1:] if negated_entry else entry
                if not is_hostname(host):
                    # Dropping just this entry would quietly widen or narrow the
                    # rule, so the whole filter goes.
                    stats.drop(f"invalid-domain:{host[:40]}")
                    return None
                if negated_entry:
                    excluded_initiator_domains.append(host)
                else:
                    initiator_domains.append(host)
            continue

        if name in RESOURCE_TYPE_OPTIONS:
            dnr_type = TYPE_MAP[name]
            if negated:
                if dnr_type not in excluded_types:
                    excluded_types.append(dnr_type)
            else:
                if dnr_type not in resource_types:
                    resource_types.append(dnr_type)
                if is_exception and dnr_type == "main_frame":
                    document_exception = True
            continue

        stats.drop(f"unknown-option:{name}")
        return None

    # --- action and priority ----------------------------------------------
    if is_exception:
        # $document on an exception means "stop filtering this whole document
        # and everything it loads", which is exactly allowAllRequests.
        if document_exception:
            rule["action"] = {"type": "allowAllRequests"}
            rule["resourceTypes"] = ["main_frame"]
        else:
            rule["action"] = {"type": "allow"}
        rule["priority"] = 3 if is_important else 2
    else:
        rule["action"] = {"type": "block"}
        rule["priority"] = 4 if is_important else 1

    # --- resource types ----------------------------------------------------
    if "resourceTypes" not in rule:
        if resource_types:
            rule["resourceTypes"] = resource_types
        elif excluded_types:
            # Everything except the negated types.
            rule["resourceTypes"] = [t for t in ALL_DNR_TYPES if t not in excluded_types]
        else:
            # No type stated means all types, which is what DNR defaults to.
            pass

    if domain_type:
        rule["condition_domainType"] = domain_type
    if initiator_domains:
        rule["condition_initiatorDomains"] = initiator_domains
    if excluded_initiator_domains:
        rule["condition_excludedInitiatorDomains"] = excluded_initiator_domains

    stats.converted += 1
    return Rule(rule=rule, source=source)


def finalise(item: Rule, rule_id: int) -> dict:
    """Flatten the intermediate form into the shape declarativeNetRequest wants."""
    rule = item.rule
    condition: dict = {}

    for key in ("urlFilter", "regexFilter"):
        if key in rule:
            condition[key] = rule[key]

    if "condition_domainType" in rule:
        condition["domainType"] = rule["condition_domainType"]
    if "condition_initiatorDomains" in rule:
        condition["initiatorDomains"] = rule["condition_initiatorDomains"]
    if "condition_excludedInitiatorDomains" in rule:
        condition["excludedInitiatorDomains"] = rule["condition_excludedInitiatorDomains"]

    out: dict = {"id": rule_id, "priority": rule["priority"], "action": rule["action"]}
    if "resourceTypes" in rule:
        out["condition"] = {**condition, "resourceTypes": rule["resourceTypes"]}
    else:
        out["condition"] = condition
    return out


# ---------------------------------------------------------------------------
# List handling
# ---------------------------------------------------------------------------


def fetch(name: str, url: str, allow_download: bool) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}.txt"

    if path.exists():
        text = path.read_text(encoding="utf-8", errors="replace")
        print(f"  {name:<14} cached   {len(text) // 1024:>6} KB")
        return text

    if not allow_download:
        raise SystemExit(f"No cached copy of {name} and --no-download was given.")

    print(f"  {name:<14} fetching ...", end="", flush=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        text = response.read().decode("utf-8", errors="replace")
    path.write_text(text, encoding="utf-8")
    print(f"\r  {name:<14} fetched  {len(text) // 1024:>6} KB")
    return text


def compile_network(lists: dict[str, str]) -> tuple[list[Rule], Stats]:
    stats = Stats()
    items: list[Rule] = []
    seen_sources: set[str] = set()

    for name, text in lists.items():
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("!") or line.startswith("["):
                continue
            if "##" in line or "#@#" in line or "#?#" in line or "#$#" in line:
                continue  # cosmetic, handled elsewhere

            is_exception = line.startswith("@@")
            body = line[2:] if is_exception else line

            # `badfilter` disables another filter; it is not a rule itself.
            if body.endswith("$badfilter") or "$badfilter," in body:
                continue

            item = convert_filter(body, is_exception, stats)
            if item is None:
                continue
            if item.source in seen_sources:
                continue
            seen_sources.add(item.source)
            items.append(item)

    # Two different filters can compile to the identical rule -- `$script,image`
    # versus `$image,script`, or filters distinguished only by an option that
    # was ignored. Chrome keeps one, so counting both overstates coverage and
    # makes the ruleset accounting report phantom losses.
    unique: list[Rule] = []
    seen_rules: set[str] = set()
    for item in items:
        key = json.dumps(item.rule, sort_keys=True, separators=(",", ":"))
        if key in seen_rules:
            stats.deduplicated += 1
            continue
        seen_rules.add(key)
        unique.append(item)

    return unique, stats


# ---------------------------------------------------------------------------
# Cosmetic rules
# ---------------------------------------------------------------------------


# uBlock-specific procedural selectors. These need a script engine to evaluate;
# emitting them as plain CSS produces selectors the browser silently drops.
PROCEDURAL_MARKERS = (
    ":style(", ":remove(", ":has-text(", ":matches-", ":watch-attr(",
    ":others(", ":upward(", ":xpath(", ":min-text-length(", ":nth-ancestor(",
    ":if(", ":if-not(", "-abp-", ":contains(",
)


def compile_cosmetic(lists: dict[str, str]) -> tuple[list[str], dict, int]:
    """Split cosmetic rules into generic and per-domain buckets.

    Returns (generic_selectors, domain_selectors, exception_count).
    """
    generic: list[str] = []
    by_domain: dict[str, list[str]] = {}
    exceptions: dict[str, set[str]] = {}
    exception_count = 0

    for text in lists.values():
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("!") or line.startswith("["):
                continue

            if "#?#" in line or "#$#" in line or "+js(" in line:
                continue

            is_exception = "#@#" in line
            if is_exception:
                selector_part, _, selector = line.partition("#@#")
            elif "##" in line:
                selector_part, _, selector = line.partition("##")
            else:
                continue

            selector = selector.strip()
            if not selector or not is_ascii(selector):
                continue
            if len(selector) > 200:
                continue
            if any(marker in selector for marker in PROCEDURAL_MARKERS):
                continue
            # Braces or semicolons would break out of the rule we emit.
            if any(ch in selector for ch in "{};"):
                continue

            if is_exception:
                exception_count += 1
                for domain in selector_part.split(","):
                    domain = domain.strip().lower()
                    if domain:
                        exceptions.setdefault(domain, set()).add(selector)
                continue

            domains = [d.strip().lower() for d in selector_part.split(",") if d.strip()]
            if not domains:
                generic.append(selector)
            else:
                for domain in domains:
                    if domain.startswith("~"):
                        continue  # negated domain scope, rare; skip
                    # `amazon.*` means amazon under any TLD. Stored as
                    # `*.amazon` so the lookup can match it without knowing
                    # which TLDs exist.
                    key = "*." + domain[:-2] if domain.endswith(".*") else domain
                    by_domain.setdefault(key, []).append(selector)

    for domain, selectors in list(by_domain.items()):
        banned = exceptions.get(domain)
        if not banned:
            continue
        by_domain[domain] = [s for s in selectors if s not in banned]

    generic = sorted(set(generic))
    by_domain = {d: sorted(set(s)) for d, s in by_domain.items() if s}

    return generic, by_domain, exception_count


def write_cosmetic(generic: list[str], by_domain: dict, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)

    # Remove output from earlier versions so a stale file cannot linger and be
    # mistaken for current.
    for stale in ("generic.json",):
        path = out_dir / stale
        if path.exists():
            path.unlink()

    # Selectors are comma-joined in batches. Emitting one rule per selector is
    # safer -- a single invalid selector only kills its own rule -- but repeats
    # the 24-byte declaration 13,000 times, costing 368 KB. Batching trades that
    # for a blast radius of COSMETIC_BATCH if a selector is malformed, and
    # tools/chrome-load-extension.mjs verifies the parsed rule count in Chrome
    # so a dropped batch cannot pass unnoticed.
    batch_size = 50
    batches = [
        generic[i:i + batch_size] for i in range(0, len(generic), batch_size)
    ]

    css = [
        "/* Generated by tools/compile_filters.py -- do not edit by hand. */",
        "/* Generic cosmetic filters from EasyList. These apply to every site. */",
        "",
    ]
    for batch in batches:
        css.append(",".join(batch) + "{display:none !important}")
    css.append("")

    (out_dir / "generic.css").write_text("\n".join(css), encoding="utf-8")
    (out_dir / "domains.json").write_text(
        json.dumps(by_domain, separators=(",", ":")), encoding="utf-8"
    )

    return {
        "selectors": len(generic),
        "batches": len(batches),
        "domains": len(by_domain),
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def validate_rule(rule: dict) -> str | None:
    """Return a reason string if Chrome would reject this rule, else None.

    Chrome drops malformed rules quietly in some cases and rejects the whole
    ruleset in others. Neither is acceptable, so nothing invalid is written.
    """
    if not isinstance(rule.get("id"), int) or rule["id"] < 1:
        return "bad-id"
    if not isinstance(rule.get("priority"), int) or rule["priority"] < 1:
        return "bad-priority"

    action = rule.get("action") or {}
    if action.get("type") not in DNR_ACTIONS:
        return "bad-action"

    condition = rule.get("condition")
    if not isinstance(condition, dict):
        return "missing-condition"

    has_url = "urlFilter" in condition
    has_regex = "regexFilter" in condition
    if has_url and has_regex:
        return "both-urlFilter-and-regexFilter"

    if has_url:
        value = condition["urlFilter"]
        if not value:
            return "empty-urlFilter"
        if not is_ascii(value):
            return "non-ascii-urlFilter"
    if has_regex:
        try:
            re.compile(condition["regexFilter"])
        except re.error:
            return "invalid-regex"

    types = condition.get("resourceTypes")
    if types is not None:
        if not types:
            return "empty-resourceTypes"
        for entry in types:
            if entry not in ALL_DNR_TYPES:
                return f"bad-resource-type:{entry}"

    domain_type = condition.get("domainType")
    if domain_type is not None and domain_type not in DNR_DOMAIN_TYPES:
        return f"bad-domainType:{domain_type}"

    if action.get("type") == "allowAllRequests" and types != ["main_frame"]:
        return "allowAllRequests-requires-main_frame-only"

    return None


def write_rulesets(items: list[Rule], out_dir: Path, prefix: str) -> tuple[list[str], Stats]:
    out_dir.mkdir(parents=True, exist_ok=True)

    # Remove any rulesets from a previous run so stale chunks cannot linger.
    for old in out_dir.glob(f"{prefix}-*.json"):
        old.unlink()

    chunks = [items[i:i + CHUNK_SIZE] for i in range(0, len(items), CHUNK_SIZE)]
    names: list[str] = []
    invalid = Stats()
    next_id = 1

    for index, chunk in enumerate(chunks, start=1):
        rules = []
        for offset, item in enumerate(chunk):
            candidate = finalise(item, next_id + offset)
            problem = validate_rule(candidate)
            if problem:
                invalid.drop(problem)
                continue
            rules.append(candidate)
        next_id += len(chunk)

        if not rules:
            continue

        name = f"{prefix}-{index:02d}"
        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
        names.append(name)

    return names, invalid


def write_sizes_module(names: list[str], out_dir: Path) -> Path:
    """Emit the per-ruleset rule counts as an importable module.

    background.js needs these to fit the rulesets into whatever static-rule
    budget Chrome actually grants, which is a guaranteed 30,000 but in practice
    far higher and not contractual.
    """
    sizes = {}
    for name in names:
        path = RULES_DIR / f"{name}.json"
        sizes[name] = len(json.loads(path.read_text(encoding="utf-8")))

    lines = [
        "// Generated by tools/compile_filters.py -- do not edit by hand.",
        "//",
        "// Rule counts per static ruleset. Chrome guarantees only 30,000 static",
        "// rules across all installed extensions, so the extension enables these",
        "// greedily within whatever budget it actually gets.",
        "",
        "export const RULESET_SIZES = {",
    ]
    for name, count in sizes.items():
        lines.append(f'  "{name}": {count},')
    lines.append("};")
    lines.append("")

    path = out_dir / "ruleset-sizes.js"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def check_manifest(names: list[str]) -> list[str]:
    """Report rulesets the compiler produced that the manifest does not declare.

    Drift here is silent: a ruleset missing from the manifest simply never
    loads, and nothing reports it.
    """
    manifest_path = ROOT / "extension" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    declared = {
        entry["id"]
        for entry in manifest.get("declarative_net_request", {}).get("rule_resources", [])
    }
    return [name for name in names if name not in declared]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-download", action="store_true",
                        help="use only cached lists, never touch the network")
    args = parser.parse_args()

    print("")
    print("Filter lists")
    lists = {name: fetch(name, url, not args.no_download) for name, url in LISTS}

    print("")
    print("Network filters")
    items, stats = compile_network(lists)

    if len(items) > MAX_TOTAL_RULES:
        print(f"  WARNING: {len(items)} rules exceeds the {MAX_TOTAL_RULES} ceiling,"
              f" truncating. The tail of the list will be lost.")
        items = items[:MAX_TOTAL_RULES]

    print(f"  filters seen      {stats.seen:>8}")
    print(f"  converted         {stats.converted:>8}")
    print(f"  as regex          {stats.regex:>8}")
    print(f"  dropped           {stats.dropped:>8}")
    print(f"  duplicate rules   {stats.deduplicated:>8}")
    for why, count in sorted(stats.reasons.items(), key=lambda kv: -kv[1])[:12]:
        print(f"      {why:<32} {count:>6}")

    names, invalid = write_rulesets(items, RULES_DIR, "filters")

    if invalid.dropped:
        print("")
        print(f"  rejected by validation  {invalid.dropped}")
        for why, count in sorted(invalid.reasons.items(), key=lambda kv: -kv[1]):
            print(f"      {why:<40} {count:>6}")

    written = sum(
        len(json.loads((RULES_DIR / f"{name}.json").read_text(encoding="utf-8")))
        for name in names
    )

    print("")
    print("Cosmetic filters")
    generic, by_domain, exception_count = compile_cosmetic(lists)
    cosmetic = write_cosmetic(generic, by_domain, COSMETIC_DIR)
    generic_kb = (COSMETIC_DIR / "generic.css").stat().st_size // 1024
    domains_kb = (COSMETIC_DIR / "domains.json").stat().st_size // 1024
    print(f"  generic selectors {cosmetic['selectors']:>8}"
          f"   in {cosmetic['batches']} css rules   ({generic_kb} KB)")
    print(f"  domains covered   {cosmetic['domains']:>8}"
          f"                          ({domains_kb} KB json)")
    print(f"  exceptions        {exception_count:>8}")

    print("")
    print("Output")
    print(f"  {len(names)} rulesets, {written} rules")
    for name in names[:4]:
        size = (RULES_DIR / f"{name}.json").stat().st_size
        print(f"      {name:<16} {size // 1024:>6} KB")
    if len(names) > 4:
        print(f"      ... and {len(names) - 4} more")

    sizes_path = write_sizes_module(names, ROOT / "extension" / "src")
    print(f"  sizes module      {sizes_path.relative_to(ROOT)}")

    missing = check_manifest(names)
    if missing:
        print("")
        print("  MANIFEST OUT OF SYNC -- these rulesets exist but are not declared,")
        print("  so Chrome will never load them:")
        for name in missing:
            print(f"      {name}")
        print("  Add them to declarative_net_request.rule_resources in manifest.json.")

    print("")

    return 0


if __name__ == "__main__":
    sys.exit(main())
