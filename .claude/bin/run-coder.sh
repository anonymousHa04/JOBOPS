#!/bin/sh
# Run a local coder (aider + llama.cpp) in its own window of the "jobops" tmux session.
# Usage: run-coder.sh <task> <spec-file> <file-to-edit>...
# Watch:  tmux attach -t jobops     Wait: tmux wait-for <task>
# Specs and read-only files must not contain ``` fences: aider then switches to
# ```` fences, the 7B model keeps answering with ```, and the edit is silently dropped.
#
# Model server: llama.cpp via .claude/bin/llm.sh (started here if it is down).
#   CODER_MODEL  openai/qwen2.5-coder-14b (default, server "coder", :8081)
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
server=coder; port=8081
# whole = rewrite each file in full (default). diff = search/replace blocks: less output,
# but in Phase 4 round 1 aider wrote new files to a doubled path and its SEARCH blocks
# failed to match in repairs; with speculative decoding, whole is ~3.5x faster than before.
# Edit format by size unless set: whole-file edits echo the file back (two copies in the
# window), so files over 150 lines use search/replace (diff). The A/B test decides diff vs udiff.
biggest=0
for f in "$@"; do [ -f "$f" ] && n=$(wc -l < "$f") && [ "$n" -gt "$biggest" ] && biggest=$n; done
if [ "$biggest" -gt "${CODER_WHOLE_MAX_LINES:-150}" ]; then edit_format=${CODER_EDIT_FORMAT:-diff}; else edit_format=${CODER_EDIT_FORMAT:-whole}; fi
logs="$root/.agent-logs"
mkdir -p "$logs"
rm -f "$logs/$task.done" "$logs/$task.exit" "$logs/$task.context.md" "$logs/$task.context.json"

# Model servers must be up before anything else (fail loudly, not mid-run).
"$bin/llm.sh" start "$server" > "$logs/$task.llm.log" 2>&1 || { cat "$logs/$task.llm.log"; exit 1; }

# Context-pack budget from the window (2026-10-29: fixed 4500 overflowed 16k in lint retries):
# window - target files (twice for whole-file edits) - spec - rules (~1.2k) - room for the
# answer and two short lint rounds (~3k), kept between 1500 and 3000 tokens.
context_budget() {
  window=${LLM_CODER_CTX:-16384}
  files=0; for f in "$@"; do [ -f "$f" ] && files=$((files + $(wc -c < "$f") / 4)); done
  [ "$edit_format" = whole ] && files=$((files * 2))
  spec_t=$(( $(wc -c < "$spec") / 4 ))
  b=$((window - files - spec_t - 1200 - 3000))
  [ "$b" -gt 3000 ] && b=3000
  # Fix rounds carry errors, diff, lessons, and self-review in their spec: a small pack is enough.
  case "$task" in *-fix[0-9]*) [ "$b" -gt 1500 ] && b=1500 ;; esac
  [ "$b" -lt 1500 ] && b=1500
  echo "$b"
}
# aider's automatic lint retries resend the whole chat each time (7k -> 10k -> 12k in one attempt,
# 2026-10-29), so they are off by default: one clean shot per attempt, and autofix's fix rounds retry
# from a fresh session with compact errors, self-review, the previous diff, and lessons.
# Prompt cache: llama.cpp reuses the longest identical start of the previous request. aider adds
# read-only files in an unstable order (the task's context pack landed between the rule files), so
# almost nothing was reused (2026-10-29: 42.6k tokens processed for 36.5k sent). The fixed rules
# (coder.md, coder-patterns.md, report-format.md) go into the model's system_prompt_prefix instead:
# always first, always the same, so every request starts with the same cached block.
settings="$logs/$task.model-settings.yml"
"$(head -1 "$(command -v aider)" | sed 's/^#!//')" - "$agents" "$settings" <<'PY'
import json, sys, yaml
agents, out = sys.argv[1], sys.argv[2]
rules = "\n\n".join(open("%s/%s" % (agents, f)).read().strip() for f in ("coder.md", "coder-patterns.md", "report-format.md"))
models = yaml.safe_load(open(agents + "/aider.model.settings.yml"))
for m in models:
    m["system_prompt_prefix"] = rules
open(out, "w").write(json.dumps(models, indent=1))
PY

