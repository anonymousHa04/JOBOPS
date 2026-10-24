#!/bin/sh
# Run every task in a milestone plan through autofix.sh, in order. Stops at the
# first task that escalates. Prints one line per passing task.
# Usage: run-plan.sh <plan-file> [first-task-id]
#
# Plan format (no triple-backtick fences anywhere):
#   ## task: m3-01-example
#   files: api/src/a.ts
#   gate: user            (optional; required on every test-writing task)
#   <spec text for the coder, up to the next "## task:" line>
#
# A gated task is never started automatically: the plan stops before it so the
# user can approve it. Resuming at that task id (second argument) is the approval.
set -u

plan=$1; start=${2:-}
bin=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"
mkdir -p .claude/specs

# Split the plan into one spec file per task; list "id|files|gate" lines.
tasks=$(awk '
  function flush() { if (id != "") print id "|" files "|" gate }
  /^## task: / { flush(); id = $3; files = ""; gate = ""; out = ".claude/specs/" id ".md"; print "# Task " id > out; next }
  /^files: / && id != "" && files == "" { files = substr($0, 8); next }
  /^gate: / && id != "" { gate = $2; next }
  id != "" { print >> out }
  END { flush() }
' "$plan")

started=${start:+0}
echo "$tasks" | while IFS='|' read -r id files gate; do
  [ -z "$id" ] && continue
  if [ "${started:-1}" = 0 ]; then
    [ "$id" = "$start" ] && started=1 || continue
  elif [ "$gate" = user ]; then
    echo "GATE: $id needs user approval. Spec: .claude/specs/$id.md"
    echo "After approval resume with: run-plan.sh $plan $id"
    exit 2
  fi
  # shellcheck disable=SC2086
  if out=$("$bin/autofix.sh" "$id" ".claude/specs/$id.md" $files); then
    echo "$out" | head -1
  else
    echo "$out"
    echo "PLAN STOPPED at $id. Resume with: run-plan.sh $plan $id"
    exit 1
  fi
done
