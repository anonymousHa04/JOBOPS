#!/bin/sh
# Run one coder task, validate it, and optionally feed failures back to the
# coder (MAX_FIXES rounds). Prints only the final check report.
# Usage: autofix.sh <task> <spec-file> <file-to-edit>...
#
# Every attempt is judged on evidence, never on log text (Phase 0):
#   coder exit status (.agent-logs/<attempt>.exit; missing = unknown),
#   timeout (CODER_TIMEOUT seconds, default 1200),
#   change boundary (files changed outside the task's files fail the attempt),
#   check.sh (exit status of typecheck, tests, Go).
# Result: .agent-logs/<task>.result.json
#   status: passed | failed | timed_out | unknown, reason, and every attempt.
# Exit 0 = passed, 1 = anything else (the manager takes over).
set -u

task=$1; spec=$2; shift 2
bin=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
max=${MAX_FIXES:-0}
limit=${CODER_TIMEOUT:-1200}
attempts=".agent-logs/$task.attempts.jsonl"
: > "$attempts"

# Runner per task: aider writes new files; mini-swe-agent edits existing files
# and does every fix round; "fake" is the self-test stand-in.
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

# record <attempt> <runner> <check_status> <boundary_status> <outside> <reason>
record() {
  K=$(cat ".agent-logs/$1.context.status" 2>/dev/null || echo none) \
  A=$1 R=$2 X=$run_exit T=$run_timed_out C=$3 B=$4 O=$5 W=$6 python3 -c '
import json, os
e = os.environ
print(json.dumps({"attempt": e["A"], "runner": e["R"],
  "coder_exit": int(e["X"]) if e["X"].lstrip("-").isdigit() else e["X"],
  "timed_out": e["T"] == "1", "boundary": e["B"],
  "outside": [l for l in e["O"].splitlines() if l],
  "check": e["C"], "context": e["K"], "reason": e["W"] or None}))' >> "$attempts"
}

finish() { # <status> <reason>
  S=$1 W=$2 python3 -c '
import json, os, sys
e = os.environ
attempts = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
json.dump({"task": sys.argv[1], "status": e["S"], "reason": e["W"], "attempts": attempts},
          open(sys.argv[3], "w"), indent=2)' "$task" "$attempts" ".agent-logs/$task.result.json"
  [ "$1" = passed ]
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
    record "$a" "$r" not_run "$boundary" "$outside" "$why"
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
  record "$a" "$r" "$check" "$boundary" "$outside" "$why"
}

attempt "${FIRST_RUNNER:-$(runner_for "$@")}" "$task" "$spec" "$@"
round=0
while :; do
  if [ "$verdict" = passed ]; then
    echo "$report"; finish passed ""
    # Refresh the vector index only after an accepted change (user, 2026-10-26):
    # no writes for attempts that are rejected. Not fatal if it fails.
    python3 "$bin/../knowledge/retrieve.py" embed-index > ".agent-logs/$task.embed.json" 2>&1 || true
    exit 0
  fi
  if [ "$verdict" = timed_out ] || [ "$round" -ge "$max" ]; then
    echo "$report"
    echo "ESCALATE ($task): $verdict after $round fix rounds ($why); manager takes over"
    finish "$verdict" "$why"; exit 1
  fi
  round=$((round + 1))
  current="$task-fix$round"
  fix_spec=".claude/specs/$current.md"
  {
    echo "# Fix round $round for task $task"
    echo
    echo "Edit only these files: $*"
    echo
    echo "Your change for this task fails the checks below. Fix only the files"
    echo "listed above. If a test fails, use the original task below as the"
    echo "source of truth to decide whether the code or the test is wrong."
    echo
    echo "## Check report"
    printf '%s\n' "$report" | sed 's/^/    /'
    echo
    echo "## Original task"
    cat "$spec"
  } > "$fix_spec"
  attempt "${FIX_RUNNER:-mini}" "$current" "$fix_spec" "$@"
done
