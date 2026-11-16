#!/bin/sh
# Patch runner for edits to existing files: the coder model answers with search/replace blocks
# and patch-coder.py checks and applies them (never a whole-file rewrite). Runs in its own window
# of the jobops tmux session, like run-coder.sh, so the user can watch it.
# Usage: run-patch.sh <task> <spec-file> <file-to-edit>...
# Output: .agent-logs/<task>.log (model answer in <task>.patch.txt), .exit, .done.
set -u
task=$1; spec=$2; shift 2
root=$(git rev-parse --show-toplevel)
bin=$(cd "$(dirname "$0")" && pwd)
logs="$root/.agent-logs"
mkdir -p "$logs"
rm -f "$logs/$task.done" "$logs/$task.exit"
cd "$root"
[ -f "$logs/$task.bundle.md" ] || python3 "$bin/context_bundle.py" "$spec" "$logs/$task.bundle.md" "$@" > /dev/null 2>&1

# Quote each file for the tmux command line.
args=""
for f in "$@"; do args="$args '$f'"; done
tmux new-window -t jobops -n "$task" -c "$root" \
  "{ echo 'PATCH RUNNER: $task'; python3 '$bin/patch_coder.py' '$task' '$spec' $args; echo \$? > '.agent-logs/$task.exit'; } 2>&1 | tee '.agent-logs/$task.log'; \
   touch '.agent-logs/$task.done'; tmux wait-for -S '$task'"
echo "started $task (tmux window jobops:$task, patch runner)"
