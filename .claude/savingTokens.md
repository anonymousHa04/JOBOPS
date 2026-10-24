# Saving Claude tokens

Notes from the JobOps setup session (2026-10-24) on where Claude's tokens go and
how to spend fewer. The local coders, tests, Ollama, tmux, and graphify's code
extraction run on this machine and cost no Claude tokens.

## Where tokens go (largest first)

| # | Task | Why it costs tokens | How to cut it |
|---|---|---|---|
| 1 | Re-reading the conversation | Every reply re-reads the whole session. Caching makes it cheaper, but it is the biggest cost and grows with each message. | Start a fresh session for each milestone. AGENTS.md, memory, and the graph carry the context forward. |
| 2 | Graph updates | Each changed Markdown file is re-read in full by a subagent: 45–58k tokens per run, about 200k in the setup session. | Run `/graphify . --update` once per milestone, after the commit (AGENTS.md rule 4). |
| 3 | Writing specs | Planning each task and writing instructions for the local coder. | Short specs (what and why) once a coder has proven reliable. Line-level detail only for fixes. |
| 4 | Diagnosing failures | Reading failing code and logs to write a fix spec. | Only spent when something fails. A stronger local model means fewer failures. |
| 5 | Reviewing output | Type-check, tests, and a behaviour check. | Review test-first. Read code only on failure or for security-sensitive logic (AGENTS.md rule 7). |
| 6 | Answering questions | Explanations, comparisons, status updates. | The user decides. Often the most useful part. |
| 7 | Tool output | Logs and command results returned to Claude. | Use `tail` and `grep`, never full logs. |

## What changed in the setup session

- Graph updates: from after every edit to once per milestone.
- Review: from reading every file in full to typecheck + tests + behaviour check first.
- Coder model: `qwen2.5:14b` instead of `qwen2.5-coder:7b` for code tasks. The 7B
  needed 2–3 fix rounds per file; the 14B was right first time on 4 of 5 tasks,
  which saves the spec and review cost of every extra round.

## Automation (added 2026-10-25)

Scripts in `.claude/bin/` now do the routine work, so Claude no longer reads raw
output or writes a spec for every task:

| Script | Replaces | What it does |
|---|---|---|
| `check.sh <task>` | Point 7 (reading tool output) | Runs the type-check and tests; prints a compact PASS/FAIL report (edit flags, first type errors, failing tests and assertions). Full output goes to `.agent-logs/<task>.check.log`. |
| `autofix.sh <task> <spec> <files>` | Points 4–5 (review and fix rounds) | Coder → `check.sh` → on failure writes a fix spec from the report and re-runs the coder, up to `MAX_FIXES` (default 2). Claude is needed only on `ESCALATE`. |
| `run-plan.sh <plan>` | Point 3 (per-task specs) | One plan per milestone; runs every task through `autofix.sh` and prints one line per task. Stops at the first escalation and says how to resume. |

Planning still needs Claude once per milestone: the README says what to build,
and the plan adds the decisions a local model can't make (fields, status codes,
file boundaries, edge cases).

Limitation: an automatic fix round can't tell a wrong test from wrong code as
well as a reviewer can. Both Milestone 1 and 2 had wrong tests, not wrong code.
Fix specs tell the coder to treat the original task as the source of truth, and
escalation is the backstop.

## Still to try

- [ ] Fresh Claude session per milestone (biggest remaining saving).
- [ ] `qwen2.5-coder:14b`: coding-specific, smaller than `qwen2.5:14b`; may cut fix
      rounds further and use less memory.
- [ ] Shorter specs from Milestone 3 on; track how often the coder still gets it
      right first time.
- [ ] First full milestone run with `run-plan.sh` (Milestone 3); count escalations.
