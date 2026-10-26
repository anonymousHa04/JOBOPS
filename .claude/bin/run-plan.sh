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
# The plan's preamble (everything before the first "## task:") holds rules for
# every task, so it is copied to the top of each spec: before 2026-10-26 it was
# dropped, and coders never saw shared rules such as JOBOPS_PROFILE_DIR (m3-05-fb).
tasks=$(awk '
  function flush() { if (id != "") print id "|" files "|" gate }
  /^## task: / { flush(); id = $3; files = ""; gate = ""; out = ".claude/specs/" id ".md"; print "# Task " id > out
                 if (shared != "") print "\n## Shared rules (apply to every task)\n" shared "\n## This task" >> out; next }
  id == "" { shared = shared $0 "\n"; next }
  /^files: / && id != "" && files == "" { files = substr($0, 8); next }
  /^gate: / && id != "" { gate = $2; next }
  id != "" { print >> out }
  END { flush() }
' "$plan")

# Commit a passing task's files only (user's standing request for M3; COMMIT=0
# turns it off). Subject = task id + first line of its spec.
commit_task() {
  t=$1; shift
  git add -- "$@" 2>/dev/null
  git diff --cached --quiet -- "$@" && return 0
  m=$(echo "${CODER_MODEL:-ollama_chat/qwen2.5-coder:14b}" | sed 's#^ollama_chat/##')
  # First line of the task's own text (after the shared rules, when present).
  subj=$(awk 'f && /./ { print; exit } /^## This task/ { f = 1 }' ".claude/specs/$t.md" | cut -c1-60)
  [ -n "$subj" ] || subj=$(sed -n '2,/./{/./p;}' ".claude/specs/$t.md" | head -1 | cut -c1-60)
  git commit -q -m "$t: $subj

Written by $m (local, via aider/mini-swe-agent); passed check.sh.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Co-Authored-By: $m <$(echo "$m" | tr ':.' '--')@ollama.local>
Co-Authored-By: Ollama <ollama@ollama.local>" -- "$@" && echo "COMMIT: $t $(git rev-parse --short HEAD)"
}

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
    [ "${COMMIT:-1}" = 1 ] && commit_task "$id" $files
  else
    echo "$out"
    echo "PLAN STOPPED at $id. Resume with: run-plan.sh $plan $id"
    exit 1
  fi
done
