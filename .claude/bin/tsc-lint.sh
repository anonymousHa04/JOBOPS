#!/bin/sh
# aider lint hook (--lint-cmd "typescript: .claude/bin/tsc-lint.sh").
# Runs the whole-project typecheck, prints only errors in the files aider passes,
# plus fix hints. Exit 1 makes aider show the errors to the model and retry.
set -u
root=$(git rev-parse --show-toplevel)
cd "$root"
out=$(npx tsc -p . 2>&1)
errs=""
for f in "$@"; do
  rel=${f#"$root/"}
  errs="$errs$(printf '%s\n' "$out" | grep -F -- "$rel(")
"
done
errs=$(printf '%s' "$errs" | sed '/^$/d')
[ -z "$errs" ] && exit 0
printf '%s\n' "$errs" | head -20
printf '%s\n' "$errs" | "$root/.claude/bin/hints.sh"
exit 1
