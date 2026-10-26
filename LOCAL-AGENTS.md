# Local coding agents: orchestration, limits, and rules

How JobOps runs its local coders (aider and mini-swe-agent on Ollama): which
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

## Known gap: mini-swe-agent has no context setting

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
