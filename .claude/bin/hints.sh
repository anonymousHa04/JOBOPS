#!/bin/sh
# Print the fix hint for every pattern in .claude/agents/fix-hints.yaml that
# matches the error text on stdin. Prints nothing when no pattern matches.
set -u
hints="$(cd "$(dirname "$0")/../agents" && pwd)/fix-hints.yaml"
errs=$(cat)
awk '/^- match: / { m = substr($0, 10); next }
     /^  hint: / && m != "" { print m "\t" substr($0, 9); m = "" }' \
  "$hints" |
while IFS="$(printf '\t')" read -r pat hint; do
  printf '%s\n' "$errs" | grep -qE -- "$pat" && echo "HINT: $hint"
done
# Known fixes (.claude/knowledge/fixes.jsonl) whose error signature matches:
# the same records the context package and repair specs use, so a fix recorded
# after an escalation also reaches aider's own lint loop. Rejected/outdated skipped.
fixes="$(cd "$(dirname "$0")/../knowledge" && pwd)/fixes.jsonl"
[ -f "$fixes" ] && printf '%s\n' "$errs" | python3 -c '
import json, re, sys
errs = sys.stdin.read()
order = {"regression-tested": 0, "verified": 1, "observed": 2, "hypothesis": 3}
hits = []
for line in open(sys.argv[1]):
    if not line.strip():
        continue
    fx = json.loads(line)
    sig = fx.get("signature")
    if not sig or fx.get("status") in ("rejected", "outdated"):
        continue
    try:
        if re.search(sig, errs):
            hits.append(fx)
    except re.error:
        pass
for fx in sorted(hits, key=lambda f: order.get(f.get("status"), 9))[:3]:
    print("HINT (known fix, %s): %s" % (fx["status"], fx["resolution"]))
' "$fixes"
exit 0
