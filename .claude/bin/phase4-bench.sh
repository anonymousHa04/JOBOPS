#!/bin/sh
# Phase 4 measurement runs (.claude/knowledge/phase4.yaml).
# Usage: phase4-bench.sh <repetitions> [task-id...]     e.g. phase4-bench.sh 2
#        (task ids: m3-02 m3-03 m3-05 m3-07 m3-08; default all)
# Each run: throwaway worktree at the task's base commit, the original plan
# spec with its shared rules, autofix.sh with its defaults. Evidence goes to
# .agent-logs/runs/phase4/<run-id>/ and one line per run to
# .agent-logs/phase4/runs.jsonl. Score with: python3 .claude/bin/metrics.py
set -u
reps=${1:-2}; shift 2>/dev/null || true
bin=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$bin/../.." && pwd)
out="$root/.agent-logs/phase4"
mkdir -p "$out/specs" "$root/.agent-logs/runs/phase4"

# task id | base commit | target | spec name in plan-m3.md
table='m3-02 82ca80a api/src/requirements/schema.ts m3-02-requirements-schema
m3-03 9a1ff38 api/src/model/ollama.ts m3-03-model-provider
m3-05 d12c3f2 api/src/profile/bank.ts m3-05-bank
m3-07 0655814 api/src/db.ts m3-07-requirements-table
m3-08 f1917f8 api/src/requirements/parse.ts m3-08-jd-parse'
want=${*:-m3-02 m3-03 m3-05 m3-07 m3-08}

# Specs exactly as run-plan.sh writes them today: shared rules + the task's text.
awk -v dir="$out/specs" '
  /^## task: / { id = $3; out = dir "/" id ".md"; print "# Task " id > out
                 if (shared != "") print "\n## Shared rules (apply to every task)\n" shared "\n## This task" >> out; next }
  id == "" { shared = shared $0 "\n"; next }
  /^files: / || /^gate: / { next }
  id != "" { print >> out }
' "$root/.claude/specs/plan-m3.md"

# Validation reliability is measured before the runs.
"$bin/phase0-selftest.sh" > "$out/selftest.txt" 2>&1; tail -1 "$out/selftest.txt"
"$bin/llm.sh" start coder > /dev/null && "$bin/llm.sh" start embed > /dev/null

rep=1
while [ "$rep" -le "$reps" ]; do
  printf '%s\n' "$table" | while read -r task base target specname; do
    case " $want " in *" $task "*) ;; *) continue ;; esac
    run="p4-$task-r$rep"
    wt="$root/../jobops-$run"
    git -C "$root" worktree remove --force "$wt" 2>/dev/null
    git -C "$root" worktree add -q --detach "$wt" "$base" || { echo "$run: worktree failed"; continue; }
    ln -s "$root/node_modules" "$wt/node_modules"
    mkdir -p "$wt/.agent-logs"   # git-ignored, so absent in a fresh worktree
    start=$(date +%s)
    (cd "$wt" && "$bin/autofix.sh" "$run" "$out/specs/$specname.md" "$target" > "$wt/.agent-logs/$run.autofix.out" 2>&1)
    wall=$(( $(date +%s) - start ))
    dest="$root/.agent-logs/runs/phase4/$run"
    rm -rf "$dest"; mkdir -p "$dest"
    cp "$wt"/.agent-logs/"$run"* "$dest"/ 2>/dev/null
    [ -f "$wt/$target" ] && cp "$wt/$target" "$dest/$(basename "$target").result"
    status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$dest/$run.result.json" 2>/dev/null || echo harness_error)
    printf '{"run": "%s", "task": "%s", "rep": %s, "base": "%s", "wall_s": %s, "status": "%s", "at": "%s"}\n' \
      "$run" "$task" "$rep" "$base" "$wall" "$status" "$(date +%Y-%m-%dT%H:%M:%S)" >> "$out/runs.jsonl"
    echo "$run: $status in ${wall}s"
    rm -f "$wt/node_modules"; git -C "$root" worktree remove --force "$wt"
    # No result file means the harness, not the agent, failed: stop the batch
    # instead of recording more empty runs (exit 3 from the subshell).
    if [ "$status" = harness_error ]; then
      echo "HARNESS ERROR in $run (no result file); stopping. See $dest/$run.autofix.out"
      exit 3
    fi
  done || exit 3
  rep=$((rep + 1))
done
echo "done; score with: python3 $bin/metrics.py"
