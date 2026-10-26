#!/bin/sh
# Run a local coder (aider + Ollama) in its own window of the "jobops" tmux session.
# Usage: run-coder.sh <task> <spec-file> <file-to-edit>...
# Watch:  tmux attach -t jobops     Wait: tmux wait-for <task>
# Specs and read-only files must not contain ``` fences: aider then switches to
# ```` fences, the 7B model keeps answering with ```, and the edit is silently dropped.
#
# Knowledge layer (Phase 2): before aider starts, the task's context package is
# built by .claude/knowledge/retrieve.py and given to aider as a read-only file.
#   .agent-logs/<task>.context.md     what aider reads
#   .agent-logs/<task>.context.json   full package with sources (evidence)
#   .agent-logs/<task>.context.status ok | failed: <reason> | off
# If retrieval fails, aider gets the API map instead and the run continues.
# KNOWLEDGE=0 keeps the previous workflow; CONTEXT_BUDGET sets the token budget.
set -eu

task=$1; spec=$2; shift 2
root=$(git rev-parse --show-toplevel)
bin=$(cd "$(dirname "$0")" && pwd)
agents=$(cd "$bin/../agents" && pwd)
knowledge=$(cd "$bin/../knowledge" && pwd)
model=${CODER_MODEL:-ollama_chat/qwen2.5-coder:14b}
# whole = rewrite each file in full (slow on big files); diff = search/replace blocks.
edit_format=${CODER_EDIT_FORMAT:-whole}
logs="$root/.agent-logs"
mkdir -p "$logs"
rm -f "$logs/$task.done" "$logs/$task.exit" "$logs/$task.context.md" "$logs/$task.context.json"

context_read="--read $logs/api-map.md"
"$bin/api-map.sh" >/dev/null
if [ "${KNOWLEDGE:-1}" = 1 ]; then
  new=""
  for f in "$@"; do [ -s "$f" ] || new="$new $f"; done
  # Keep the vector index in step with the files (incremental; failure is not fatal).
  python3 "$knowledge/retrieve.py" embed-index > "$logs/$task.embed.json" 2>&1 || true
  # shellcheck disable=SC2086
  if python3 "$knowledge/retrieve.py" context --spec "$spec" --files "$@" ${new:+--new $new} \
       --budget "${CONTEXT_BUDGET:-2200}" --format md --out "$logs/$task.context.md" \
       --log "$logs/$task.context.json" > "$logs/$task.context.err" 2>&1; then
    echo ok > "$logs/$task.context.status"
    context_read="--read $logs/$task.context.md"
  else
    echo "failed: $(tail -1 "$logs/$task.context.err" 2>/dev/null)" > "$logs/$task.context.status"
  fi
else
  echo off > "$logs/$task.context.status"
fi

if ! tmux has-session -t jobops 2>/dev/null; then
  tmux new-session -d -s jobops -n status -c "$root" \
    "while true; do clear; date; echo; ollama ps; echo; git -C '$root' status --short; sleep 5; done"
fi

tmux new-window -t jobops -n "$task" -c "$root" \
  "{ echo 'KNOWLEDGE: context $(cat "$logs/$task.context.status")'; \
     aider --model '$model' --edit-format '$edit_format' --no-auto-commits --yes-always --no-suggest-shell-commands \
     --no-check-update --no-analytics --no-show-model-warnings --no-gitignore \
     --read '$agents/coder.md' --read '$agents/coder-patterns.md' $context_read \
     --auto-lint --lint-cmd 'typescript: $bin/tsc-lint.sh' \
     --message-file '$spec' $*; echo \$? > '.agent-logs/$task.exit'; } 2>&1 | tee '.agent-logs/$task.log'; \
   grep -q 'Applied edit' '.agent-logs/$task.log' || echo 'RUN-CODER: NO EDIT APPLIED' | tee -a '.agent-logs/$task.log'; \
   for f in $*; do [ -s \"\$f\" ] || echo \"RUN-CODER: TARGET MISSING OR EMPTY: \$f\" | tee -a '.agent-logs/$task.log'; done; \
   [ -d path/to ] && echo 'RUN-CODER: STRAY path/to/ CREATED' | tee -a '.agent-logs/$task.log'; \
   touch '.agent-logs/$task.done'; tmux wait-for -S '$task'; echo; echo '[finished - press Enter to close]'; read _"
echo "started $task (tmux window jobops:$task)"
