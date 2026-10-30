#!/bin/sh
# aider lint hook (--lint-cmd "typescript: .claude/bin/tsc-lint.sh").
# Runs the whole-project typecheck, prints only errors in the files aider passes,
# plus fix hints. Exit 1 makes aider show the errors to the model and retry.
# The output is sent back to the model on every retry inside an attempt, together with the
# chat so far, so it is kept short (it overflowed the 16k window on 2026-10-29): one line per
# distinct error (same code and message counted once, with its lines), at most LINT_MAX
# (default 8), messages cut to 160 characters.
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
total=$(printf '%s\n' "$errs" | grep -c .)
printf '%s\n' "$errs" | python3 -c '
import re, sys
seen, order = {}, []
for line in sys.stdin:
    m = re.match(r"^(\S+?)\((\d+),\d+\): error (TS\d+): (.*)$", line.strip())
    if not m:
        continue
    f, ln, code, msg = m.groups()
    key = (f, code, msg)
    if key not in seen:
        seen[key] = []
        order.append(key)
    seen[key].append(ln)
limit = int(sys.argv[1])
for f, code, msg in order[:limit]:
    lines = seen[(f, code, msg)]
    at = ",".join(lines[:4]) + ("..." if len(lines) > 4 else "")
    print("%s(%s): error %s: %s" % (f, at, code, msg[:160]))
if len(order) > limit:
    print("... %d more distinct errors; fix these first." % (len(order) - limit))
' "${LINT_MAX:-8}"
[ "$total" -gt 0 ] && echo "($total error lines in total)"
printf '%s\n' "$errs" | "$root/.claude/bin/hints.sh" | head -5
exit 1
