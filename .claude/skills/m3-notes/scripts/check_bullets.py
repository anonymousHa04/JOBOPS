#!/usr/bin/env python3
"""Check drafted resume bullets against the M3 rules.

Usage:
    python check_bullets.py bullets.yaml        (or .json)

Input: a list of entries, each with at least `id` and `text`; optional `evidence`
(the facts as the user stated them, or the original resume line) and `source`.
The role is taken from the id prefix before the first '-' (e.g. `sde3-collab`).

Prints issue codes per bullet, never rewrites. Exit code 1 if any bullet has issues.
"""
import json
import re
import sys
from collections import Counter, defaultdict

MAX_WORDS = 25
MAX_METRIC_LED_PER_ROLE = 2
SAME_OPENER_SHARE = 0.4

# Scope ladder, low -> high. Stems match verb forms (lead/led/leading).
LADDER = [
    [r"assist", r"support", r"contribut", r"help"],
    [r"buil[td]", r"develop", r"implement", r"wr[io]te", r"add", r"integrat", r"migrat"],
    [r"design", r"own", r"drove", r"driv"],
    [r"lead", r"led\b", r"architect", r"spearhead", r"head"],
]
SCOPE_PHRASES = re.compile(
    r"\b(team of \d+|company-wide|org-wide|single-handedly|end-to-end)\b", re.I)
PLANNED = re.compile(r"\b(planned|planning|will|working on|in progress|going to)\b", re.I)
SOFT = re.compile(
    r"\b(team player|hard[- ]working|detail[- ]oriented|passionate|excellent communication|"
    r"strong communicator|synergy|go-getter)\b", re.I)
NUMBER = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|x|k|m|lpa|ms|s)?", re.I)


def load(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    if path.endswith(".json"):
        return json.loads(raw)
    try:
        import yaml  # type: ignore
    except ImportError:
        sys.exit("PyYAML not installed: pip install pyyaml, or pass a .json file")
    return yaml.safe_load(raw)


def numbers(text):
    return {re.sub(r"\s+", "", n.lower()).rstrip(".,") for n in NUMBER.findall(text or "")}


def bare(n):
    return re.sub(r"[^\d.]", "", n)


def rank(text):
    best = -1
    for level, stems in enumerate(LADDER):
        if any(re.search(r"\b" + s, text, re.I) for s in stems):
            best = level
    return best


def check(entry):
    text = entry.get("text", "")
    evidence = entry.get("evidence") or ""
    issues = []

    if len(text.split()) > MAX_WORDS:
        issues.append(f"too_long ({len(text.split())} words)")

    if evidence:
        ev_bare = {bare(n) for n in numbers(evidence)}
        added = sorted(n for n in numbers(text) if bare(n) and bare(n) not in ev_bare)
        if added:
            issues.append(f"number_not_in_evidence {added}")
        if rank(text) > rank(evidence) >= 0:
            issues.append("scope_raised (verb above evidence)")
        if SCOPE_PHRASES.search(text) and not SCOPE_PHRASES.search(evidence):
            issues.append("scope_phrase_added")
    else:
        issues.append("no_evidence (cannot verify numbers or scope)")

    if PLANNED.search(text):
        issues.append("planned_work")
    if SOFT.search(text):
        issues.append("soft_skill_filler")
    return issues


def metric_led(text):
    first = " ".join(text.split()[:6])
    return bool(re.search(r"\d", first))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    entries = load(sys.argv[1]) or []
    any_issue = False

    for e in entries:
        issues = check(e)
        any_issue |= bool(issues)
        status = "OK" if not issues else "; ".join(issues)
        print(f"{e.get('id', '?')}: {status}")

    # Cross-bullet checks
    openers = Counter((e.get("text", "").split() or [""])[0].lower() for e in entries)
    if entries:
        verb, count = openers.most_common(1)[0]
        if count / len(entries) > SAME_OPENER_SHARE and len(entries) >= 4:
            any_issue = True
            print(f"[all]: repeated_opener '{verb}' starts {count}/{len(entries)} bullets")

    per_role = defaultdict(int)
    for e in entries:
        if metric_led(e.get("text", "")):
            per_role[str(e.get("id", "")).split("-")[0]] += 1
    for role, n in per_role.items():
        if n > MAX_METRIC_LED_PER_ROLE:
            any_issue = True
            print(f"[{role}]: too_many_metric_led ({n} > {MAX_METRIC_LED_PER_ROLE})")

    sys.exit(1 if any_issue else 0)


if __name__ == "__main__":
    main()
