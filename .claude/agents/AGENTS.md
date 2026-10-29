# JobOps agent rules

Every agent working in this repo (Claude Code, Codex, a local llama.cpp coder, or a
custom agent defined in this folder) reads this file first. Each custom agent's
role-specific instructions live in its own file in this folder, for example
`coder.md`. When an agent file and this file disagree, this file wins.

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

A local-model agent replaces `tools` with `model: openai/<model>` (a llama.cpp server role) and
`runner: aider` (see [coder.md](coder.md)). Add a row to the roster below when
you add an agent.

### 6. GitHub searches go through the GitHub MCP server

For any search for an open-source tool, library, or reference implementation,
quick or deep, use the `github` MCP server's read-only tools directly
(`search_repositories`, `search_code`, `get_file_contents`, `list_commits`,
`list_releases`, `get_latest_release`, `list_tags`). A quick search costs about
8–10k tokens. Judge fit, license, and activity yourself, and read only the
READMEs of the top candidates.

- Never clone or download a repo until the user has confirmed that specific
  repo. After confirmation, shallow-clone it read-only into `.scout/repos/`.
- Installing what you find still needs the user's approval (rule 2).
- MCP results: reply with just "passed", or the raw log the MCP server
  returned. Don't explain what went wrong or analyze unless the user
  explicitly asks.

### 7. Claude manages, local agents write code

Claude Code is the manager: it plans, writes task specs, reviews diffs, runs
tests, and finds flaws. It does not edit project code itself. Local-model agents
(llama.cpp on this machine, through aider or mini-swe-agent) make every code change, including fixes
for flaws the manager finds.

- Use local models only. Never use `kimi-k2.7-code:cloud` or any other cloud model.
- Default workflow: write one plan per milestone to
  `.claude/specs/plan-<milestone>.md` (format in `.claude/bin/run-plan.sh`), then
  run `.claude/bin/run-plan.sh .claude/specs/plan-<milestone>.md`. Each task goes
  through `autofix.sh`: coder → `check.sh` (typecheck + tests, compact report) →
  automatic fix rounds (up to `MAX_FIXES`, default 5 since 2026-10-29, the user's choice, so lessons and self-review get real use; a repeated failure signature still stops early). Each coder run is limited
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
- Run the heartbeat with every coder run (in the background, from the repo root):
  `go run -C .claude/bin/heartbeat .` (every 15 s; `-once` for one check). It
  reports each running task as WORKING, IDLE (2 min quiet), STUCK (aider waiting
  at its ">" prompt, or 5 min quiet) or DEAD, and sends a macOS notification on
  STUCK or DEAD. On STUCK or DEAD, stop the run and report; do not wait blind.
- Do not edit tracked files while a coder runs. `autofix.sh` snapshots the tree
  before each attempt and restores any tracked file changed outside the task's
  files, so the manager's own edits are silently undone.
- Every plan names the check that covers its files before it runs. `check.sh`
  only covers the TypeScript API and Go, so a task on other files passes no
  matter what it writes. For `extension/` tasks run `autofix.sh` per task with
  `TEST_CMD="sh extension/tools/check-ext.sh <file>"` and `FIRST_RUNNER=aider`
  (whole-file edits; mini-swe-agent's `sed` edits broke files on macOS). The
  grader checks that required code is present, not that it is right, so read
  the final extension files anyway; and write its checks to accept equivalent
  code, or a correct fix escalates.
- Lessons (`.claude/knowledge/fixes.jsonl`): after fixing an escalation, record it with
  `feedback.py resolve` (terms specific to the failure, file globs, and `not_when` for known
  look-alikes). A lesson reaches a coder only when its terms appear in the task text (context
  pack) or its error signature matches AND its files or terms fit the task (repair round). Each
  attempt records which lessons it got and why (`lessons`), and its timing. Two failed uses drop
  a lesson to `hypothesis`. `feedback.py stats` reports first-try pass rate, fix rounds and
  minutes per task, and fix-round results with versus without a lesson. Check retrieval changes
  with `retrieve.py eval` (recall and lesson precision; forbidden look-alikes fail it) and
  `python3 .claude/bin/test_lessons.py`.
- Before every repair round the coder gets `.claude/agents/self-review.md` and its previous
  diff; before escalation the local model writes a `self_review` into the escalation record.
- The Bash tool runs zsh: never rely on unquoted word splitting (`set -- $t`) in
  loops that start coders; it passed a wrong task name and left aider waiting.
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

All local models run on llama.cpp (`.claude/bin/llm.sh`, one `llama-server` per
role; Ollama was retired on 2026-10-26). Heavy roles (`coder`, `general7`,
`general14`) never run together on this 16 GB machine; `llm.sh` refuses it.

- Default coder: `qwen2.5-coder:14b` with a 16k window, flash attention, q8 KV
  cache, and speculative decoding (0.5B draft model: ~3.5x faster on edits),
  one task at a time (~10 GB). Two parallel slots swapped with Chrome and VS Code
  open, so `LLM_CODER_SLOTS` stays 1.
- The coder 7B (`qwen2.5-coder:7b`) was dropped on 2026-10-26 (user decision); the
  14B with speculative decoding is the only coder.
- Parallel coders: only two 7B models side by side, each in its own git
  worktree (`git worktree add ../jobops-<task> -b <task>`) with specs that touch
  different files. Never run a 14B alongside anything.

## Roster

| Agent | File | Runs on | Use it for |
|---|---|---|---|
| coder | [coder.md](coder.md) | `qwen2.5-coder:14b` via aider (new files) or mini-swe-agent (edits, fix rounds) | Write and fix code from a manager's spec |

## Always

- Follow the README's privacy rules: no resumes, contact exports, tokens, or
  `.env` files in commits or logs.
- Don't invent experience, metrics, or facts about the candidate.
- Never send outreach or post anything externally without the user's approval.
- Do only the step that was asked. Confirm before installs or scaffolding.
