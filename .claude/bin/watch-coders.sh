#!/bin/sh
# Manager's coder watch: run in the background with every coder run. Runs the
# heartbeat until a task is STUCK or DEAD while its autofix.sh still runs, then
# prints the ALERT line, the task's last stages and the end of its log, so the
# manager sees why without opening files. Read only: it stops nothing.
# Exits 3 after an alert, otherwise with the heartbeat's exit code.
# Usage: .claude/bin/watch-coders.sh [heartbeat flags, e.g. -interval 30s]
set -u
cd "$(git rev-parse --show-toplevel)"
out=$(mktemp)
trap 'rm -f "$out"' EXIT
# tee keeps the heartbeat's lines live; the file keeps them for the ALERT line.
{ go run -C .claude/bin/heartbeat . -until-alert -notify=false "$@"; echo $? > "$out.rc"; } | tee "$out"
rc=$(cat "$out.rc" 2>/dev/null || echo 1)
rm -f "$out.rc"
# go run reports the heartbeat's exit 3 as 1 ("exit status 3"), so the ALERT
# line, not the code, says whether it alerted.
alert=$(grep '^ALERT ' "$out" | tail -1)
[ -n "$alert" ] || exit "$rc"

attempt=$(echo "$alert" | cut -d' ' -f2)
base=$(echo "$attempt" | sed 's/-fix[0-9]*$//')
echo
echo "$alert"
echo "--- last stages of $base (.agent-logs/stages.jsonl)"
grep "\"task\":\"$base\"" .agent-logs/stages.jsonl 2>/dev/null | tail -6
echo "--- last lines of .agent-logs/$attempt.log"
grep -v '^[[:space:]]*$' ".agent-logs/$attempt.log" 2>/dev/null | tail -15
exit 3
