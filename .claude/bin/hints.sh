#!/bin/sh
# Print the fix hint for every pattern in .claude/agents/fix-hints.yaml that
# matches the error text on stdin. Prints nothing when no pattern matches.
set -u
root=$(git rev-parse --show-toplevel)
errs=$(cat)
awk '/^- match: / { m = substr($0, 10); next }
     /^  hint: / && m != "" { print m "\t" substr($0, 9); m = "" }' \
  "$root/.claude/agents/fix-hints.yaml" |
while IFS="$(printf '\t')" read -r pat hint; do
  printf '%s\n' "$errs" | grep -qE -- "$pat" && echo "HINT: $hint"
done
exit 0
