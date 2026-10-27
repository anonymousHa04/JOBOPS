# Local coding agents: orchestration, limits, and rules

> **Current state of all work:** `.claude/knowledge/status.yaml` <!-- .claude/knowledge/status.yaml --> (structured,
> searchable with `retrieve.py`). **Since 2026-10-26 the agents run on llama.cpp, not
> Ollama:** see the llama.cpp section below; Ollama references further down describe the earlier setup.

How JobOps runs its local coders (aider and mini-swe-agent on llama.cpp): which
scripts call what, where context limits and coding rules are set, and one known
gap. Last updated 2026-10-25. Related: `M3-NOTES.md` <!-- M3-NOTES.md --> (what failed
in Milestone 3 and why).

## Call flow

    run-plan.sh <plan> [start-task]
      Splits the plan into one spec per task, runs tasks in order,
      stops at "gate: user", commits each passing task.
      └─ autofix.sh <task> <spec> <files>
           Picks the runner, enforces the time limit, runs check.sh,
           optional fix rounds.
           ├─ run-coder.sh  → aider           new or empty target files; tmux window jobops:<task>
           ├─ run-mini.sh   → mini-swe-agent  edits and fix rounds; throwaway worktree ../jobops-mini-<task>
           └─ check.sh                        typecheck + npm test + go vet/test, with fix hints

Watch live: `tmux attach -t jobops`. Logs: `.agent-logs/<task>.log`.

## Scripts (`.claude/bin/`)

| Script | What it does |
|---|---|
| `run-plan.sh` <!-- .claude/bin/run-plan.sh --> | Plan runner. Format: `## task: <id>`, `files: <paths>`, optional `gate: user`, then the spec text. Stops at the first escalation or gate. Auto-commits each passing task with co-author lines (`COMMIT=0` turns this off). Resume with `run-plan.sh <plan> <task-id>`. |
| `autofix.sh` <!-- .claude/bin/autofix.sh --> | Per-task loop. Runner: `aider` if any target file is new or empty, otherwise `mini` (override with `FIRST_RUNNER`). Kills the coder after `CODER_TIMEOUT` seconds (default 1200). Runs `check.sh`. With `MAX_FIXES>0` (default 0), writes a fix spec (check report plus original spec) and runs `FIX_RUNNER` (default `mini`). Exit 0 = pass, 1 = escalate to the manager. |
| `run-coder.sh` <!-- .claude/bin/run-coder.sh --> | Starts aider. Rebuilds the API map first. Afterwards flags `NO EDIT APPLIED`, an empty target, or a stray `path/to/` folder. |
| `run-mini.sh` <!-- .claude/bin/run-mini.sh --> | Starts mini-swe-agent in a worktree holding HEAD plus uncommitted and untracked files (git-ignored files such as `profile/` are not copied). Copies the diff back only if the agent touched nothing outside the task's files and `check.sh` passes in the worktree. |
| `check.sh` <!-- .claude/bin/check.sh --> | The gate: typecheck error count, test pass/fail, Go vet/test (when `jd-search/go.mod` exists), matching fix hints, and `RUN-CODER:`/`RUN-MINI:` flags. Prints at most ~45 lines; full output in `.agent-logs/<task>.check.log`. |
| `tsc-lint.sh` <!-- .claude/bin/tsc-lint.sh --> | aider lint hook: whole-project typecheck, errors for the edited files only, plus hints. Exit 1 makes aider fix and retry. |
| `hints.sh` <!-- .claude/bin/hints.sh --> | Prints the hint for every pattern in `fix-hints.yaml` that matches the error text on stdin. |
| `api-map.sh` <!-- .claude/bin/api-map.sh --> | Writes `.agent-logs/api-map.md`: one line per export in `api/src`, so the coder imports real names and paths. |

### aider invocation (run-coder.sh)

    aider --model ollama_chat/qwen2.5-coder:14b --edit-format whole \
      --no-auto-commits --yes-always --no-suggest-shell-commands \
      --no-check-update --no-analytics --no-show-model-warnings \
      --read .claude/agents/coder.md \
      --read .claude/agents/coder-patterns.md \
      --read .agent-logs/api-map.md \
      --auto-lint --lint-cmd 'typescript: .claude/bin/tsc-lint.sh' \
      --message-file <spec> <files>

