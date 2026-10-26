#!/bin/sh
# Local model servers on llama.cpp: the coding agents, the knowledge layer, and
# the JobOps product. One llama-server per role, bound to 127.0.0.1.
#
#   llm.sh start [coder|embed|general7|general14|all]   (all = coder + embed)
#   llm.sh stop  [role|all]
#   llm.sh status                           health, model, context, memory
#   llm.sh models                           which model files are present
#
# Roles (OpenAI-compatible API at http://127.0.0.1:<port>/v1):
#   coder      8081  qwen2.5-coder:14b   coding agents; ctx LLM_CODER_CTX per slot (default
#                    16384), slots LLM_CODER_SLOTS (default 1), speculative decoding
#                    LLM_SPEC=draft (default) | ngram | both | none
#   embed      8082  mxbai-embed-large   embeddings only, CLS pooling (knowledge layer)
#   general7   8084  qwen2.5:7b          product: JD parsing, rewording
#   general14  8085  qwen2.5:14b         product: one-time bank build
# Heavy roles (coder, general7, general14) are exclusive: on a 16 GB Mac two of
# them swap, so starting one while another runs is refused (LLM_ALLOW_BOTH=1 overrides).
# Models: real GGUF files in ~/models/jobops/ (copied out of Ollama's store
# 2026-10-26; Ollama is no longer needed). Logs and pids: .agent-logs/llm-<role>.{log,pid}
set -u

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
logs="$root/.agent-logs"
models="${LLM_MODELS_DIR:-$HOME/models/jobops}"
mkdir -p "$logs" "$models"
HEAVY="coder general7 general14"
ALL="coder embed general7 general14"

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
            # LLM_CODER_SLOTS parallel requests; the context is 16k per slot, so every run
            # keeps its full window (2 slots swap on 16 GB with Chrome and VS Code open).
            # --cache-reuse lets a new prompt reuse the cached shared prefix of the previous one.
            slots=${LLM_CODER_SLOTS:-1}
            echo "8081 qwen2.5-coder-14b-instruct-q4_k_m.gguf qwen2.5-coder-14b -c $(( ${LLM_CODER_CTX:-16384} * slots )) -np $slots --cache-reuse 256 -fa on -ctk q8_0 -ctv q8_0 --jinja --metrics $spec" ;;
    embed)     echo "8082 mxbai-embed-large-v1-f16.gguf mxbai-embed-large --embeddings --pooling cls -c 512 -b 512 -ub 512 -np 1" ;;
    general7)  echo "8084 qwen2.5-7b-instruct-q4_k_m.gguf qwen2.5-7b -c 16384 -np 1 --cache-reuse 256 -fa on -ctk q8_0 -ctv q8_0 --jinja --metrics" ;;
    general14) echo "8085 qwen2.5-14b-instruct-q4_k_m.gguf qwen2.5-14b -c 16384 -np 1 --cache-reuse 256 -fa on -ctk q8_0 -ctv q8_0 --jinja --metrics" ;;
    *) return 1 ;;
  esac
}

running() { [ -f "$logs/llm-$1.pid" ] && kill -0 "$(cat "$logs/llm-$1.pid")" 2>/dev/null; }
healthy() { curl -sf "http://127.0.0.1:$1/health" > /dev/null 2>&1; }

start() {
  role=$1
  s=$(spec "$role") || { echo "unknown role: $role"; return 1; }
  set -- $s; port=$1; file=$2; alias=$3; shift 3
  pidf="$logs/llm-$role.pid"
  if running "$role"; then echo "$role already running (pid $(cat "$pidf"))"; return 0; fi
  case " $HEAVY " in *" $role "*)
    for other in $HEAVY; do
      if [ "$other" != "$role" ] && running "$other" && [ "${LLM_ALLOW_BOTH:-0}" != 1 ]; then
        echo "$role: refused while $other is running (both do not fit in 16 GB). Run: llm.sh stop $other"
        return 1
      fi
    done ;;
  esac
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
  for role in $ALL; do
    set -- $(spec "$role"); port=$1
    if running "$role"; then
      pid=$(cat "$logs/llm-$role.pid")
      rss=$(ps -o rss= -p "$pid" | awk '{printf "%.1f GB", $1/1048576}')
      ctx=$(curl -s "http://127.0.0.1:$port/props" | python3 -c 'import json,sys
try: p=json.load(sys.stdin); print(p.get("default_generation_settings",{}).get("n_ctx","?"))
except Exception: print("?")')
      h=down; healthy "$port" && h=healthy
      echo "$role  :$port  $h  ctx=$ctx  rss=$rss  pid=$pid"
    else
      echo "$role  :$port  stopped"
    fi
  done
}

models_check() {
  for role in $ALL; do
    set -- $(spec "$role"); f=$2
    if [ -f "$models/$f" ] && [ ! -L "$models/$f" ]; then echo "ok       $f ($(du -h "$models/$f" | cut -f1))"
    else echo "MISSING  $f (needed by $role)"; fi
  done
  d="$models/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"
  [ -f "$d" ] && echo "ok       $(basename "$d") (draft model for coder)" || echo "MISSING  $(basename "$d") (draft model; coder runs without speculative decoding)"
}

cmd=${1:-status}; what=${2:-all}
case "$cmd" in
  start) if [ "$what" = all ]; then start coder && start embed; else start "$what"; fi ;;
  stop) if [ "$what" = all ]; then for r in $ALL; do stop "$r"; done; else stop "$what"; fi ;;
  status) status ;;
  models) models_check ;;
  *) echo "usage: llm.sh start|stop [coder|embed|general7|general14|all] | status | models"; exit 2 ;;
esac
