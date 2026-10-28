# JobOps status

Handoff for the next session. Update this file at the end of every milestone
(and whenever a decision changes). Commit only when the user asks.

Last updated: 2026-10-28, after Milestone 3.

> Structured record of what is done and left: `.claude/knowledge/status.yaml`.
> Every Milestone 3 decision: the m3-notes skill, `references/decisions.md`.

## Where things are

- Branches: work happened on `m3-engine`; `dev` and `milestone-3` point at the same
  commit. `main` holds only the early commits: the user keeps it untouched (never
  commit or merge to it unless asked).
- Done:
  - **Milestone 1: working job API**; **Milestone 2: search and deduplication**.
  - **Milestone 3: profile, matching, resume selection** (README for the scope).
    Engine per the m3-notes skill: bank, scoring and judge, reuse/adapt/not_tailored,
    guarded rewording on the 14B, records, ATS-safe PDF with three-reader parse-back,
    lint. Plus: Workday/SmartRecruiters/careers-site search, `job add <url>`,
    career breaks, soft-skill and degree handling, hidden-text and AI-wording guards.
  - First real tailored resume: Okta Senior Software Engineer (Core Frontier),
    adapt, 77.5; its PDF passes all three readers.
- Tests: 75 TypeScript (`npm test`) plus Go (`cd jd-search && go test ./...`).
- Product models (llama.cpp, `.claude/bin/llm.sh`): general7 (JD parse, judge;
  3 slots), general14 (bank build, rewording). One heavy model at a time.

## Where to start next

- Milestone 4 (README). Before planning it, ask the user what they want first.
- Waiting on the user:
  - approve tests for skills trimming, the page fit, and sticky headings, and for
    the judge's skip and parallel calls;
  - lint items in their bank: profile links are labels not URLs, level digits
    in two titles ("II" parses better), a planned-work bullet, repeated opening verb.
- Deferred by the user: review-aware tailoring (`profile/reviews/`), score
  thresholds learned from outcomes (needs Milestone 7), a new rewording model.
- Workday upload checks are manual (`ats compare <report.json>` against the fake
  resume): Google and Workday block automated sign-in, and Cowork was too slow and
  costly. The automatic check is the three local readers on every render.

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
- MCP servers in `.mcp.json`: `mini-swe-agent` (`run_mini`, `check`) and `github`
  (official github-mcp-server, read-only, 7 search/read tools; token taken from
  `gh` at start-up by `.claude/mcp/github.sh`). github-scout was removed; all
  GitHub searches use the MCP server (AGENTS.md rule 6). After an MCP call,
  reply only "passed" or the raw log.
- Watch coders: `tmux attach -t jobops`. Logs: `.agent-logs/`.
- Token rules: `.claude/savingTokens.md`. Graph update once per milestone.

## Machine setup (outside the repo)

- Ollama is retired (2026-10-26): every model runs on llama.cpp from GGUF files
  in `~/models/jobops/`, started with `.claude/bin/llm.sh`.
- The careers crawler drives the installed Google Chrome (playwright-core); the
  OpenResume reader runs from `.scout/openresume-runner` (git-ignored, AGPL).
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