Model override: `CODER_MODEL`. Edit format override: `CODER_EDIT_FORMAT`
(`whole` rewrites the file; `diff` uses search/replace blocks).

### mini-swe-agent invocation (run-mini.sh)

    mini -c mini_textbased.yaml -c model.model_class=litellm_textbased \
      -m ollama_chat/qwen2.5-coder:14b -y --exit-immediately -l 0 \
      -t "<spec> + coder-patterns.md + api-map.md"

Model override: `MINI_MODEL`. Env: `MSWEA_COST_TRACKING=ignore_errors`,
`MSWEA_CONFIGURED=true`.

## Context limits and coding rules

| File | Defines |
|---|---|
| `.aider.model.settings.yml` <!-- .aider.model.settings.yml --> | `num_ctx: 8192` for `qwen2.5-coder:14b`, `qwen2.5:14b`, `qwen2.5-coder:7b`. Applies to **aider only**. |
| `~/Library/LaunchAgents/com.user.ollama-env.plist` | Ollama server: `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=3`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`. No context length set. |
| `mini_textbased.yaml` (bundled; `~/.local/share/uv/tools/mini-swe-agent/lib/python3.12/site-packages/minisweagent/config/`) | mini's system prompt and loop: `step_limit: 0` (unlimited), `cost_limit: 3` (ignored because cost tracking is off), command output over 10,000 characters truncated. No `num_ctx`. |
| `.claude/agents/coder.md` <!-- .claude/agents/coder.md --> | Role rules: change only the named files, no dependencies, no commits, no tests unless the spec asks, no secrets or resume data. |
| `.claude/agents/coder-patterns.md` <!-- .claude/agents/coder-patterns.md --> | Coding patterns from Milestone 3 mistakes: `.ts` imports, allowed packages, Node 24 built-ins, Zod v4, `unknown` handling, SQLite, YAML, and a pre-finish checklist. |
| `.claude/agents/fix-hints.yaml` <!-- .claude/agents/fix-hints.yaml --> | 13 rules matching an error pattern to a fix hint. Add one whenever a coder repeats a mistake. |
| `.claude/agents/AGENTS.md` <!-- .claude/agents/AGENTS.md --> | Rules for every agent, including rule 7 (Claude manages, local agents code) and rule 8 (one 14B at a time on 16 GB). |
| `.claude/mcp/mini_server.py` <!-- .claude/mcp/mini_server.py --> | MCP wrapper so Claude can call mini directly (`run_mini`, `check`). Not used by the plan runner. |

### Knobs (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `CODER_TIMEOUT` | 1200 | Seconds per coder run before it is killed |
| `MAX_FIXES` | 0 | Automatic fix rounds before escalating |
| `FIRST_RUNNER` / `FIX_RUNNER` | auto / `mini` | Force `aider` or `mini` |
| `CODER_MODEL` / `MINI_MODEL` | `ollama_chat/qwen2.5-coder:14b` | Model per runner |
| `COMMIT` | 1 | Auto-commit each passing task |

## Phase 0: validation (2026-10-26)

From `agentManagementAndFeedbackSystem.md` <!-- agentManagementAndFeedbackSystem.md --> §3. Every attempt is judged
on evidence, never on log text.

| Requirement | Where | What it does |
|---|---|---|
| R0.1 exit codes | `check.sh`, `run-coder.sh`, `run-mini.sh`, `run-fake.sh` | Typecheck, tests, and Go judged by exit status; missing test summary = failed. aider and mini write their exit status to `.agent-logs/<task>.exit`; missing = `unknown`. |
| R0.2 explicit results | `check.sh`, `autofix.sh` | `.agent-logs/<task>.check.json` per check; `.agent-logs/<task>.result.json` per task: `passed`, `failed`, `timed_out`, or `unknown`, a reason, and every attempt (runner, exit, boundary, check). |
| R0.3 final patch | `apply-patch.sh` | mini's patch must apply cleanly, then its reverse must apply (the tree holds exactly the validated patch). autofix then checks the main tree again. |
| R0.4 boundaries | `tree-snapshot.sh`, `autofix.sh` | Snapshot (path + hash) before and after every runner. A changed file outside the task's files, or no task file changed, fails the attempt. Applies to aider, mini, and fake. |
| R0.5 observability | all | No swallowed exit codes; the failure reason is kept in the result file. |
| Config findings | `run-mini.sh` | mini runs with `agent.step_limit=40` (`MINI_STEP_LIMIT`) and `model.model_kwargs.num_ctx=8192` (`MINI_NUM_CTX`); the API map is built from the main tree before launch. |

**Acceptance test:** `.claude/bin/phase0-selftest.sh` runs 12 scenarios with a
fake coder in a throwaway worktree (`../jobops-phase0-selftest`, removed after):
pass, coder exit 3, lost exit status, type error, failing test, timeout, no
change, file outside the boundary, tsc crash with no output, no test summary,
invalid patch, valid patch. All 12 report correctly (2026-10-26).

Not yet verified against a real run: that mini honors `num_ctx=8192` (check the
CONTEXT column of `ollama ps` during the next mini run).

## Phase 1: Agent Knowledge Layer, exact + structural (2026-10-26)

From `agentManagementAndFeedbackSystem.md` <!-- agentManagementAndFeedbackSystem.md --> §4. Not yet wired into
aider or mini (that is Phase 2).

| Part | Where | What |
|---|---|---|
| Interface | `.claude/knowledge/retrieve.py context --spec F --files ... [--new ...] [--budget 3000] [--format json\|md]` | `retrieve_context(task, repo, limits)`. JSON for logs; Markdown for agents (indented blocks, no code fences). `status: ok` or `status: error` with the reason (exit 1); an empty section is reported as `empty`, never as an error. |
| Exact search | SQLite FTS5 (BM25) in memory | Chunks: one per top-level declaration in code, one per heading in Markdown. Plus an exact table of exported symbols. `retrieve.py search "<words>"`. |
| Structure | own import parser (TS `import`/`export from`, Go `jobops/jd-search/...`) | `deps` / `rdeps`; definitions of imported names with same-file helpers (3 levels); each touched module's export list; consumers' usage lines; tests that import a module. `retrieve.py deps\|rdeps <file>`. TypeScript 7 ships no JS compiler API, hence the parser. |
| Known fixes | `.claude/knowledge/fixes.jsonl` | Failure signature, terms, file globs, root cause, resolution, evidence, limitations, status (`observed`, `hypothesis`, `verified`, `regression-tested`, `rejected`). Seeded with 9 M3 records: 6 verified, 3 hypotheses. Rejected/outdated records are never retrieved. |
| Corpus | git-tracked + untracked-not-ignored files | Denylist: `profile/`, `data/`, `node_modules/`, `graphify-out/`, `.scout/`, `.agent-logs/`, `.claude/specs/`, `.env*`, keys, secrets, lock files. Rebuilt on every call (~63 files, ~370 chunks), so never stale. |
| Evidence classes | every item | `requirement` (task, README, requierements/), `source_fact` (repo), `verified_fix`, `hypothesis` (observed or unproven fixes), `outdated`. |
| Priority | package order | task → constraints (edit boundary, installed packages) → targets and named symbols → dependencies → consumers → tests + validation → known fixes → related source (BM25) → docs (BM25). Budget in tokens (chars/4); the task and constraints are always kept; anything else past the budget is listed under `dropped`. |

**Evaluation** (`retrieve.py eval`, `.claude/knowledge/eval.json`): 8 real M3
tasks with the original specs, targets treated as not yet written. 5 cases were
used while tuning, 3 are held out (expectations written before running). Result
2026-10-26: 44/44 expected paths, symbols, and fixes retrieved; every package
within budget; no private file leaked. Caveat: the fix records were written
after seeing these failures, so fix matches on the held-out cases are not fully
independent; path and symbol hits are the fairer signal.

Semantic search (embeddings, vector store) is Phase 2; it plugs in as another
method and never overrides the task or constraints.

## Shared skills for local coders (2026-10-27)

Skills in `.agents/skills/` (shared with other agent tools; `.claude/skills/` holds
the Claude Code copies) are indexed by the knowledge layer as requirements. aider and
mini cannot load skills, so each context package has a **playbook** section: the 1-2
skill sections that best match the task by exact search (e.g. m3-notes "Content
equivalence" and "Tests" for an equivalence task). `.claude/skills/` is not indexed,
so results are not duplicated. For product code (`api/`, `jd-search/`) every
package also carries `.agents/skills/m3-notes/references/decisions.md` in full: the
digest of every agreed decision, so no decision depends on a search hit.

## Phase 3: feedback loop (2026-10-26)

Branch `feedback`. From `agentManagementAndFeedbackSystem.md` <!-- agentManagementAndFeedbackSystem.md --> §6.

| Part | Where | What |
|---|---|---|
| Outcome record | `feedback.py attempt`, `<task>.attempts.jsonl`, `<task>.result.json` | Per attempt: runner, strategy, exit, timeout, check, context status and tokens, errors, failing tests, **failure signature** (normalized file + error code + message), **category** (the 9 of §6.4, from evidence rules; `unknown` allowed), fixes supplied, and the **agent_claim**. |
| Agent claims | `.claude/agents/report-format.md` (aider), `mini -o <task>.traj.json` | aider ends with `STATUS: done\|blocked` and `BLOCKERS:`; mini's trajectory gives its stop reason and last message. Stored as claims, never as evidence of success. |
| Repair | `feedback.py repair-spec`, `FIX_RUNNER=aider` | A fresh session per round with only the errors, hints, matching known fixes (by signature), the previous claim, and the original task. |
| Stop rules | `feedback.py decide` | Escalate on a timeout; on environment, unreliable validation, or missing context (a retry cannot fix those); on the same failure signature twice; at `MAX_FIXES` (default 1). |
| Escalation | `<task>.escalation.json`, main `.agent-logs/escalations.jsonl` | Category and basis, what was tried per attempt, last errors and flags, agent claim, next owner (manager), suggested next step, evidence files. |
| Fix promotion | `feedback.py finish` → `.claude/knowledge/fixes.jsonl` | A fix supplied in a repair round that then passed, with a signature matching the errors it was given for, moves `observed`/`hypothesis` → `verified` with evidence; a fix that did not help gets a "did not resolve" note (rejection stays a manager decision). |
| Metrics feed | main `.agent-logs/outcomes.jsonl` | One line per task: status, attempts, repair rounds, first-attempt pass, category, context tokens, errors per attempt (Phase 4). |

Self-test: `phase0-selftest.sh` now runs 25 checks (Phase 0 + feedback loop) with
`FEEDBACK_FIXES` and `FEEDBACK_MAIN_LOGS` pointed at throwaway copies.

## llama.cpp switch (2026-10-26)

Branch `agents/llama-cpp`. The agents and the knowledge layer run on llama.cpp
(Homebrew `llama.cpp` 0.7.0, build 11669). Ollama stays installed only for the
JobOps product code until `api/src/model/ollama.ts` moves over (status.yaml:
`product-provider-llama-cpp`).

| Part | Where | What |
|---|---|---|
| Servers | `.claude/bin/llm.sh start\|stop\|status [coder\|coder7\|embed\|all]` | One `llama-server` per role on 127.0.0.1: `coder` :8081 (qwen2.5-coder-14b, 16k context, q8 KV, flash attention), `coder7` :8083 (7B, never with `coder`), `embed` :8082 (mxbai-embed-large, CLS pooling, 512 tokens). Logs and pids in `.agent-logs/llm-<role>.*`. |
| Models | `~/models/jobops/*.gguf` | Links to the GGUF files Ollama already downloaded (`llm.sh link`); no second download. |
| aider | `run-coder.sh`, `.claude/agents/aider.model.settings.yml`, `aider.model.metadata.json` | `openai/qwen2.5-coder-14b` via `OPENAI_API_BASE`; repo map off (`--map-tokens 0`), chat history capped at 2,048 tokens, context package budget 3,500 tokens. Starts the server if it is down. |
| mini | `run-mini.sh` | Same server via `model.model_kwargs.api_base`; step limit 40; spec may be relative or absolute; a missing spec fails; an exit status is always recorded. |
| Embeddings | `retrieve.py` | `/v1/embeddings` on :8082; each text trimmed to 500 tokens with the server's tokenizer (llama.cpp rejects longer input instead of truncating). `EMBED_BACKEND=ollama` switches back. Vectors match Ollama's (cosine 1.0000). |
| Overflow | server + `run-coder.sh` | A request above the window gets HTTP 400; the run log gets `RUN-CODER: CONTEXT OVERFLOW`, so the check fails with that reason. |

Verified 2026-10-26: chat, JSON-schema output, embeddings, overflow rejection;
smoke-aider passed (4.4k tokens, 55 s); smoke-mini ran and its model mistake was
caught by the worktree check (nothing merged); Phase 0 self-test 12/12; eval 44/44.

## Phase 2 (part 1): semantic search (2026-10-26)

| Part | What |
|---|---|
| Vector store | Qdrant `v1.19.2` in Docker: `infra/qdrant/docker-compose.yml`. Ports bound to `127.0.0.1` (6333 HTTP, 6334 gRPC), data in `data/qdrant/` (git-ignored), telemetry off, 1 GB memory cap (~270 MB in use). Start: `docker compose -f infra/qdrant/docker-compose.yml up -d`. |
| Embeddings | `mxbai-embed-large` (Ollama, 1024 dimensions, ~670 MB). Queries get mxbai's search prefix; documents don't. Chunks are cut to ~1,800 characters (the model reads ~512 tokens). |
| Index | `retrieve.py embed-index` syncs collection `jobops_knowledge` with the corpus: point id = hash of path + start line + content, so only new or changed chunks are embedded and removed chunks are deleted. First build: 378 chunks in ~20 s. |
| Retrieval | `retrieve.py semantic "<query>"`; in context packages a `semantic` section (up to 3 items, cosine ≥ 0.55) comes after exact and structural evidence and never above the task or constraints. Vectors whose chunk no longer matches the current files are ignored. `--no-semantic` turns it off. |
| Failure | If Ollama or Qdrant is down, the `semantic` section reports `error` with the reason and the rest of the package is built as usual. |

Eval with semantic on: 44/44 still retrieved; semantic adds 1–3 items per task within budget.
Not done yet: wiring the context package into aider and mini (next), re-running `embed-index` automatically.

## Known gap (addressed in Phase 0): mini-swe-agent had no context setting

The 8k context in `.aider.model.settings.yml` applies only to aider.
mini-swe-agent calls Ollama through LiteLLM with no `num_ctx`, and the Ollama
server has no `OLLAMA_CONTEXT_LENGTH`, so mini runs at Ollama's default context,
which is smaller than 8k. (The exact default for Ollama 0.40.11 has not been
checked.)

mini's first message alone is its system prompt plus the spec, the patterns
file, and the API map. Every command output adds to that. When the
conversation overflows, Ollama silently cuts the oldest part, which includes
the task itself. That matches what happened in Milestone 3: every mini fix round
ran its full 20 minutes, looping on shell quoting and `npm install` attempts.
With `step_limit: 0` and cost tracking off, only the timeout stops it.

**Possible fixes (not applied):**

1. Pass the context to mini: `-c model.model_kwargs.num_ctx=8192` in `run-mini.sh`,
   or a small local config that adds `num_ctx: 8192` and `step_limit: 30`.
2. Or set `OLLAMA_CONTEXT_LENGTH=8192` in the LaunchAgent, so every Ollama client
   gets 8k by default.
3. Either way, check the real context with `ollama ps` (CONTEXT column) during a mini run.
