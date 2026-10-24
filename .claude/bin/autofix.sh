#!/bin/sh
# Run one coder task, check it, and feed failures back to the coder until it
# passes or MAX_FIXES rounds are used. Prints only the final check report.
# Usage: autofix.sh <task> <spec-file> <file-to-edit>...
# Each coder run is limited to CODER_TIMEOUT seconds (default 900). A timeout
# stops the coder and escalates at once; no further fix rounds.
# Exit 0 = PASS, 1 = ESCALATE (the manager takes over and edits the file).
set -u

task=$1; spec=$2; shift 2
bin=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
max=${MAX_FIXES:-2}
limit=${CODER_TIMEOUT:-900}

run() { # <task> <spec> <files...>; returns 1 on timeout
  t=$1; s=$2; shift 2
  "$bin/run-coder.sh" "$t" "$s" "$@" > /dev/null
  waited=0
  while [ ! -f ".agent-logs/$t.done" ]; do
    if [ "$waited" -ge "$limit" ]; then
      pkill -f "message-file $s" 2>/dev/null
      tmux kill-window -t "jobops:$t" 2>/dev/null
      echo "RESULT: TIMEOUT ($t): coder stopped after ${limit}s"
      echo "Last log lines (.agent-logs/$t.log):"
      grep -v '^[[:space:]]*$' ".agent-logs/$t.log" 2>/dev/null | tail -8
      echo "ESCALATE ($task): manager takes over"
      return 1
    fi
    sleep 5; waited=$((waited + 5))
  done
}

run "$task" "$spec" "$@" || exit 1
current=$task
round=0
while :; do
  report=$("$bin/check.sh" "$current") && { echo "$report"; exit 0; }
  if [ "$round" -ge "$max" ]; then
    echo "$report"
    echo "ESCALATE ($task): still failing after $max fix rounds; manager takes over"
    exit 1
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
  run "$current" "$fix_spec" "$@" || exit 1
done
