#!/bin/sh
# Compact pass/fail report for a finished coder task: edit flags, typecheck, tests.
# Usage: check.sh <task>      Full output: .agent-logs/<task>.check.log
# Exit 0 = PASS, 1 = FAIL. Prints at most ~45 lines.
set -u

task=$1
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
full=".agent-logs/$task.check.log"
fail=0

flags=$(grep -hE 'RUN-(CODER|MINI):' ".agent-logs/$task.log" 2>/dev/null || true)
[ -n "$flags" ] && fail=1

tsc=$(npx tsc -p . 2>&1)
tsc_n=$(printf '%s\n' "$tsc" | grep -c 'error TS')
[ "$tsc_n" -gt 0 ] && fail=1

tests=$(npm test 2>&1)
t_pass=$(printf '%s\n' "$tests" | sed -n 's/^ℹ pass //p')
t_fail=$(printf '%s\n' "$tests" | sed -n 's/^ℹ fail //p')
[ "${t_fail:-1}" = 0 ] || fail=1

{ echo "== typecheck"; echo "$tsc"; echo "== tests"; echo "$tests"; } > "$full"

if [ "$fail" = 0 ]; then
  echo "RESULT: PASS ($task): typecheck clean, ${t_pass} tests passed"
  exit 0
fi

echo "RESULT: FAIL ($task)"
[ -n "$flags" ] && echo "$flags"
if [ "$tsc_n" -gt 0 ]; then
  echo "typecheck: $tsc_n errors"
  printf '%s\n' "$tsc" | grep 'error TS' | head -10
fi
echo "tests: ${t_pass:-?} passed, ${t_fail:-?} failed"
printf '%s\n' "$tests" \
  | awk '/^✖ failing tests:/ { on = 1; next } on' \
  | grep -E '^test at|^✖|Error|!==|expected|actual|\.test\.ts:[0-9]+' \
  | grep -v 'node:internal' \
  | head -30
exit 1
