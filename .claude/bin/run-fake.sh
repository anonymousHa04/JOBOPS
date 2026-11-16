#!/bin/sh
# Stand-in coder for phase0-selftest.sh: runs $FAKE_ACTION (a shell snippet) in
# the background with the same contract as run-coder.sh / run-mini.sh:
# .agent-logs/<task>.log, .exit (the action's exit status), .done, .pid.
# FAKE_ACTION_FIX replaces FAKE_ACTION in fix rounds (<task>-fixN).
# FAKE_NO_EXIT=1 skips writing .exit (simulates a lost exit status).
# Usage: FAKE_ACTION='...' run-fake.sh <task> <spec-file> <files>...
set -u
task=$1
cd "$(git rev-parse --show-toplevel)"
mkdir -p .agent-logs
rm -f ".agent-logs/$task.done" ".agent-logs/$task.exit"
(
  rc=0
  action=${FAKE_ACTION:-true}
  case "$task" in *-fix*) action=${FAKE_ACTION_FIX:-$action} ;; esac
  sh -c "$action" > ".agent-logs/$task.log" 2>&1 || rc=$?
  [ -n "${FAKE_NO_EXIT:-}" ] || echo "$rc" > ".agent-logs/$task.exit"
  touch ".agent-logs/$task.done"
) &
echo $! > ".agent-logs/$task.pid"
echo "started $task (fake)"
