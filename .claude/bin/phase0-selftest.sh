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

mkdir -p .agent-logs/main
# A throwaway fix record for the promotion check (the real fixes.jsonl is never touched).
printf '%s\n' '{"id":"st-string-to-number","status":"observed","title":"Self-test: string assigned to number","signature":"TS2322: Type .string. is not assignable to type .number.","terms":[],"files":["api/src/selftest.ts"],"resolution":"Use a number literal.","evidence":"self-test seed"}' > .agent-logs/fixes.jsonl
ok=0; bad=0
reset() { git checkout -q -- . && git clean -fdq -e node_modules -e .agent-logs; }

# scenario <name> <expected-status> <file> [env assignments...]
scenario() {
  name=$1; want=$2; file=$3; shift 3
  reset
  env CODER_TIMEOUT=60 FIRST_RUNNER=fake FIX_RUNNER=fake MAX_FIXES=0 COMMIT=0 \
    FEEDBACK_MAIN_LOGS="$wt/.agent-logs/main" FEEDBACK_FIXES="$wt/.agent-logs/fixes.jsonl" "$@" \
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
scenario wrong-path       failed    "$F" FAKE_ACTION="mkdir -p api/src/api/src && printf 'export const x = 1;\n' > api/src/api/src/selftest.ts"
scenario tsc-silent-crash failed    "$F" TSC_CMD="exit 2" FAKE_ACTION="printf 'export const x = 1;\n' > $F"
scenario no-test-summary  failed    "$F" TEST_CMD="echo nothing" FAKE_ACTION="printf 'export const x = 1;\n' > $F"

# Phase 3: feedback loop.
BAD="printf 'export const x: number = \"a\";\n' > $F"
GOOD="printf 'export const x = 1;\n' > $F"
OTHER="printf 'export const x: boolean = 3;\n' > $F"
scenario repair-succeeds  passed    "$F" MAX_FIXES=1 FAKE_ACTION="$BAD" FAKE_ACTION_FIX="$GOOD"
scenario repeated-failure failed    "$F" MAX_FIXES=3 FAKE_ACTION="$BAD" FAKE_ACTION_FIX="$BAD"
scenario retry-limit      failed    "$F" MAX_FIXES=1 FAKE_ACTION="$BAD" FAKE_ACTION_FIX="$OTHER"

# Evidence checks over the recorded results (categories, stop reasons,
# escalation records, fix promotion, outcome log).
checks=$(python3 - <<'PY'
import json, os
L = ".agent-logs"
def res(n): return json.load(open(os.path.join(L, "st-%s.result.json" % n)))
def check(name, cond, detail=""):
    print(("OK    " if cond else "WRONG ") + name + (": " + detail if detail else ""))
r = res("repair-succeeds")
check("repair: 2 attempts, first failed, second passed", r["attempts_count"] == 2 and not r["first_attempt_passed"])
check("repair: round 2 was a fresh repair with the matching fix", r["attempts"][1]["strategy"].startswith("repair") and "st-string-to-number" in r["attempts"][1]["fixes_supplied"])
spec = open(os.path.join(L, "st-repair-succeeds-fix1.spec.md")).read()
check("repair spec carries errors + known fix, not the old prompt", "Errors to fix" in spec and "Self-test: string assigned" in spec)
fx = [json.loads(l) for l in open(os.path.join(L, "fixes.jsonl"))][0]
# One lesson file for all scenarios: verified by repair-succeeds, then supplied and failed in
# repeated-failure and retry-limit, so two failed uses demote it to hypothesis.
check("fix promoted with evidence when it helped", "st-repair-succeeds: supplied in st-repair-succeeds-fix1, attempt passed" in fx["evidence"], fx["evidence"][-160:])
check("two failed uses demote the fix to hypothesis", fx["status"] == "hypothesis" and fx.get("applications") == {"supplied": 3, "passed": 1, "failed": 2}, "%s %s" % (fx["status"], fx.get("applications")))
check("no escalation record for a passed task", r["escalation"] is None and not os.path.exists(os.path.join(L, "st-repair-succeeds.escalation.json")))
r = res("repeated-failure")
check("repeated signature stops early (2 of 4 allowed attempts)", r["attempts_count"] == 2 and "repeated failure signature" in (r["reason"] or ""), r["reason"])
e = json.load(open(os.path.join(L, "st-repeated-failure.escalation.json")))
check("escalation record: category, what was tried, next owner", e["category"] == "incorrect_implementation" and len(e["what_was_tried"]) == 2 and e["next_owner"])
r = res("retry-limit")
check("different failure stops at the retry limit", r["attempts_count"] == 2 and "retry limit" in (r["reason"] or ""), r["reason"])
cat = {n: res(n)["category"] for n in ("type-error", "outside-boundary", "timeout", "no-change", "tsc-silent-crash", "no-test-summary", "exit-unknown", "failing-test")}
want = {"type-error": "incorrect_implementation", "outside-boundary": "instruction_violation", "timeout": "model_limitation",
        "no-change": "model_limitation", "tsc-silent-crash": "unreliable_validation", "no-test-summary": "unreliable_validation",
        "exit-unknown": "unreliable_validation", "failing-test": "incorrect_implementation"}
check("out-of-boundary file reverted before the next attempt", "DELETED api/src/other.ts" in open(os.path.join(L, "st-outside-boundary.reverted.txt")).read())
check("target written to a wrong path -> environment (tool), not the agent", res("wrong-path")["category"] == "environment", str(res("wrong-path")["category"]))
check("failure categories (8 scenarios)", cat == want, ", ".join("%s=%s" % kv for kv in cat.items() if want[kv[0]] != kv[1]))
out = [json.loads(l) for l in open(os.path.join(L, "main", "outcomes.jsonl"))]
check("outcome log has one line per task", len(out) == 14, "%d lines" % len(out))
PY
)
printf '%s\n' "$checks"
ok=$((ok + $(printf '%s\n' "$checks" | grep -c '^OK')))
bad=$((bad + $(printf '%s\n' "$checks" | grep -c '^WRONG')))

# mini sandbox temp-file filter (run-mini.sh): drops *.tmp/*.bak/*.orig/*~, keeps real files.
reset
printf 'x\n' > api/src/db.ts.tmp; printf 'x\n' > api/src/keep.ts; printf 'x\n' > api/src/a.bak
temps=$(git ls-files --others --exclude-standard -- '*.tmp' '*.bak' '*.orig' '*~' '*.swp' ':!node_modules')
printf '%s\n' "$temps" | xargs rm -f
if [ ! -e api/src/db.ts.tmp ] && [ ! -e api/src/a.bak ] && [ -e api/src/keep.ts ]; then
  ok=$((ok + 1)); echo "OK    mini temp files dropped, real files kept"
else
  bad=$((bad + 1)); echo "WRONG mini temp-file filter"
fi

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

echo "selftest (phase 0 + 3): $ok ok, $bad wrong"
[ "$bad" = 0 ]
