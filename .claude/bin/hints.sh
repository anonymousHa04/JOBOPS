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
exit 0
