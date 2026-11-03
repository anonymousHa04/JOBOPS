#!/bin/sh
# Run one coder task through the feedback loop (agentManagementAndFeedbackSystem.md
# §3 and §6). Prints only the final check report.
# Usage: autofix.sh <task> <spec-file> <file-to-edit>...
#
# The single entry point for a coder task (2026-11-03): one series of steps, the orchestrator
# decides every outcome, never the model.
#   1. ready.sh: environment ready? Otherwise nothing is dispatched (INFRA_FAILURE, exit 3).
#   2. pipeline.py prepare: complexity route and context bundle. A refused task (new subsystem,
#      cross-language without a contract, multi-file edit, new dependency) exits 2 (SPEC_FAILURE).
#   3. runner: patch runner for edits to existing files (search/replace, checked and applied by the
#      controller), aider for new files. FIRST_RUNNER overrides (aider|patch|mini|fake).
#   4. pipeline.py verify: edit gate (files changed, diff not empty, expect: tokens, scope, no large
#      deletion, syntax, dependencies exist). A failed gate skips check.sh.
#   5. check.sh: typecheck, tests, Go.
# Every attempt gets a failure class (EDIT, CODE, CONTEXT, DEPENDENCY, INFRA, TEST, SPEC_FAILURE).
# Fix rounds: only for an EDIT_FAILURE, at most MAX_FIXES (default 1, user 2026-11-03: fix rounds
# passed 4 of 39 times); every other class escalates at once.
# Result: .agent-logs/<task>.result.json (+ <task>.escalation.json when not passed);
#   one line per task in the main repo's .agent-logs/outcomes.jsonl.
# Exit 0 = passed, 1 = anything else (the manager takes over).
set -u

task=$1; spec=$2; shift 2
bin=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
max=${MAX_FIXES:-1}
limit=${CODER_TIMEOUT:-1200}
attempts=".agent-logs/$task.attempts.jsonl"
: > "$attempts"
rm -f ".agent-logs/$task.escalation.json"
feedback() { TASK=$task python3 "$bin/feedback.py" "$@"; }
# Stage log: one JSON line per pipeline stage (.agent-logs/stages.jsonl), for following a run
# (tail -f) and for timing each stage later. stage <name> [detail...]
# POSIX sh has no local variables: never reuse attempt()'s r/a/s here (s is the spec path).
stage() {
  stage_name=$1; shift
  printf '{"at":"%s","task":"%s","stage":"%s","detail":"%s"}\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$task" "$stage_name" \
    "$(printf '%s' "$*" | tr '"\\\n' "'/ " | cut -c1-300)" >> .agent-logs/stages.jsonl
}
stage start "files: $* max_fixes: $max runner: ${FIRST_RUNNER:-auto} test_cmd: ${TEST_CMD:-npm test}"

# Ends the task without a coder attempt: not ready (INFRA_FAILURE) or refused (SPEC_FAILURE).
# Nothing is recorded against the coder.
stop_before() { # <class> <exit> <reason>
  printf '{"task":"%s","status":"not_dispatched","class":"%s","reason":"%s","at":"%s"}\n' "$task" "$1" \
    "$(printf '%s' "$3" | tr '"\\\n' "'/ " | cut -c1-300)" "$(date +%Y-%m-%dT%H:%M:%S)" | tee ".agent-logs/$task.result.json" >> .agent-logs/outcomes.jsonl
  stage not_dispatched "$1: $3"
  echo "NOT DISPATCHED ($task): $1: $3"
  exit "$2"
}

# 1. Readiness (the self-test's fake runner needs no servers).
if [ "${FIRST_RUNNER:-}" != fake ] && [ "${SKIP_READY:-0}" != 1 ]; then
  ready=$("$bin/ready.sh" 2>&1) || stop_before INFRA_FAILURE 3 "$(printf '%s\n' "$ready" | tail -1)"
fi
# 2. Route and context bundle.
prep=$(python3 "$bin/pipeline.py" prepare "$task" "$spec" "$@"); prep_rc=$?
stage prepare "$(printf '%s' "$prep" | tr '\n' ' ')"
[ "$prep_rc" = 2 ] && [ -z "${FIRST_RUNNER:-}" ] && stop_before SPEC_FAILURE 2 "task refused: $(printf '%s\n' "$prep" | sed -n 's/^PREP note: //p' | head -1)"
routed=$(printf '%s\n' "$prep" | sed -n 's/^PREP route=[^ ]* runner=\([a-z]*\).*/\1/p')
[ "$routed" = refused ] && routed=aider

