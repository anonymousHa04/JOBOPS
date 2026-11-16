#!/usr/bin/env python3
"""A small editable view of the lessons' terms, so a local coder can tighten them without reading
and rewriting all of fixes.jsonl (16 KB of JSON did not fit a 16k window, 2026-10-29).
  lesson-terms.py export [out]         write {id: [terms]} (default .claude/knowledge/lesson-terms.json)
  lesson-terms.py apply [terms] [dst]  merge the terms into a copy of fixes.jsonl (dst; default: in place)
Only the "terms" of each lesson change; everything else is kept as it is."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXES = os.path.join(HERE, "..", "knowledge", "fixes.jsonl")
TERMS = os.path.join(HERE, "..", "knowledge", "lesson-terms.json")


def rows():
    return [json.loads(l) for l in open(FIXES) if l.strip()]


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "export":
        out = argv[2] if len(argv) > 2 else TERMS
        with open(out, "w") as f:
            f.write("{\n" + ",\n".join("  %s: %s" % (json.dumps(r["id"]), json.dumps(r.get("terms", []))) for r in rows()) + "\n}\n")
        return 0
    if cmd == "apply":
        src = argv[2] if len(argv) > 2 else TERMS
        dst = argv[3] if len(argv) > 3 else FIXES
        terms = json.load(open(src))
        out = []
        for r in rows():
            if r["id"] in terms:
                r["terms"] = terms[r["id"]]
            out.append(r)
        with open(dst, "w") as f:
            f.write("".join(json.dumps(r) + "\n" for r in out))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
