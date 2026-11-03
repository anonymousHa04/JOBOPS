#!/bin/sh
# Readiness check before any coder task is dispatched (run-plan.sh and autofix.sh call it).
# If the environment is not ready, nothing is dispatched: an infrastructure problem must never
# be counted as a coder failure (2026-11-03: Docker was down after a restart, Qdrant with it,
# and five test tasks were recorded as "coder window gone").
# Usage: ready.sh [--fix]   --fix starts what can be started safely (embed, coder, tmux).
# Prints one line per check; the last line is READY or NOT READY: <items>. Exit 0 = ready.
set -u
cd "$(git rev-parse --show-toplevel)"
bin=$(cd "$(dirname "$0")" && pwd)
fix=0; [ "${1:-}" = --fix ] && fix=1
missing=""
ok()  { echo "[ok]   $1"; }
bad() { echo "[FAIL] $1${2:+: $2}"; missing="$missing${missing:+, }$1"; }
up()  { curl -s -m3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null | grep -q '^2'; }

# Docker daemon and Qdrant (the coders' context pack needs Qdrant).
if docker info >/dev/null 2>&1; then ok "Docker daemon"; else bad "Docker daemon" "start Docker Desktop (open -a Docker)"; fi
qdrant=${QDRANT_URL:-http://localhost:6333}
if up "$qdrant/collections"; then ok "Qdrant healthy"
elif [ "$fix" = 1 ] && docker info >/dev/null 2>&1 && docker compose -f infra/qdrant/docker-compose.yml up -d >/dev/null 2>&1 && sleep 3 && up "$qdrant/collections"; then ok "Qdrant healthy (started)"
else bad "Qdrant healthy" "docker compose -f infra/qdrant/docker-compose.yml up -d"; fi

# Model servers on their ports: coder (8081) and embed (8082).
for role in coder embed; do
  port=$([ "$role" = coder ] && echo 8081 || echo 8082)
  if up "http://127.0.0.1:$port/health"; then ok "$role server (:$port)"
  elif [ "$fix" = 1 ] && "$bin/llm.sh" start "$role" >/dev/null 2>&1 && up "http://127.0.0.1:$port/health"; then ok "$role server (:$port, started)"
  else bad "$role server (:$port)" ".claude/bin/llm.sh start $role (general14 must be stopped first)"; fi
done

# tmux session for the coder windows. It must be created from a foreground command: a tmux server
# started inside a background task dies with that task.
if tmux has-session -t jobops 2>/dev/null; then ok "tmux session jobops"
elif [ "$fix" = 1 ]; then
  r=$(pwd)
  tmux new-session -d -s jobops -n status -c "$r" "while true; do clear; date; echo; '$r/.claude/bin/llm.sh' status; echo; git -C '$r' status --short; sleep 5; done" \
    && ok "tmux session jobops (started)" || bad "tmux session jobops" "tmux new-session -d -s jobops"
else bad "tmux session jobops" "run: .claude/bin/ready.sh --fix (from a normal terminal)"; fi

# Dependencies and tools the checks need.
[ -d node_modules ] && ok "node_modules" || bad "node_modules" "npm install"
command -v go >/dev/null 2>&1 && ok "go toolchain" || bad "go toolchain"
command -v aider >/dev/null 2>&1 && ok "aider" || bad "aider" "uv tool install aider-chat"
[ -w .agent-logs ] || mkdir -p .agent-logs
# The test database is in-memory or temp files (api/test/fixtures.ts); writing a temp file must work.
t=$(mktemp 2>/dev/null) && rm -f "$t" && ok "temp files (test databases)" || bad "temp files (test databases)"

if [ -z "$missing" ]; then echo "READY"; exit 0; fi
echo "NOT READY: $missing"
exit 1
