#!/bin/sh
# Run mini-swe-agent on a task in a throwaway git worktree, in its own window of
# the "jobops" tmux session. The worktree starts from the main tree's current
# state (HEAD + uncommitted and untracked changes). If check.sh passes there and
# only allowed files changed, the diff is applied back to the main tree.
# Usage: run-mini.sh <task> <spec-file> [allowed-file]...
# Watch:  tmux attach -t jobops     Wait: tmux wait-for <task>
# Log lines starting with "RUN-MINI:" are picked up by check.sh as flags.
set -eu

if [ "${1:-}" != --inner ]; then
  task=$1; spec=$2; shift 2
  root=$(git rev-parse --show-toplevel)
  mkdir -p "$root/.agent-logs"
  rm -f "$root/.agent-logs/$task.done" "$root/.agent-logs/$task.pid"
  if ! tmux has-session -t jobops 2>/dev/null; then
    tmux new-session -d -s jobops -n status -c "$root" \
      "while true; do clear; date; echo; ollama ps; echo; git -C '$root' status --short; sleep 5; done"
  fi
  tmux new-window -t jobops -n "$task" -c "$root" \
    "'$0' --inner '$task' '$spec' $* 2>&1 | tee '.agent-logs/$task.log'; \
     touch '.agent-logs/$task.done'; tmux wait-for -S '$task'; \
     echo; echo '[finished - press Enter to close]'; read _"
  echo "started $task (tmux window jobops:$task, mini-swe-agent)"
  exit 0
fi

# --- inner: runs inside the tmux window ---
shift; task=$1; spec=$2; shift 2
bin=$(cd "$(dirname "$0")" && pwd)
root=$(git rev-parse --show-toplevel)
model=${MINI_MODEL:-ollama_chat/qwen2.5-coder:14b}
wt="$root/../jobops-mini-$task"
branch="mini/$task"
flag() { echo "RUN-MINI: $*"; }

cleanup() {
  rm -f "$wt/node_modules"
  git -C "$root" worktree remove --force "$wt" 2>/dev/null || true
  git -C "$root" branch -D "$branch" -q 2>/dev/null || true
}
cleanup
git -C "$root" worktree add -q "$wt" -b "$branch" HEAD
trap cleanup EXIT

# Bring over the main tree's uncommitted state, then commit it as the base.
git -C "$root" diff HEAD --binary | git -C "$wt" apply --allow-empty
git -C "$root" ls-files --others --exclude-standard -z \
  | (cd "$root" && xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp "{}" "$1/{}"' _ "$wt")
ln -s "$root/node_modules" "$wt/node_modules"
git -C "$wt" add -A -- . ':!node_modules'
git -C "$wt" -c user.email=mini@local -c user.name=mini commit -q --allow-empty -m "base for $task"

echo "== mini-swe-agent ($model) in $wt"
(cd "$wt" && MSWEA_COST_TRACKING=ignore_errors MSWEA_CONFIGURED=true \
  mini -c mini_textbased.yaml -c model.model_class=litellm_textbased \
       -m "$model" -y --exit-immediately -l 0 -t "$(cat "$root/$spec")" < /dev/null) &
echo $! > "$root/.agent-logs/$task.pid"
wait $! || true

git -C "$wt" add -A -- . ':!node_modules'
changed=$(git -C "$wt" diff --cached --name-only HEAD)
if [ -z "$changed" ]; then flag "NO CHANGES"; exit 0; fi
echo "== changed: $(echo $changed)"

if [ $# -gt 0 ]; then
  for f in $changed; do
    ok=0; for a in "$@"; do [ "$f" = "$a" ] && ok=1; done
    [ $ok = 1 ] || { flag "TOUCHED FILE OUTSIDE TASK: $f (nothing merged)"; exit 0; }
  done
fi

echo "== check in worktree"
if ! (cd "$wt" && "$bin/check.sh" "$task-wt"); then
  flag "CHECK FAILED IN WORKTREE (nothing merged)"; exit 0
fi

git -C "$wt" diff --cached --binary HEAD > "$root/.agent-logs/$task.patch"
if git -C "$root" apply "$root/.agent-logs/$task.patch"; then
  echo "Applied edit (mini-swe-agent) to: $(echo $changed)"
else
  flag "APPLY TO MAIN TREE FAILED; patch at .agent-logs/$task.patch"
fi
