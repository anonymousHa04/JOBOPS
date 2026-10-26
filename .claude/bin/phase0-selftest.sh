#!/bin/sh
# Phase 0 acceptance test (agentManagementAndFeedbackSystem.md §3): every way a
# task can go wrong must be reported as a failure, never as a pass.
# Runs autofix.sh with a fake coder in a throwaway worktree of HEAD; the main
# tree is never touched. Usage: phase0-selftest.sh   Exit 0 = all scenarios OK.
set -u
bin=$(cd "$(dirname "$0")" && pwd)
root=$(git rev-parse --show-toplevel)
wt="$root/../jobops-phase0-selftest"

cleanup() {
  rm -f "$wt/node_modules"
  git -C "$root" worktree remove --force "$wt" 2>/dev/null || true
}
cleanup
git -C "$root" worktree add -q --detach "$wt" HEAD
trap cleanup EXIT
ln -s "$root/node_modules" "$wt/node_modules"
cd "$wt"

mkdir -p .agent-logs
ok=0; bad=0
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e .agent-logs; }

# scenario <name> <expected-status> <file> [env assignments...]
scenario() {
  name=$1; want=$2; file=$3; shift 3
  reset
  env CODER_TIMEOUT=60 FIRST_RUNNER=fake COMMIT=0 "$@" \
    "$bin/autofix.sh" "st-$name" /dev/null "$file" > ".agent-logs/st-$name.out" 2>&1
  rc=$?
  got=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
    ".agent-logs/st-$name.result.json" 2>/dev/null || echo missing)
  why=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["reason"] or "")' \
    ".agent-logs/st-$name.result.json" 2>/dev/null)
  # A pass must exit 0; everything else must exit non-zero.
  exit_ok=1
  if [ "$want" = passed ]; then [ "$rc" = 0 ] || exit_ok=0; else [ "$rc" != 0 ] || exit_ok=0; fi
  if [ "$got" = "$want" ] && [ "$exit_ok" = 1 ]; then
    ok=$((ok + 1)); echo "OK    $name: $got${why:+ ($why)}"
  else
    bad=$((bad + 1)); echo "WRONG $name: want $want, got $got (autofix exit $rc)${why:+ ($why)}"
  fi
}

F=api/src/selftest.ts
T=api/test/selftest.test.ts
scenario pass             passed    "$F" FAKE_ACTION="printf 'export const x = 1;\n' > $F"
scenario coder-exit       failed    "$F" FAKE_ACTION="printf 'export const x = 1;\n' > $F; exit 3"
scenario exit-unknown     unknown   "$F" FAKE_NO_EXIT=1 FAKE_ACTION="printf 'export const x = 1;\n' > $F"
scenario type-error       failed    "$F" FAKE_ACTION="printf 'export const x: number = \"a\";\n' > $F"
scenario failing-test     failed    "$T" FAKE_ACTION="printf 'import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"fails\", () => assert.equal(1, 2));\n' > $T"
scenario timeout          timed_out "$F" CODER_TIMEOUT=3 FAKE_ACTION="sleep 30"
scenario no-change        failed    "$F" FAKE_ACTION="true"
scenario outside-boundary failed    "$F" FAKE_ACTION="printf 'export const x = 1;\n' > $F; printf 'export const y = 2;\n' > api/src/other.ts"
scenario tsc-silent-crash failed    "$F" TSC_CMD="exit 2" FAKE_ACTION="printf 'export const x = 1;\n' > $F"
scenario no-test-summary  failed    "$F" TEST_CMD="echo nothing" FAKE_ACTION="printf 'export const x = 1;\n' > $F"

# Invalid patch: must be rejected and leave the tree unchanged; a valid one
# must apply and verify.
reset
printf 'diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-old\n+new\n' > .agent-logs/bad.patch
before=$(git status --porcelain | grep -v '^?? node_modules$')
if "$bin/apply-patch.sh" "$wt" .agent-logs/bad.patch > /dev/null 2>&1; then
  bad=$((bad + 1)); echo "WRONG invalid-patch: applied"
elif [ "$(git status --porcelain | grep -v '^?? node_modules$')" != "$before" ]; then
  bad=$((bad + 1)); echo "WRONG invalid-patch: tree changed"
else
  ok=$((ok + 1)); echo "OK    invalid-patch: rejected, tree unchanged"
fi
printf 'export const z = 3;\n' > api/src/selftest.ts && git add -N api/src/selftest.ts \
  && git diff --binary > .agent-logs/good.patch && git checkout -q -- . && git reset -q && rm -f api/src/selftest.ts
if "$bin/apply-patch.sh" "$wt" .agent-logs/good.patch > /dev/null 2>&1 && [ -f api/src/selftest.ts ]; then
  ok=$((ok + 1)); echo "OK    valid-patch: applied and verified"
else
  bad=$((bad + 1)); echo "WRONG valid-patch: not applied"
fi

echo "phase0-selftest: $ok ok, $bad wrong"
[ "$bad" = 0 ]
