#!/bin/sh
# Local model servers on llama.cpp (replaces Ollama for the coding agents and
# the knowledge layer). One llama-server per role, bound to 127.0.0.1.
#
#   llm.sh start [coder|coder7|embed|all]   start (default: all = coder + embed)
#   llm.sh stop  [role|all]
#   llm.sh status                           health, model, context, memory
#   llm.sh link                             (re)create readable GGUF links
#
# Roles (OpenAI-compatible API at http://127.0.0.1:<port>/v1):
#   coder   8081  qwen2.5-coder:14b   ctx LLM_CODER_CTX per slot (default 16384), slots
#                 LLM_CODER_SLOTS (default 1), with
#                 speculative decoding LLM_SPEC=draft (default) | ngram | both | none
#   coder7  8083  qwen2.5-coder:7b    ctx 16384 (one-line fixes; never with coder)
#   embed   8082  mxbai-embed-large   embeddings only, CLS pooling
# Models are the GGUF files Ollama already downloaded, linked into
# ~/models/jobops/ (no second download). If Ollama deletes a model, re-link
# from a fresh GGUF. Logs and pids: .agent-logs/llm-<role>.{log,pid}
set -u

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
logs="$root/.agent-logs"
models="${LLM_MODELS_DIR:-$HOME/models/jobops}"
mkdir -p "$logs" "$models"

blob() { ollama show --modelfile "$1" 2>/dev/null | sed -n 's/^FROM //p' | head -1; }

link() {
  for pair in "qwen2.5-coder:14b qwen2.5-coder-14b-instruct-q4_k_m.gguf" \
              "qwen2.5-coder:7b qwen2.5-coder-7b-instruct-q4_k_m.gguf" \
              "qwen2.5:7b qwen2.5-7b-instruct-q4_k_m.gguf" \
              "qwen2.5:14b qwen2.5-14b-instruct-q4_k_m.gguf" \
              "mxbai-embed-large mxbai-embed-large-v1-f16.gguf" \
              "qwen2.5-coder:0.5b qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"; do
    set -- $pair
    src=$(blob "$1")
    if [ -n "$src" ] && [ -f "$src" ]; then ln -sf "$src" "$models/$2"; echo "linked $2"
    elif [ -e "$models/$2" ]; then echo "kept   $2 (no Ollama copy found)"
    else echo "MISSING $1: no GGUF found"; fi
  done
}

# role -> "port model alias extra-args"
spec() {
  case "$1" in
    coder)  # Speculative decoding (LLM_SPEC): the 14B verifies drafted tokens, so the output is
            # the same at temperature 0, only faster.
            #   draft (default): qwen2.5-coder:0.5b drafts. Measured 2026-10-26 (spec-bench.json):
            #     3.5x on edits, 2.3x on new code, identical output.
            #   ngram: drafts from text in the prompt; 3.0x on edits but 0.8x (slower) on new code
            #   both: 3.1x / 1.9x (ngram's misses get in the way); none: off
            spec=""
            dm="$models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"
            ng="--spec-ngram-simple-size-n ${LLM_NGRAM_N:-4} --spec-ngram-simple-size-m ${LLM_NGRAM_M:-32}"
            dr="-md $dm -ngld 99 -ctkd q8_0 -ctvd q8_0 --spec-draft-n-max ${LLM_DRAFT_MAX:-12} --spec-draft-n-min 1 --spec-draft-p-min ${LLM_DRAFT_PMIN:-0.6}"
            case "${LLM_SPEC:-draft}" in
              ngram) spec="--spec-type ngram-simple $ng" ;;
              draft) [ -e "$dm" ] && spec="--spec-type draft-simple $dr" ;;
              both)  [ -e "$dm" ] && spec="--spec-type ngram-simple,draft-simple $ng $dr" ;;
            esac
            # LLM_CODER_SLOTS parallel requests (one per concurrent agent run); the context is
            # 16k per slot, so every run keeps its full window. --cache-reuse lets a new prompt
            # reuse the cached shared prefix (aider's prompt + rules) of the previous one.
            slots=${LLM_CODER_SLOTS:-1}
            echo "8081 qwen2.5-coder-14b-instruct-q4_k_m.gguf qwen2.5-coder-14b -c $(( ${LLM_CODER_CTX:-16384} * slots )) -np $slots --cache-reuse 256 -fa on -ctk q8_0 -ctv q8_0 --jinja --metrics $spec" ;;
    coder7) echo "8083 qwen2.5-coder-7b-instruct-q4_k_m.gguf qwen2.5-coder-7b -c 16384 -np 1 -fa on -ctk q8_0 -ctv q8_0 --jinja --metrics" ;;
    embed)  echo "8082 mxbai-embed-large-v1-f16.gguf mxbai-embed-large --embeddings --pooling cls -c 512 -b 512 -ub 512 -np 1" ;;
    *) return 1 ;;
  esac
}

healthy() { curl -sf "http://127.0.0.1:$1/health" > /dev/null 2>&1; }

start() {
  role=$1
  s=$(spec "$role") || { echo "unknown role: $role"; return 1; }
  set -- $s; port=$1; file=$2; alias=$3; shift 3
  pidf="$logs/llm-$role.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then echo "$role already running (pid $(cat "$pidf"))"; return 0; fi
  [ -e "$models/$file" ] || link > /dev/null
  [ -e "$models/$file" ] || { echo "$role: model file missing: $models/$file"; return 1; }
  nohup llama-server -m "$models/$file" --alias "$alias" --host 127.0.0.1 --port "$port" -ngl 99 "$@" \
    >> "$logs/llm-$role.log" 2>&1 &   # append: a restart must not discard evidence
  echo $! > "$pidf"
  i=0
  while ! healthy "$port"; do
    kill -0 "$(cat "$pidf")" 2>/dev/null || { echo "$role: server exited; see $logs/llm-$role.log"; tail -5 "$logs/llm-$role.log"; return 1; }
    i=$((i + 1)); [ "$i" -gt 180 ] && { echo "$role: not healthy after 180s"; return 1; }
    sleep 1
  done
  echo "$role ready on http://127.0.0.1:$port/v1 (model $alias, pid $(cat "$pidf"))"
}

stop() {
  pidf="$logs/llm-$1.pid"
  if [ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null; then echo "stopped $1"; else echo "$1 not running"; fi
  rm -f "$pidf"
}

status() {
  for role in coder coder7 embed; do
    set -- $(spec "$role"); port=$1
    pidf="$logs/llm-$role.pid"
    if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
      rss=$(ps -o rss= -p "$(cat "$pidf")" | awk '{printf "%.1f GB", $1/1048576}')
      ctx=$(curl -s "http://127.0.0.1:$port/props" | python3 -c 'import json,sys
try: p=json.load(sys.stdin); print(p.get("default_generation_settings",{}).get("n_ctx","?"))
except Exception: print("?")')
      h=down; healthy "$port" && h=healthy
      echo "$role  :$port  $h  ctx=$ctx  rss=$rss  pid=$(cat "$pidf")"
    else
      echo "$role  :$port  stopped"
    fi
  done
}

cmd=${1:-status}; what=${2:-all}
case "$cmd" in
  link) link ;;
  start) if [ "$what" = all ]; then start coder && start embed; else start "$what"; fi ;;
  stop) if [ "$what" = all ]; then for r in coder coder7 embed; do stop "$r"; done; else stop "$what"; fi ;;
  status) status ;;
  *) echo "usage: llm.sh start|stop [coder|coder7|embed|all] | status | link"; exit 2 ;;
esac
