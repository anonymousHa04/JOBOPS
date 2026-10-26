#!/bin/sh
# Validate the working tree for a finished coder task: edit flags, typecheck,
# tests, Go. Each step is judged by its real exit status; output is parsed
# only for extra detail. Missing output never counts as success.
# Usage: check.sh <task>
#   Report: stdout (at most ~45 lines). Full output: .agent-logs/<task>.check.log
#   Result: .agent-logs/<task>.check.json  {status: passed|failed, steps: {...}}
# Exit 0 = passed, 1 = failed.
# Overrides (self-test): TSC_CMD, TEST_CMD.
set -u

task=$1
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
full=".agent-logs/$task.check.log"
json=".agent-logs/$task.check.json"
bin=$(cd "$(dirname "$0")" && pwd)

# Flags: lines the runners append to the task log when something went wrong.
flags=$(grep -hE 'RUN-(CODER|MINI):' ".agent-logs/$task.log" 2>/dev/null || true)
flags_status=passed; [ -n "$flags" ] && flags_status=failed

# Typecheck: fails on a non-zero exit or any "error TS" line.
tsc=$(sh -c "${TSC_CMD:-npx tsc -p .}" 2>&1); tsc_rc=$?
tsc_n=$(printf '%s\n' "$tsc" | grep -c 'error TS')
tsc_status=passed; { [ "$tsc_rc" -ne 0 ] || [ "$tsc_n" -gt 0 ]; } && tsc_status=failed

# Tests: fails on a non-zero exit, any failure, or no summary line at all.
tests=$(sh -c "${TEST_CMD:-npm test}" 2>&1); test_rc=$?
t_pass=$(printf '%s\n' "$tests" | sed -n 's/^ℹ pass //p' | tail -1)
t_fail=$(printf '%s\n' "$tests" | sed -n 's/^ℹ fail //p' | tail -1)
test_status=passed; test_reason=""
if [ "$test_rc" -ne 0 ]; then test_status=failed; test_reason="exit $test_rc"
elif [ -z "$t_fail" ] || [ -z "$t_pass" ]; then test_status=failed; test_reason="no test summary"
elif [ "$t_fail" != 0 ]; then test_status=failed; test_reason="$t_fail failing"
fi

# Go: vet and test, by exit status.
go_status=not_run; go_rc=""; gocheck=""
if [ -f jd-search/go.mod ]; then
  gocheck=$(cd jd-search && go vet ./... 2>&1 && go test ./... 2>&1); go_rc=$?
  go_status=passed; [ "$go_rc" -ne 0 ] && go_status=failed
fi

status=passed
for s in "$flags_status" "$tsc_status" "$test_status" "$go_status"; do
  [ "$s" = failed ] && status=failed
done

{ echo "== flags"; echo "$flags"; echo "== typecheck (exit $tsc_rc)"; echo "$tsc"
  echo "== tests (exit $test_rc)"; echo "$tests"; echo "== go (exit ${go_rc:-n/a})"; echo "$gocheck"; } > "$full"

TASK=$task STATUS=$status FLAGS=$flags FLAGS_STATUS=$flags_status \
TSC_STATUS=$tsc_status TSC_RC=$tsc_rc TSC_N=$tsc_n \
TEST_STATUS=$test_status TEST_RC=$test_rc T_PASS=${t_pass:-} T_FAIL=${t_fail:-} TEST_REASON=$test_reason \
GO_STATUS=$go_status GO_RC=${go_rc:-} python3 -c '
import json, os
e = os.environ
num = lambda v: int(v) if v.strip().lstrip("-").isdigit() else None
print(json.dumps({
  "task": e["TASK"], "status": e["STATUS"],
  "steps": {
    "flags": {"status": e["FLAGS_STATUS"], "items": [l for l in e["FLAGS"].splitlines() if l]},
    "typecheck": {"status": e["TSC_STATUS"], "exit": num(e["TSC_RC"]), "errors": num(e["TSC_N"])},
    "tests": {"status": e["TEST_STATUS"], "exit": num(e["TEST_RC"]), "pass": num(e["T_PASS"]),
              "fail": num(e["T_FAIL"]), "reason": e["TEST_REASON"] or None},
    "go": {"status": e["GO_STATUS"], "exit": num(e["GO_RC"])},
  }}, indent=2))' > "$json"

if [ "$status" = passed ]; then
  echo "RESULT: PASS ($task): typecheck clean, ${t_pass} tests passed"
  exit 0
fi

echo "RESULT: FAIL ($task)"
[ -n "$flags" ] && echo "$flags"
if [ "$tsc_status" = failed ]; then
  echo "typecheck: exit $tsc_rc, $tsc_n errors"
  printf '%s\n' "$tsc" | grep 'error TS' | head -10
  [ "$tsc_n" -eq 0 ] && printf '%s\n' "$tsc" | tail -3
fi
echo "tests: ${t_pass:-?} passed, ${t_fail:-?} failed${test_reason:+ ($test_reason)}"
[ "$go_status" = failed ] && printf '%s\n' "$gocheck" | grep -E 'FAIL|\.go:[0-9]+' | head -10
printf '%s\n%s\n' "$tsc" "$tests" | "$bin/hints.sh" | head -5
printf '%s\n' "$tests" \
  | awk '/^✖ failing tests:/ { on = 1; next } on' \
  | grep -E '^test at|^✖|Error|!==|expected|actual|\.test\.ts:[0-9]+' \
  | grep -v 'node:internal' \
  | head -30
exit 1
