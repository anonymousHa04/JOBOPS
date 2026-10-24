# JobOps status

Handoff for the next session. Update this file at the end of every milestone
(and whenever a decision changes), in the same commit.

Last updated: 2026-10-25, after Milestone 2 and the coder-tooling work.

## Where things are

- Branch: `dev` (work happens here; `main` holds only the first commit).
- Done:
  - **Milestone 1: working job API** (`6e00af5`). `POST /jobs`, `GET /jobs/:id`;
    Fastify + Zod v4 + SQLite (better-sqlite3); TypeScript run directly by Node 24.
  - **Milestone 2: search and deduplication** (`5f9e354`). `GET /jobs` with
    filters and paging; dedup by source URL or content fingerprint (repeat → 200,
    edited posting at a known URL → updated in place); LIKE wildcards escaped.
  - **Coder tooling** (`b342025`, `aef5fad`, `6e0013e`). See "How work gets done".
- Tests: 22 passing (`npm test`), typecheck clean (`npm run typecheck`).
- Graph: `graphify-out/` updated after the tooling work (2026-10-25).

## Where to start next

**Milestone 3: candidate profile and matching** (README → Implementation roadmap):
1. Load an approved resume/profile representation.
2. Extract job requirements into a validated structure.
3. Implement an initial deterministic matching baseline.
4. Return strengths, gaps, and evidence rather than only a single score.

Before writing the Milestone 3 plan, settle these with the user:
- Where the resume/profile lives (`profile/resume.md` was planned) and its
  format; add `profile/` to `.gitignore` (README: never commit resumes).
- Requirement extraction for M3 is deterministic/keyword-based; the local LLM
  arrives in Milestone 4 (README model roles). Confirm that split.
- An embedding model (e.g. `nomic-embed-text`) and Laya are not installed and
  are not needed until retrieval/judging work; ask before downloading.

## How work gets done

- Claude is the manager: plans, writes specs, reviews. Local coders write code
  (AGENTS.md rule 7). Claude edits project code only after an `ESCALATE`.
- One plan per milestone: `.claude/specs/plan-<milestone>.md`, run with
  `.claude/bin/run-plan.sh`. Each task goes through `autofix.sh`:
  - new files → aider (`run-coder.sh`); edits to existing files and all fix
    rounds → mini-swe-agent (`run-mini.sh`, throwaway worktree, merged only if
    `check.sh` passes and only task files changed);
  - 20-minute limit per coder run, up to 2 automatic fix rounds, then escalate.
- Test-writing tasks carry `gate: user`: confirm the implementation works, show
  the user the test cases, and resume only after approval.
- Coder model: `qwen2.5-coder:14b` (~10 GB, all GPU); `qwen2.5-coder:7b` for
  one-line fixes. Local models only; never a cloud model.
- MCP server `mini-swe-agent` (tools `run_mini`, `check`) is available in
  Claude Code via `.mcp.json`.
- Watch coders: `tmux attach -t jobops`. Logs: `.agent-logs/`.
- Token rules: `.claude/savingTokens.md`. Graph update once per milestone.

## Machine setup (outside the repo)

- Ollama settings at login: `~/Library/LaunchAgents/com.user.ollama-env.plist`
  (parallel 1, flash attention, q8_0 KV cache, max 3 models). It passes the
  settings with `open --env`, because Ollama ignored launchd's copy.
- aider and mini-swe-agent are `uv` tools; mini-swe-agent needs the `mcp`
  package (`uv tool install --with mcp mini-swe-agent`) and the text-based mode
  flags already in `run-mini.sh`.
- 16 GB RAM: run one 14B at a time; never alongside another model.

## Known issues and lessons

- Coder-written tests were wrong in both milestones (invented error formats,
  bad seed data, changed expected values) while the app was right. Review test
  failures against the approved test plan before "fixing" code.
- aider once wrote to a placeholder path (`path/to/...`); `run-coder.sh` now
  flags that and empty targets.
- A 14B fix round once hung for an hour with no output; the 20-minute timeout
  now stops that.
- Specs must not contain triple-backtick fences (breaks aider's edit parsing).
