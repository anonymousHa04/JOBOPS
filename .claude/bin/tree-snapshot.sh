#!/bin/sh
# Boundary checks for a coder run (R0.4).
#   tree-snapshot.sh snap <out.json>
#       Record every modified, deleted, or untracked (not ignored) file with a
#       content hash.
#   tree-snapshot.sh diff <before.json> <after.json> [allowed-file]...
#       Print each file that changed between the snapshots, then "OUTSIDE: <f>"
#       for each changed file not in the allowed list. Exit 1 if any is outside.
set -u
cd "$(git rev-parse --show-toplevel)"
mode=$1; shift
case "$mode" in
snap)
  git status --porcelain=v1 -z -uall | python3 -c '
import hashlib, json, os, sys
data = sys.stdin.buffer.read().split(b"\0")
files, i = {}, 0
while i < len(data):
    e = data[i].decode()
    i += 1
    if len(e) < 4:
        continue
    code, path = e[:2], e[3:]
    if "R" in code or "C" in code:
        i += 1  # rename/copy: the next entry is the old path
    if os.path.isfile(path):
        files[path] = hashlib.sha1(open(path, "rb").read()).hexdigest()
    else:
        files[path] = "deleted"
json.dump(files, open(sys.argv[1], "w"), indent=0, sort_keys=True)
' "$1"
  ;;
diff)
  before=$1; after=$2; shift 2
  python3 -c '
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
allowed = set(sys.argv[3:])
changed = sorted(p for p in set(a) | set(b) if a.get(p) != b.get(p))
outside = [p for p in changed if p not in allowed]
for p in changed:
    print(p)
for p in outside:
    print("OUTSIDE: " + p)
sys.exit(1 if outside else 0)
' "$before" "$after" "$@"
  ;;
*) echo "usage: tree-snapshot.sh snap <out> | diff <before> <after> [allowed]..." >&2; exit 2 ;;
esac
