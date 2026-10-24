# JobOps agent rules

Every agent working in this repo (Claude Code, Codex, a local Ollama coder, or a
custom agent defined in this folder) reads this file first. Each custom agent's
role-specific instructions live in its own file in this folder, for example
`github-scout.md`. When an agent file and this file disagree, this file wins.

## Source of truth

`README.md` at the repo root is the source of truth for product scope,
architecture, data domains, AI principles, privacy rules, and the milestone
roadmap. Read the relevant section before planning or changing anything. If
the code and the README disagree, report it; don't silently pick one.

## Rules

### 1. Read through graphify first

Before opening files to answer a question about the codebase, check for
`graphify-out/graph.json` in the repo root.

- If it exists, run `graphify query "<question>"` (add `--dfs` to trace one
  path, `--budget <n>` to cap the answer) and read only the files it points to.
- If it doesn't exist, ask the user whether to build it with `/graphify .`
  before doing broad reads.

### 2. Missing modules: ask for an alternative

If a tool, CLI, package, service, or model the task needs is not installed or
available (and isn't part of this codebase), stop and ask the user which
alternative to use. Don't install it, substitute something else, or build a
workaround without approval.

### 3. Check with peers before calling something a bug

When a change looks wrong or a test fails unexpectedly, ask the other agents
working on the repo, and the user, whether that change was intentional before
you treat it as a bug. Keep asking until someone confirms either "intended" or
"bug". Only then fix it or write it up.

### 4. Keep the graph current

Run `/graphify . --update` (incremental: re-extracts only changed files) once at
the end of each milestone, once its tests pass, so the next agent reads an accurate
graph. Don't run it after every small edit: code files are graphed for free, but
each changed Markdown file costs tens of thousands of tokens to re-read.

### 5. One file per custom agent

Each custom agent gets its own Markdown file in `.claude/agents/` with frontmatter:

```markdown
---
name: <kebab-case-name>
description: <when to use this agent>
tools: <comma-separated tool list, as narrow as the job allows>
---
<role instructions>
```

A local-model agent replaces `tools` with `model: ollama_chat/<model>` and
`runner: aider` (see [coder.md](coder.md)). Add a row to the roster below when
you add an agent.

### 6. GitHub searches go through github-scout

When you need an open-source tool, library, or reference implementation for
development, or want to learn a new technique, hand the request to the local
`github-scout` agent instead of searching GitHub yourself. It clones the best
match into `.scout/repos/`, points you to the files to read, and saves a report
in `.scout/reports/`. You can keep working while it searches. Installing what it
finds still needs the user's approval (rule 2).

### 7. Claude manages, local agents write code

Claude Code is the manager: it plans, writes task specs, reviews diffs, runs
tests, and finds flaws. It does not edit project code itself. Local-model agents
(Ollama on this machine, through aider) make every code change, including fixes
for flaws the manager finds.

- Use local models only. Never use `kimi-k2.7-code:cloud` or any other cloud model.
- Default workflow: write one plan per milestone to
  `.claude/specs/plan-<milestone>.md` (format in `.claude/bin/run-plan.sh`), then
  run `.claude/bin/run-plan.sh .claude/specs/plan-<milestone>.md`. Each task goes
  through `autofix.sh`: coder → `check.sh` (typecheck + tests, compact report) →
  automatic fix rounds (up to `MAX_FIXES`, default 2). Each coder run is limited
  to `CODER_TIMEOUT` seconds (default 1200, i.e. 20 minutes); a timeout stops
  the coder at once.
- Runner split by task: if any target file is new or empty, aider writes it
  (`run-coder.sh`); if all targets exist, mini-swe-agent edits them
  (`run-mini.sh`). Fix rounds always use mini-swe-agent. mini-swe-agent runs
  model-chosen shell commands, so it only ever works in a throwaway worktree
  (`../jobops-mini-<task>`); its diff is applied back only if `check.sh` passes
  there and it changed only the task's files. Override with `FIRST_RUNNER` /
  `FIX_RUNNER` (`aider` or `mini`).
- Claude Code can also call mini-swe-agent directly through the
  `mini-swe-agent` MCP server (`.mcp.json` → `.claude/mcp/mini_server.py`),
  tools `run_mini` and `check`.
- On `ESCALATE` (timeout, or still failing after the fix rounds) the manager
  takes over: read the last log lines and the check report, then edit the file
  directly and re-run `check.sh`. This is the one case where the manager writes
  project code.
- Tests need the user's approval. Every test-writing task in a plan has
  `gate: user`, and `run-plan.sh` stops before it. The manager first confirms
  the implementation tasks passed and work, then shows the user the test cases.
  Only after the user approves does the manager resume the plan at that task.
- For a single task: write the task spec to `.claude/specs/<task>.md`, then run the coder in its
  own window of the `jobops` tmux session:
  `.claude/bin/run-coder.sh <task> .claude/specs/<task>.md <files to edit>`.
  Wait with `tmux wait-for <task>`. Output goes to `.agent-logs/<task>.log`; the
  user watches live with `tmux attach -t jobops`.
- Specs must not contain triple-backtick code fences (use indented blocks). A
  fence makes aider expect four-backtick fences, the 7B model answers with three,
  and the edit is silently dropped. The runner appends `RUN-CODER: NO EDIT
  APPLIED` to the log when that happens.
- Review loop: spec → coder → `npm run typecheck`, `npm test`, and a quick
  behaviour check → if anything fails, read only the failing code, then send a
  follow-up spec to the coder → repeat until it passes → report to the user
  that it is ready → graph update at the end of the milestone (rule 4).
- Never `git commit` (or amend) unless the user explicitly asks. Leave work
  uncommitted and tell the user what is ready.
- Review test-first: don't read a coder's whole file when the type-check, tests,
  and behaviour check pass. Read code only to diagnose a failure, or for
  security-sensitive logic (input validation, SQL, auth).
- Keep specs to what and why once a coder has proven reliable; give line-level
  instructions only for fixes.

### 8. Parallel work

Ollama runs with `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=3` on a
16 GB machine (set at login by `~/Library/LaunchAgents/com.user.ollama-env.plist`).

- Default coder: `qwen2.5-coder:14b`, one task at a time. With
  `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, parallel 1, and an 8k
  context cap (`.aider.model.settings.yml`), it uses ~10 GB, 100% on the GPU, at
  ~11 tok/s. The general `qwen2.5:14b` with parallel 2 grew to 15 GB and swapped.
- For one-line fixes, `qwen2.5-coder:7b` is much faster (minutes, not tens of
  minutes) and `check.sh` catches its mistakes.
- Parallel coders: only two 7B models side by side, each in its own git
  worktree (`git worktree add ../jobops-<task> -b <task>`) with specs that touch
  different files. Never run a 14B alongside anything.

## Roster

| Agent | File | Runs on | Use it for |
|---|---|---|---|
| github-scout | [github-scout.md](github-scout.md) | Claude subagent | Find and fetch open-source tools, libraries, and examples for development |
| coder | [coder.md](coder.md) | `qwen2.5-coder:14b` via aider (new files) or mini-swe-agent (edits, fix rounds) | Write and fix code from a manager's spec |

## Always

- Follow the README's privacy rules: no resumes, contact exports, tokens, or
  `.env` files in commits or logs.
- Don't invent experience, metrics, or facts about the candidate.
- Never send outreach or post anything externally without the user's approval.
- Do only the step that was asked. Confirm before installs or scaffolding.