# run <runner> <attempt> <spec> <files...>
# Sets: run_exit (coder exit status or "unknown"), run_timed_out (0/1).
run() {
  r=$1; t=$2; s=$3; shift 3
  rm -f ".agent-logs/$t.done" ".agent-logs/$t.exit"
  date +%s > ".agent-logs/$t.started"  # attempt timing (feedback.py attempt reads it)
  case "$r" in
    patch) cp ".agent-logs/$task.bundle.md" ".agent-logs/$t.bundle.md" 2>/dev/null
           "$bin/run-patch.sh" "$t" "$s" "$@" > /dev/null ;;
    mini) "$bin/run-mini.sh" "$t" "$s" "$@" > /dev/null ;;
    fake) "$bin/run-fake.sh" "$t" "$s" "$@" > /dev/null ;;
    *)    "$bin/run-coder.sh" "$t" "$s" "$@" > /dev/null ;;
  esac
  run_timed_out=0; waited=0
  while [ ! -f ".agent-logs/$t.done" ]; do
    if [ "$waited" -ge "$limit" ]; then
      pkill -f "message-file $s" 2>/dev/null
      if [ -f ".agent-logs/$t.pid" ]; then
        pkill -P "$(cat ".agent-logs/$t.pid")" 2>/dev/null; kill "$(cat ".agent-logs/$t.pid")" 2>/dev/null
      fi
      tmux kill-window -t "jobops:$t" 2>/dev/null
      run_timed_out=1
      break
    fi
    # aider runs in tmux window jobops:<attempt>; if that window is gone with no .done, the coder
    # never started or died (2026-10-30: autofix slept 10 min after a reboot, no aider running).
    if { [ "$r" = aider ] || [ "$r" = patch ]; } && [ $((waited % 15)) -eq 14 ] && ! tmux list-windows -t jobops -F '#W' 2>/dev/null | grep -qx "$t"; then
      [ -f ".agent-logs/$t.done" ] && break
      echo "RUN-CODER: CODER WINDOW GONE (aider not running, no .done after ${waited}s)" | tee -a ".agent-logs/$t.log" >&2
      echo 1 > ".agent-logs/$t.exit"; touch ".agent-logs/$t.done"
    fi
    sleep 1; waited=$((waited + 1))
  done
  run_exit=$(cat ".agent-logs/$t.exit" 2>/dev/null || echo unknown)
}

# attempt <runner> <attempt-id> <spec> <files...>
# Sets: verdict (passed|failed|timed_out|unknown), why, report.
attempt() {
  r=$1; a=$2; s=$3; shift 3
  "$bin/tree-snapshot.sh" snap ".agent-logs/$a.before.json"
  # Each target as it was before the attempt, for the edit gate.
  rm -rf ".agent-logs/$a.orig"
  for f in "$@"; do [ -f "$f" ] && mkdir -p ".agent-logs/$a.orig/$(dirname "$f")" && cp "$f" ".agent-logs/$a.orig/$f"; done
  stage coder_start "attempt $a runner $r spec $s"
  run "$r" "$a" "$s" "$@"
  stage coder_end "attempt $a exit $run_exit timed_out $run_timed_out"
  "$bin/tree-snapshot.sh" snap ".agent-logs/$a.after.json"
  changes=$("$bin/tree-snapshot.sh" diff ".agent-logs/$a.before.json" ".agent-logs/$a.after.json" "$@")
  outside=$(printf '%s\n' "$changes" | sed -n 's/^OUTSIDE: //p')
  touched=$(printf '%s\n' "$changes" | grep -v '^OUTSIDE: ' | grep -c .)
  boundary=passed; [ -n "$outside" ] && boundary=failed
  # Undo out-of-boundary changes now, so a repair round starts from a clean tree.
  stage boundary "attempt $a $boundary; files changed $touched; outside: $(echo $outside)"
  [ "$boundary" = failed ] && "$bin/tree-snapshot.sh" revert ".agent-logs/$a.before.json" ".agent-logs/$a.after.json" "$@" > ".agent-logs/$a.reverted.txt" 2>&1

  if [ "$run_timed_out" = 1 ]; then
    verdict=timed_out; why="coder stopped after ${limit}s"
    report="RESULT: TIMEOUT ($a): $why
Last log lines (.agent-logs/$a.log):
$(grep -v '^[[:space:]]*$' ".agent-logs/$a.log" 2>/dev/null | tail -8)"
    feedback attempt "$a" "$r" "$verdict" "$why" 1 -- "$@" > /dev/null
    return
  fi

  # Edit gate: the orchestrator decides whether a real, in-scope edit happened.
  gate_report=$(OUTSIDE="$outside" python3 "$bin/pipeline.py" verify "$a" "$s" ".agent-logs/$a.orig" "$@"); gate_rc=$?
  gate=passed; [ "$gate_rc" -ne 0 ] && gate=failed
  gate_class=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("class") or "")' ".agent-logs/$a.gate.json" 2>/dev/null)
  stage gate "attempt $a $gate${gate_class:+ ($gate_class)}: $(printf '%s\n' "$gate_report" | grep 'GATE FAILED' | cut -c13- | tr '\n' ';')"

  if [ "$gate" = failed ]; then
    report="RESULT: FAIL ($a): edit gate