# aider adds any repo file whose name comes up in the chat (--yes-always answers its "Add file?"),
# which pulled whole test files into a fix round (16k input, 2026-10-29). A per-task aiderignore
# hides every repo file except the task's own ("*" then "!<file>"; a "!*/" line would re-include
# every file, pathspec semantics); read-only context (--read) is not affected.
ignore="$logs/$task.aiderignore"
{ echo '*'; for f in "$@"; do echo "!$f"; done; } > "$ignore"
if [ "${CODER_AUTO_LINT:-0}" = 1 ]; then lint_flags="--auto-lint --lint-cmd 'typescript: $bin/tsc-lint.sh'"; else lint_flags="--no-auto-lint"; fi
context_read="--read $logs/api-map.md"
"$bin/api-map.sh" >/dev/null
if [ "${KNOWLEDGE:-1}" = 1 ]; then
  "$bin/llm.sh" start embed >> "$logs/$task.llm.log" 2>&1 || true
  # Qdrant (Docker) must be up: without it the context pack silently lost its semantic part and
  # coders guessed imports and test style (2026-10-30, Docker down after a restart).
  qdrant=${QDRANT_URL:-http://localhost:6333}
  if ! curl -s -m3 "$qdrant/collections" >/dev/null 2>&1; then
    docker compose -f "$root/infra/qdrant/docker-compose.yml" up -d >> "$logs/$task.llm.log" 2>&1
    for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m2 "$qdrant/collections" >/dev/null 2>&1 && break; sleep 2; done
  fi
  if ! curl -s -m3 "$qdrant/collections" >/dev/null 2>&1; then
    echo "RUN-CODER: QDRANT DOWN (start Docker Desktop, then: docker compose -f infra/qdrant/docker-compose.yml up -d)" | tee "$logs/$task.log"
    echo 1 > "$logs/$task.exit"; touch "$logs/$task.done"; exit 1
  fi
  new=""
  for f in "$@"; do [ -s "$f" ] || new="$new $f"; done
  # shellcheck disable=SC2086
  if python3 "$knowledge/retrieve.py" context --spec "$spec" --files "$@" ${new:+--new $new} \
       --budget "${CONTEXT_BUDGET:-$(context_budget "$@")}" --format md --out "$logs/$task.context.md" \
       --log "$logs/$task.context.json" > "$logs/$task.context.err" 2>&1; then
    echo ok > "$logs/$task.context.status"
    context_read="--read $logs/$task.context.md"
  else
    echo "failed: $(tail -1 "$logs/$task.context.err" 2>/dev/null)" > "$logs/$task.context.status"
  fi
else
  echo off > "$logs/$task.context.status"
fi

# Dependency context bundle (pipeline.py prepare writes it): allowed dependencies, the names that
# already exist in the target's package, and the signatures of names the spec mentions.
bundle_read=""
[ -f "$logs/$task.bundle.md" ] || cp "$logs/${task%-fix*}.bundle.md" "$logs/$task.bundle.md" 2>/dev/null
[ -f "$logs/$task.bundle.md" ] && bundle_read="--read $logs/$task.bundle.md"

if ! tmux has-session -t jobops 2>/dev/null; then
  tmux new-session -d -s jobops -n status -c "$root" \
    "while true; do clear; date; echo; '$bin/llm.sh' status; echo; git -C '$root' status --short; sleep 5; done"
fi

tmux new-window -t jobops -n "$task" -c "$root" \
  "{ echo 'KNOWLEDGE: context $(cat "$logs/$task.context.status")'; \
     OPENAI_API_BASE='http://127.0.0.1:$port/v1' OPENAI_API_KEY=local \
     aider --model '$model' --edit-format '$edit_format' --no-auto-commits --yes-always --no-suggest-shell-commands --no-detect-urls \
     --no-check-update --no-analytics --no-show-model-warnings --no-gitignore \
     --model-settings-file '$settings' --model-metadata-file '$agents/aider.model.metadata.json' \
     --aiderignore '$ignore' --map-tokens 0 --max-chat-history-tokens ${CODER_HISTORY_TOKENS:-2500} \
     $context_read $bundle_read \
     $lint_flags \
     --message-file '$spec' $*; echo \$? > '.agent-logs/$task.exit'; } 2>&1 | tee '.agent-logs/$task.log'; \
   grep -q 'Applied edit' '.agent-logs/$task.log' || echo 'RUN-CODER: NO EDIT APPLIED' | tee -a '.agent-logs/$task.log'; \
   grep -qiE 'exceeds the available context size|ContextWindowExceeded' '.agent-logs/$task.log' && echo 'RUN-CODER: CONTEXT OVERFLOW (a request exceeded the model window)' | tee -a '.agent-logs/$task.log'; \
   for f in $*; do [ -s \"\$f\" ] || echo \"RUN-CODER: TARGET MISSING OR EMPTY: \$f\" | tee -a '.agent-logs/$task.log'; done; \
   [ -d path/to ] && echo 'RUN-CODER: STRAY path/to/ CREATED' | tee -a '.agent-logs/$task.log'; \
   touch '.agent-logs/$task.done'; tmux wait-for -S '$task'"
echo "started $task (tmux window jobops:$task)"
