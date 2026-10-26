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
#   failure, a timeout, or MAX_FIXES (default 1), and writes an escalation record.
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
    sleep 1; waited=$((waited + 1))
  done
  run_exit=$(cat ".agent-logs/$t.exit" 2>/dev/null || echo unknown)
}

# attempt <runner> <attempt-id> <spec> <files...>
# Sets: verdict (passed|failed|timed_out|unknown), why, report.
attempt() {
  r=$1; a=$2; s=$3; shift 3
  "$bin/tree-snapshot.sh" snap ".agent-logs/$a.before.json"
  run "$r" "$a" "$s" "$@"
  "$bin/tree-snapshot.sh" snap ".agent-logs/$a.after.json"
  changes=$("$bin/tree-snapshot.sh" diff ".agent-logs/$a.before.json" ".agent-logs/$a.after.json" "$@")
  outside=$(printf '%s\n' "$changes" | sed -n 's/^OUTSIDE: //p')
  touched=$(printf '%s\n' "$changes" | grep -v '^OUTSIDE: ' | grep -c .)
  boundary=passed; [ -n "$outside" ] && boundary=failed

  if [ "$run_timed_out" = 1 ]; then
    verdict=timed_out; why="coder stopped after ${limit}s"
    report="RESULT: TIMEOUT ($a): $why
Last log lines (.agent-logs/$a.log):
$(grep -v '^[[:space:]]*$' ".agent-logs/$a.log" 2>/dev/null | tail -8)"
    feedback attempt "$a" "$r" "$verdict" "$why" 1 -- "$@" > /dev/null
    return
  fi

  report=$("$bin/check.sh" "$a"); check_rc=$?
  check=passed; [ "$check_rc" -ne 0 ] && check=failed

  if [ "$boundary" = failed ]; then
    verdict=failed; why="changed files outside the task: $(echo $outside)"
  elif [ "$touched" -eq 0 ]; then
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
}

attempt "${FIRST_RUNNER:-$(runner_for "$@")}" "$task" "$spec" "$@"
round=0
while :; do
  if [ "$verdict" = passed ]; then
    echo "$report"; feedback finish "$task" passed "" > /dev/null
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
      feedback finish "$task" "$verdict" "$why ($why_stop)" > /dev/null
      echo "ESCALATE ($task): $verdict, $why_stop. Record: .agent-logs/$task.escalation.json"
      exit 1 ;;
  esac
  round=$((round + 1))
  current="$task-fix$round"
  fix_spec=".agent-logs/$current.spec.md"
  prev=$current; [ "$round" = 1 ] && prev=$task || prev="$task-fix$((round - 1))"
  feedback repair-spec "$task" "$prev" "$spec" "$fix_spec" -- "$@" > /dev/null
  attempt "${FIX_RUNNER:-aider}" "$current" "$fix_spec" "$@"
done