$(printf '%s\n' "$gate_report" | grep -E 'GATE (FAILED|RESULT)')
$(grep -hE 'RUN-(CODER|MINI|PATCH):' ".agent-logs/$a.log" 2>/dev/null | head -3)"
    verdict=failed; why="edit gate: $(printf '%s\n' "$gate_report" | grep -m1 'GATE FAILED' | cut -c14- | cut -c1-200)"
    FAILURE_CLASS=$gate_class feedback attempt "$a" "$r" "$verdict" "$why" 0 -- "$@" > /dev/null
    stage verdict "attempt $a $verdict ($gate_class): $why"
    return
  fi

  stage check_start "attempt $a"
  report=$("$bin/check.sh" "$a"); check_rc=$?
  check=passed; [ "$check_rc" -ne 0 ] && check=failed
  stage check_end "attempt $a $check: $(printf '%s\n' "$report" | grep -m3 -E '^(FAIL|ERROR):|error TS|RESULT' | tr '\n' ';')"

  if [ "$boundary" = failed ]; then
    verdict=failed; why="changed files outside the task: $(echo $outside)"
  elif [ "$touched" -eq 0 ] && ! { [ "$check" = passed ] && [ "$a" != "$task" ]; }; then
    # A fix round that changes nothing passes when the check passes: the work was already done
    # and only the boundary (a file outside the task) failed the round before (fx-a try 3, 2026-10-30).
    # Prefer the runner's own reason (e.g. mini's worktree check failed).
    flagged=$(grep -hE 'RUN-(CODER|MINI):' ".agent-logs/$a.log" 2>/dev/null | head -1 | sed 's/^RUN-[A-Z]*: //')
    verdict=failed; why="no task file changed${flagged:+: $flagged}"
  elif [ "$run_exit" = unknown ]; then
    verdict=unknown; why="coder exit status not recorded"
  elif [ "$run_exit" != 0 ]; then
    verdict=failed; why="coder exited with $run_exit"
  elif [ "$check" = failed ]; then
    verdict=failed; why="check failed"
  else
    verdict=passed; why=""
  fi
  [ "$verdict" != passed ] && [ "$why" != "check failed" ] && report="$report
RESULT: $verdict ($a): $why"
  feedback attempt "$a" "$r" "$verdict" "$why" 0 -- "$@" > /dev/null
  stage verdict "attempt $a $verdict${why:+: $why}"
}

first_runner=${FIRST_RUNNER:-$routed}
attempt "$first_runner" "$task" "$spec" "$@"
round=0
while :; do
  if [ "$verdict" = passed ]; then
    echo "$report"; feedback finish "$task" passed "" > /dev/null
    stage passed "after $((round + 1)) attempt(s)"
    # Refresh the vector index only after an accepted change (user, 2026-10-26):
    # no writes for attempts that are rejected. Not fatal if it fails.
    python3 "$bin/../knowledge/retrieve.py" embed-index > ".agent-logs/$task.embed.json" 2>&1 || true
    exit 0
  fi
  next=$(feedback decide "$task" "$max")
  # Only an edit failure gets a fix round (the gate's reason goes into the next spec); every
  # other class escalates at once.
  last_class=$(tail -1 "$attempts" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("failure_class") or "")' 2>/dev/null)
  # FIX_CLASSES (default EDIT_FAILURE; "all" for every class) is for the tooling self-tests.
  case "$next" in escalate*) ;; *)
    case " ${FIX_CLASSES:-EDIT_FAILURE} " in *" all "*|*" $last_class "*) ;; *) next="escalate: $last_class (only edit failures get a fix round)" ;; esac ;; esac
  case "$next" in
    escalate*)
      why_stop=${next#escalate: }
      echo "$report"
      stage self_review "escalating: asking the local model to review the last attempt"
      feedback finish "$task" "$verdict" "$why ($why_stop)" > /dev/null
      stage escalated "$verdict, $why_stop; review: $(python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); r=e.get("self_review") or {}; print(r.get("likely_cause") or r.get("skipped") or "")' ".agent-logs/$task.escalation.json" 2>/dev/null)"
      echo "ESCALATE ($task): $verdict, $why_stop. Record: .agent-logs/$task.escalation.json"
      exit 1 ;;
  esac
  round=$((round + 1))
  current="$task-fix$round"
  fix_spec=".agent-logs/$current.spec.md"
  prev=$current; [ "$round" = 1 ] && prev=$task || prev="$task-fix$((round - 1))"
  stage repair_spec "fix round $round of $max from $prev"
  feedback repair-spec "$task" "$prev" "$spec" "$fix_spec" -- "$@" > /dev/null
  stage lessons "fix round $round: $(cat ".agent-logs/$current.fixes-supplied.json" 2>/dev/null || echo none)"
  # Same runner as the first attempt; the gate's findings lead the repair spec.
  { echo "## Your previous attempt was rejected by the edit gate"
    grep -E 'GATE FAILED|RUN-PATCH' ".agent-logs/$prev.gate.json" ".agent-logs/$prev.log" 2>/dev/null | sed 's/^[^:]*://' | head -6
    python3 -c 'import json,sys; [print("- " + c["check"] + ": " + c["detail"]) for c in json.load(open(sys.argv[1]))["checks"] if c["status"] == "failed"]' ".agent-logs/$prev.gate.json" 2>/dev/null
    echo; cat "$fix_spec"; } > "$fix_spec.tmp" && mv "$fix_spec.tmp" "$fix_spec"
  attempt "${FIX_RUNNER:-$first_runner}" "$current" "$fix_spec" "$@"
done
