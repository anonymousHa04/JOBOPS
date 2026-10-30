#!/bin/sh
# Run one coder task through the feedback loop (agentManagementAndFeedbackSystem.md
# §3 and §6). Prints only the final check report.
# Usage: autofix.sh <task> <spec-file> <file-to-edit>...
#
# Every attempt is judged on evidence, never on log text (Phase 0):
#   coder exit status (.agent-logs/<attempt>.exit; missing = unknown),
#   timeout (CODER_TIMEOUT seconds, default 1200),
#   change boundary (files changed outside the task's files fail the attempt),
#   check.sh (exit status of typecheck, tests, Go).
# Feedback loop (Phase 3, feedback.py):
#   each attempt is recorded with its failure category, failure signature, and
#   the agent's own claim; a repair round is a fresh session with only the new
#   evidence (errors, hints, matching known fixes), never the same prompt again;
#   it stops on a repeated failure signature, an environment/validation/context
#   failure, a timeout, or MAX_FIXES (default 2, user 2026-10-29), and writes an escalation record.
# Result: .agent-logs/<task>.result.json (+ <task>.escalation.json when not passed);
#   one line per task in the main repo's .agent-logs/outcomes.jsonl.
# Exit 0 = passed, 1 = anything else (the manager takes over).
set -u

task=$1; spec=$2; shift 2
bin=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
max=${MAX_FIXES:-2}
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
stage start "files: $* max_fixes: ${MAX_FIXES:-2} runner: ${FIRST_RUNNER:-auto} test_cmd: ${TEST_CMD:-npm test}"

# Runner per task: aider writes new files and does repair rounds (FIX_RUNNER);
# mini-swe-agent edits existing files; "fake" is the self-test stand-in.
runner_for() { # <files...>
  for f in "$@"; do [ -s "$f" ] || { echo aider; return; }; done
  echo mini
}

# run <runner> <attempt> <spec> <files...>
# Sets: run_exit (coder exit status or "unknown"), run_timed_out (0/1).
run() {
  r=$1; t=$2; s=$3; shift 3
  rm -f ".agent-logs/$t.done" ".agent-logs/$t.exit"
  date +%s > ".agent-logs/$t.started"  # attempt timing (feedback.py attempt reads it)
  case "$r" in
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
    if [ "$r" = aider ] && [ $((waited % 15)) -eq 14 ] && ! tmux list-windows -t jobops -F '#W' 2>/dev/null | grep -qx "$t"; then
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

attempt "${FIRST_RUNNER:-$(runner_for "$@")}" "$task" "$spec" "$@"
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
  attempt "${FIX_RUNNER:-aider}" "$current" "$fix_spec" "$@"
done
