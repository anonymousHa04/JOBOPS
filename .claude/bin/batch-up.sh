#!/bin/sh
# Bring up everything a batch needs, in one command (RUNBOOK-M5.md "Run a batch").
#   1. laptop general7 answers (it is started by hand: C:\llama\start-server.cmd)
#   2. Docker and Qdrant
#   3. general14 on the Mac (the coder is stopped first: one heavy model at a time)
#   4. tmux session jobops with windows api, queue, worker-laptop, worker-mac
#      (a window that already exists is left running)
#   5. waits until the API and the queue answer
# It never starts a batch: run `node api/src/cli.ts batch start --limit N` yourself.
# Usage: batch-up.sh        Exit 0 = everything up.
set -u
cd "$(git rev-parse --show-toplevel)"
R=$(pwd)
bin="$R/.claude/bin"
up() { curl -s -m3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null | grep -q '^2'; }
wait_for() { # <url> <seconds>
  i=0; while [ "$i" -lt "$2" ]; do up "$1" && return 0; sleep 1; i=$((i + 1)); done; return 1
}
die() { echo "NOT UP: $1"; exit 1; }

# 1. Laptop (needs its API key only for model calls; /health is open).
up http://10.10.10.1:8084/health && echo "[ok] laptop general7" \
  || die "laptop general7: double-click C:\\llama\\start-server.cmd on the laptop, then run this again"

# 2. Docker and Qdrant.
if ! docker info >/dev/null 2>&1; then
  echo "starting Docker Desktop..."; open -a Docker
  i=0; until docker info >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 90 ] && die "Docker did not start"; sleep 1; done
fi
docker compose -f infra/qdrant/docker-compose.yml up -d >/dev/null 2>&1
wait_for http://localhost:6333/collections 30 && echo "[ok] Qdrant" || die "Qdrant (docker compose -f infra/qdrant/docker-compose.yml up -d)"

# 3. general14 on the Mac.
if up http://127.0.0.1:8085/health; then echo "[ok] general14"
else
  "$bin/llm.sh" stop coder >/dev/null 2>&1
  "$bin/llm.sh" start general14 >/dev/null 2>&1
  wait_for http://127.0.0.1:8085/health 180 && echo "[ok] general14 (started)" || die "general14 (.claude/bin/llm.sh start general14)"
fi

# 4. tmux windows. A tmux server must be started from a foreground command.
tmux has-session -t jobops 2>/dev/null || tmux new-session -d -s jobops -n status -c "$R" \
  "while true; do clear; date; echo; '$bin/llm.sh' status; echo; git -C '$R' status --short; sleep 5; done"
win() { # <name> <command>: keep the window open after the command ends, so errors stay visible
  if tmux list-windows -t jobops -F '#W' | grep -qx "$1"; then echo "[ok] window $1 (already running)"
  else tmux new-window -d -t jobops -n "$1" -c "$R" "$2; echo; echo '$1 stopped; press Enter to close'; read x"; echo "[ok] window $1"; fi
}
win api "node api/src/server.ts"
wait_for 'http://localhost:3000/jobs?limit=1' 30 || die "API (see: tmux attach -t jobops, window api)"
win queue "go run -C queue ./cmd/queue"
wait_for http://127.0.0.1:8090/health 60 || die "queue (see: tmux attach -t jobops, window queue)"
win worker-laptop "node api/src/cli.ts worker laptop"
win worker-mac "node api/src/cli.ts worker mac"

echo "UP. Watch: tmux attach -t jobops   Start: node api/src/cli.ts batch start --limit 3"
