#!/bin/sh
# Run a local coder (aider + llama.cpp) in its own window of the "jobops" tmux session.
# Usage: run-coder.sh <task> <spec-file> <file-to-edit>...
# Watch:  tmux attach -t jobops     Wait: tmux wait-for <task>
# Specs and read-only files must not contain ``` fences: aider then switches to
# ```` fences, the 7B model keeps answering with ```, and the edit is silently dropped.
#
# Model server: llama.cpp via .claude/bin/llm.sh (started here if it is down).
#   CODER_MODEL  openai/qwen2.5-coder-14b (default, server "coder", :8081)
#                openai/qwen2.5-coder-7b  (server "coder7", :8083)
# The window is 16k tokens; a request above it is rejected by the server and
# flagged here as RUN-CODER: CONTEXT OVERFLOW (never silently truncated).
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
model=${CODER_MODEL:-openai/qwen2.5-coder-14b}
case "$model" in
  *coder-7b*) server=coder7; port=8083 ;;
  *)          server=coder;  port=8081 ;;
esac
# whole = rewrite each file in full (slow on big files); diff = search/replace blocks.
edit_format=${CODER_EDIT_FORMAT:-whole}
logs="$root/.agent-logs"
mkdir -p "$logs"
rm -f "$logs/$task.done" "$logs/$task.exit" "$logs/$task.context.md" "$logs/$task.context.json"

# Model servers must be up before anything else (fail loudly, not mid-run).
"$bin/llm.sh" start "$server" > "$logs/$task.llm.log" 2>&1 || { cat "$logs/$task.llm.log"; exit 1; }

context_read="--read $logs/api-map.md"
"$bin/api-map.sh" >/dev/null
if [ "${KNOWLEDGE:-1}" = 1 ]; then
  "$bin/llm.sh" start embed >> "$logs/$task.llm.log" 2>&1 || true
  new=""
  for f in "$@"; do [ -s "$f" ] || new="$new $f"; done
  # shellcheck disable=SC2086
  if python3 "$knowledge/retrieve.py" context --spec "$spec" --files "$@" ${new:+--new $new} \
       --budget "${CONTEXT_BUDGET:-3500}" --format md --out "$logs/$task.context.md" \
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
    "while true; do clear; date; echo; '$bin/llm.sh' status; echo; git -C '$root' status --short; sleep 5; done"
fi

tmux new-window -t jobops -n "$task" -c "$root" \
  "{ echo 'KNOWLEDGE: context $(cat "$logs/$task.context.status")'; \
     OPENAI_API_BASE='http://127.0.0.1:$port/v1' OPENAI_API_KEY=local \
     aider --model '$model' --edit-format '$edit_format' --no-auto-commits --yes-always --no-suggest-shell-commands \
     --no-check-update --no-analytics --no-show-model-warnings --no-gitignore \
     --model-settings-file '$agents/aider.model.settings.yml' --model-metadata-file '$agents/aider.model.metadata.json' \
     --map-tokens 0 --max-chat-history-tokens 2048 \
     --read '$agents/coder.md' --read '$agents/coder-patterns.md' --read '$agents/report-format.md' $context_read \
     --auto-lint --lint-cmd 'typescript: $bin/tsc-lint.sh' \
     --message-file '$spec' $*; echo \$? > '.agent-logs/$task.exit'; } 2>&1 | tee '.agent-logs/$task.log'; \
   grep -q 'Applied edit' '.agent-logs/$task.log' || echo 'RUN-CODER: NO EDIT APPLIED' | tee -a '.agent-logs/$task.log'; \
   grep -qiE 'exceeds the available context size|ContextWindowExceeded' '.agent-logs/$task.log' && echo 'RUN-CODER: CONTEXT OVERFLOW (a request exceeded the model window)' | tee -a '.agent-logs/$task.log'; \
   for f in $*; do [ -s \"\$f\" ] || echo \"RUN-CODER: TARGET MISSING OR EMPTY: \$f\" | tee -a '.agent-logs/$task.log'; done; \
   [ -d path/to ] && echo 'RUN-CODER: STRAY path/to/ CREATED' | tee -a '.agent-logs/$task.log'; \
   touch '.agent-logs/$task.done'; tmux wait-for -S '$task'; echo; echo '[finished - press Enter to close]'; read _"
echo "started $task (tmux window jobops:$task)"
