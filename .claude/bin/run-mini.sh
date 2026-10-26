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
  rm -f "$root/.agent-logs/$task.done" "$root/.agent-logs/$task.pid" "$root/.agent-logs/$task.exit"
  if ! tmux has-session -t jobops 2>/dev/null; then
    tmux new-session -d -s jobops -n status -c "$root" \
      "while true; do clear; date; echo; '$(cd "$(dirname "$0")" && pwd)/llm.sh' status; echo; git -C '$root' status --short; sleep 5; done"
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
model=${MINI_MODEL:-openai/qwen2.5-coder-14b}
case "$model" in *coder-7b*) server=coder7; port=8083 ;; *) server=coder; port=8081 ;; esac
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
# Always leave an exit status, even if this script dies early (R0.1).
trap 'rc=$?; [ -f "$root/.agent-logs/$task.exit" ] || echo "$rc" > "$root/.agent-logs/$task.exit"; cleanup' EXIT

# Bring over the main tree's uncommitted state, then commit it as the base.
git -C "$root" diff HEAD --binary | git -C "$wt" apply --allow-empty
git -C "$root" ls-files --others --exclude-standard -z -- . ':!node_modules' \
  | (cd "$root" && xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp "{}" "$1/{}"' _ "$wt")
ln -s "$root/node_modules" "$wt/node_modules"
git -C "$wt" add -A -- . ':!node_modules'
git -C "$wt" -c user.email=mini@local -c user.name=mini commit -q --allow-empty -m "base for $task"

# Spec: relative to the repo root, or absolute. A missing or empty spec is a
# failure, never an empty task.
case "$spec" in /*) spec_file=$spec ;; *) spec_file="$root/$spec" ;; esac
[ -s "$spec_file" ] || { flag "SPEC MISSING OR EMPTY: $spec"; echo 1 > "$root/.agent-logs/$task.exit"; exit 0; }

# The llama.cpp model server must be up (llm.sh starts it if needed).
"$bin/llm.sh" start "$server" || { flag "MODEL SERVER $server NOT AVAILABLE"; echo 1 > "$root/.agent-logs/$task.exit"; exit 0; }

# API map of the main tree (same sources as the worktree base).
(cd "$root" && "$bin/api-map.sh" > /dev/null)

# Knowledge layer (Phase 2): the same context package aider gets. It starts
# with the task itself, so it replaces the spec; on failure, fall back to
# spec + API map and record why. KNOWLEDGE=0 keeps the previous workflow.
knowledge=$(cd "$bin/../knowledge" && pwd)
task_text="$(cat "$spec_file"; echo; cat "$root/.agent-logs/api-map.md")"
if [ "${KNOWLEDGE:-1}" = 1 ]; then
  "$bin/llm.sh" start embed > /dev/null 2>&1 || true
  new=""
  for f in "$@"; do [ -s "$root/$f" ] || new="$new $f"; done
  # shellcheck disable=SC2086
  if (cd "$root" && python3 "$knowledge/retrieve.py" context --spec "$spec_file" --files "$@" ${new:+--new $new} \
        --budget "${CONTEXT_BUDGET:-3000}" --format md --out "$root/.agent-logs/$task.context.md" \
        --log "$root/.agent-logs/$task.context.json") > "$root/.agent-logs/$task.context.err" 2>&1; then
    echo ok > "$root/.agent-logs/$task.context.status"
    task_text="$(cat "$root/.agent-logs/$task.context.md")"
  else
    echo "failed: $(tail -1 "$root/.agent-logs/$task.context.err" 2>/dev/null)" > "$root/.agent-logs/$task.context.status"
  fi
else
  echo off > "$root/.agent-logs/$task.context.status"
fi
echo "KNOWLEDGE: context $(cat "$root/.agent-logs/$task.context.status")"

echo "== mini-swe-agent ($model) in $wt"
(cd "$wt" && MSWEA_COST_TRACKING=ignore_errors MSWEA_CONFIGURED=true \
  mini -c mini_textbased.yaml -c model.model_class=litellm_textbased \
       -c agent.step_limit=${MINI_STEP_LIMIT:-40} \
       -c model.model_kwargs.api_base=http://127.0.0.1:$port/v1 -c model.model_kwargs.api_key=local \
       -m "$model" -y --exit-immediately -l 0 -t "$(printf '%s\n\n' "$task_text"; cat "$bin/../agents/coder-patterns.md")" < /dev/null) &
echo $! > "$root/.agent-logs/$task.pid"
# Keep mini's real exit status (R0.1); set -e must not end the script here.
mini_rc=0; wait $! || mini_rc=$?
echo "== mini exit status: $mini_rc"

git -C "$wt" add -A -- . ':!node_modules'
changed=$(git -C "$wt" diff --cached --name-only HEAD)
if [ -z "$changed" ]; then flag "NO CHANGES"; echo "$mini_rc" > "$root/.agent-logs/$task.exit"; exit 0; fi
echo "== changed: $(echo $changed)"

if [ $# -gt 0 ]; then
  for f in $changed; do
    ok=0; for a in "$@"; do [ "$f" = "$a" ] && ok=1; done
    [ $ok = 1 ] || { flag "TOUCHED FILE OUTSIDE TASK: $f (nothing merged)"; echo "$mini_rc" > "$root/.agent-logs/$task.exit"; exit 0; }
  done
fi

echo "== check in worktree"
if ! (cd "$wt" && "$bin/check.sh" "$task-wt"); then
  flag "CHECK FAILED IN WORKTREE (nothing merged)"; echo "$mini_rc" > "$root/.agent-logs/$task.exit"; exit 0
fi

git -C "$wt" diff --cached --binary HEAD > "$root/.agent-logs/$task.patch"
# Apply and prove the main tree now holds exactly the validated patch (R0.3).
if "$bin/apply-patch.sh" "$root" "$root/.agent-logs/$task.patch"; then
  echo "Applied edit (mini-swe-agent) to: $(echo $changed)"
else
  flag "APPLY TO MAIN TREE FAILED OR DIFFERS; patch at .agent-logs/$task.patch"
fi
echo "$mini_rc" > "$root/.agent-logs/$task.exit"
