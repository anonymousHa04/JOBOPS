#!/bin/sh
# Run a local coder (aider + Ollama) in its own window of the "jobops" tmux session.
# Usage: run-coder.sh <task> <spec-file> <file-to-edit>...
# Watch:  tmux attach -t jobops     Wait: tmux wait-for <task>
# Specs and read-only files must not contain ``` fences: aider then switches to
# ```` fences, the 7B model keeps answering with ```, and the edit is silently dropped.
set -eu

task=$1; spec=$2; shift 2
root=$(git rev-parse --show-toplevel)
model=${CODER_MODEL:-ollama_chat/qwen2.5:14b}
# whole = rewrite each file in full (slow on big files); diff = search/replace blocks.
edit_format=${CODER_EDIT_FORMAT:-whole}
mkdir -p "$root/.agent-logs"
rm -f "$root/.agent-logs/$task.done"

if ! tmux has-session -t jobops 2>/dev/null; then
  tmux new-session -d -s jobops -n status -c "$root" \
    "while true; do clear; date; echo; ollama ps; echo; git -C '$root' status --short; sleep 5; done"
fi

tmux new-window -t jobops -n "$task" -c "$root" \
  "aider --model '$model' --edit-format '$edit_format' --no-auto-commits --yes-always --no-suggest-shell-commands \
     --no-check-update --no-analytics --no-show-model-warnings \
     --read .claude/agents/coder.md \
     --message-file '$spec' $* 2>&1 | tee '.agent-logs/$task.log'; \
   grep -q 'Applied edit' '.agent-logs/$task.log' || echo 'RUN-CODER: NO EDIT APPLIED' | tee -a '.agent-logs/$task.log'; \
   for f in $*; do [ -s \"\$f\" ] || echo \"RUN-CODER: TARGET MISSING OR EMPTY: \$f\" | tee -a '.agent-logs/$task.log'; done; \
   [ -d path/to ] && echo 'RUN-CODER: STRAY path/to/ CREATED' | tee -a '.agent-logs/$task.log'; \
   touch '.agent-logs/$task.done'; tmux wait-for -S '$task'; echo; echo '[finished - press Enter to close]'; read _"
echo "started $task (tmux window jobops:$task)"
