# How a coding task goes from plan to code

This explains how one coding task moves through JobOps: from the manager's plan, to the local
coder model, through the checks, and to a senior developer when the coder fails. The examples
come from the batch company view (`plan-batch-companies`, November 2026).

Who does what (user's choice for this plan, 2026-11-12):

| Role | Who | Job |
|---|---|---|
| Manager | Claude Code (this chat) | Plans, writes task specs, reviews every diff, records lessons. Writes no project code. |
| New employee | Local coder: `qwen2.5-coder:14b` on llama.cpp | Gets every task first. |
| Senior developer | Claude subagent | Gets a task when the local coder fails (it escalates). Fixes that one file. |
| You | The user | Approve plans, test plans, installs and commits. |

The rules every agent follows are in `.claude/agents/AGENTS.md`.

## The flow at a glance

    1. Plan             manager writes plan + task file            .claude/specs/plan-*.md
    2. Split            run-plan.sh -> one spec per task           .claude/specs/<task>.md
    3. Ready check      ready.sh: servers, Docker, tools           .agent-logs/ready.txt
    4. Context          pipeline.py prepare -> context bundle      .agent-logs/<task>.bundle.md
    5. Model call       patch runner or aider -> llama-server      127.0.0.1:8081
    6. Edit gate        pipeline.py verify                         .agent-logs/<task>.gate.json
    7. Checks           check.sh: tsc, npm test, go vet/test       .agent-logs/<task>.check.json
    8. Outcome          pass -> next task | fail -> fix round or escalate
    9. Escalation       manager -> Claude subagent (senior dev)    .agent-logs/<task>.escalation.json
    10. Review + lesson manager reads the diff, feedback.py resolve  .claude/knowledge/fixes.jsonl

Running alongside: the heartbeat and `watch-coders.sh` (they flag stuck or dead coder windows),
and the `jobops` tmux session (one window per task, which you can watch with
`tmux attach -t jobops`).

## 1. Plan (manager)

The manager writes two files:

- **The plan**, `.claude/specs/plan-batch-companies.md`. This is the design you approve: what
  changes and why, by phase (C1 jd-search, C2 queue, C3 api, C4 UI, C5 tests).
- **The task file**, `.claude/specs/plan-batch-companies-tasks.md`. It holds small tasks the
  coder can do, in build order. Each one changes one file.

Task file format: shared rules at the top, then one `## task:` section per task.

    Feature: the Batches tab shows every preferred company of a batch ... Change only the file
    named in the task. Keep existing comments.

    ## task: bc-08-status
    files: queue/internal/store/status.go
    In queue/internal/store/status.go add to BatchStatus the fields Companies []Company (json
    companies, omitempty) and Unskip []string (json unskip, omitempty). In func Batch, after the
    failed tasks, set bs.Companies from s.companiesOf(id) and bs.Unskip from s.unskipOf(id) (return
    their errors). Do not call the exported locking methods there.
    expect: s.companiesOf(id)

Spec rules (learned the hard way):

- **One file per task.** An edit task changes one function and names it.
- **`expect:` lines** give text the change must add. The edit gate checks them.
- **`gate: user`** goes on every test-writing task. The plan stops there until you approve the
  test cases.
- **No triple-backtick code fences.** aider then expects a different fence style and silently
  drops the edit.
- **No full `http://` links.** aider fetches any link it sees. Write host, port and path instead.

## 2. Split: `.claude/bin/run-plan.sh`

    COMMIT=0 TSC_CMD="npx tsc -p . && npx tsc -p ui" \
      .claude/bin/run-plan.sh .claude/specs/plan-batch-companies-tasks.md [first-task-id]

- It writes one spec per task to `.claude/specs/<task>.md`, with the shared rules copied to the
  top.
- It runs each task in order through `.claude/bin/autofix.sh`, the single entry point for a
  task.
- It stops at the first task that escalates and prints the command to resume there.
- It stops before any `gate: user` task. Resuming at that task counts as your approval.
- `COMMIT=0` turns off its commit after each passing task, because commits wait for you.
- `TSC_CMD` and `TEST_CMD` override the checks. Here the type check also covers `ui/`.

## 3. Ready check: `.claude/bin/ready.sh`

It checks:
- Docker and Qdrant (the lesson search store);
- the coder server (:8081) and the embed server (:8082);
- the `jobops` tmux session;
- `node_modules`, Go, aider, and leftover temp files.

If anything is missing, nothing is sent to a coder: that's an INFRA_FAILURE. `ready.sh --fix`
starts what it safely can.

The model servers are started with `.claude/bin/llm.sh start <role>`. Roles: `coder` (14B,
:8081), `embed` (:8082), `general7` (:8084), `general14` (:8085).

Shortcut: `llm` does the same from any folder (`llm start coder`, `llm stop general14`,
`llm status`, `llm models`), and `llm help` lists the commands, the roles and the swap steps. It
is a small wrapper at `~/.local/bin/llm` (on the PATH), outside the repo, so it isn't in git. Its
help text is inside the wrapper; every other command goes straight to `.claude/bin/llm.sh`. To
recreate it on a new machine, write `~/.local/bin/llm` with these lines and run
`chmod +x ~/.local/bin/llm`:

    #!/bin/sh
    exec /Users/anonymous/Documents/projects/JOBOPS/.claude/bin/llm.sh "$@"

(A plain symlink doesn't work: `llm.sh` finds the repo from its own folder.) The 14B coder and
`general14` (tailoring) never run together on this 16 GB Mac, so during a coder run
`general14` is stopped and the `worker-mac` pod is scaled to 0. Tailor tasks then wait in
the queue instead of failing.

## 4. Context: `.claude/bin/pipeline.py prepare`

- **Routes the task by complexity.** It refuses work that's too big: a new subsystem, one edit
  spread over several existing files, or a `new-dependency:` line.
- **Builds the context bundle** with `.claude/bin/context_bundle.py` and writes it to
  `.agent-logs/<task>.bundle.md`. This tells the model what really exists, so it doesn't guess.
  Real excerpt from bc-08:

        # Context bundle (read only): use these names exactly; do not guess others

        ## 1. Allowed dependencies (anything else does not exist here)
        - Go module queue/ is jobops/queue ... go.mod requires: ... modernc.org/sqlite.
          Otherwise only the Go standard library (no testify, no new modules).

        ## 2. Names that already exist in each target's package (never declare them again)
        - queue/internal/store/ (package store):
          batches.go:
            func (s *Store) StartBatchWith(limit int, parseVersion string, unskip []string) (int64, error)
          companies.go:
            func (s *Store) SaveCompanies(batchID int64, rows []Company) error

- **Adds lessons.** Earlier fixes are stored in `.claude/knowledge/fixes.jsonl` and searched by
  `.claude/knowledge/retrieve.py` (embed server and Qdrant). A lesson reaches the coder only
  when its terms appear in the task.

## 5. Model call: the runners

Each runner opens its own window in the `jobops` tmux session and logs to
`.agent-logs/<task>.log`.

### Edits to an existing file: the patch runner

`.claude/bin/run-patch.sh` → `.claude/bin/patch_coder.py`

- It sends one chat request to llama.cpp at host 127.0.0.1 port 8081 path
  `/v1/chat/completions`. That's the same API OpenAI uses, served by `llama-server`.
- **The system message** is the fixed `RULES` text in `patch_coder.py`:

        You edit existing files by writing search/replace blocks. Answer with blocks only ...
        FILE: <path of a file listed below>
        <<<<<<< SEARCH
        <lines copied exactly from the file, enough to be unique: usually 2 to 6 lines>
        =======
        <the new lines that replace them>
        >>>>>>> REPLACE
        Rules:
        - SEARCH must be copied character for character from the current file and occur in it exactly once.
        - Change only what the task asks. Never rewrite a whole file. ...
        - Use only the names and imports listed in the context bundle; do not invent packages or functions.

- **The user message** joins the spec, the bundle and the files:

        TASK
        <the task spec from .claude/specs/<task>.md>

        <the context bundle>

        CURRENT FILES (edit these with search/replace blocks)
        <the full text of each file to edit>

- **The model's answer** is saved to `.agent-logs/<task>.patch.txt`. Real start from bc-08:

        FILE: queue/internal/store/status.go
        <<<<<<< SEARCH
        type BatchStatus struct {
        	ID        int64                 `json:"id"`
        ...
        =======
        type BatchStatus struct {
        ...
        	Companies []Company             `json:"companies,omitempty"`

- `patch_coder.py` applies the blocks all or nothing. Each SEARCH must match the file exactly
  once, and large deletions are refused. "PATCH REJECTED: SEARCH not found" in the log means
  the model didn't copy the file's lines exactly (bc-09, bc-10).

### New files: aider

`.claude/bin/run-coder.sh` → aider with `--model openai/qwen2.5-coder-14b`, pointed at the
same server.

- aider gets the spec as its message.
- It gets the context file `.agent-logs/<task>.context.md` as a read-only file (`--read`).
- It writes whole new files.
- Its settings are in `.claude/agents/aider.model.settings.yml` and
  `aider.model.metadata.json`.
- `--no-detect-urls` stops it from fetching links.

### The model server

`.claude/bin/llm.sh start coder` runs `llama-server` with:
- `qwen2.5-coder:14b`, with a 16k window and flash attention;
- a q8 KV cache;
- one slot;
- speculative decoding: the 0.5B draft model proposes tokens and the 14B checks them. The
  output is the same and edits are about 3.5x faster.

`CODER_TIMEOUT` (1200 s) stops a coder that hangs.

## 6. Edit gate: `pipeline.py verify`

The gate checks the change before running any tests. Real failures from this plan:

    GATE FAILED  1 expected files changed: unchanged: queue/internal/api/api.go
    GATE FAILED  3 diff addresses the request: expected text not in the added lines: ADD COLUMN unskip
    GATE FAILED  6 syntax: queue/internal/fetch/fetch.go:66:6: expected '(', found RecheckBatch
    GATE FAILED  7 dependencies exist: companies.go: github.com/mattn/go-sqlite3 (not ... a go.mod require)

What it checks:
1. the task's file changed;
2. the diff isn't empty;
3. every `expect:` text is in the added lines;
4. nothing outside the task changed;
5. no large deletion (allowed only with an `allow-delete: N` line);
6. the syntax parses;
7. every import exists.

## 7. Checks: `.claude/bin/check.sh <task>`

It runs:
- the type check (`npx tsc -p .`, or `TSC_CMD`);
- the tests (`npm test`, or `TEST_CMD`);
- `go vet` and `go test` for every Go module;
- the extension grader when files in `extension/` changed.

The report goes to `.agent-logs/<task>.check.json` (pass/fail per step) and
`.agent-logs/<task>.check.log` (full output).

These checks only prove the code builds, the old tests pass and the required words are
present. They don't prove the new code does what the spec says. bc-01 and bc-07 passed with
real bugs, so the manager reads every diff anyway.

## 8. Outcome: `autofix.sh`

Every attempt gets a failure class: CODE, EDIT, CONTEXT, DEPENDENCY, INFRA, TEST or SPEC.

- **Pass:** the plan moves on to the next task.
- **EDIT failure:** one fix round. The coder gets `.claude/agents/self-review.md` and its
  previous diff, then tries again (`MAX_FIXES=1`).
- **Any other failure, or a failed fix round:** ESCALATE. The plan stops.

The per-attempt record goes to `.agent-logs/<task>.attempts.jsonl` and the escalation record
to `.agent-logs/<task>.escalation.json`.

Snapshot guard: during a run, `autofix.sh` undoes any change to a file outside the task,
including new files. So the manager edits nothing in the repo while a coder runs (this file
was drafted outside the repo and moved in afterwards).

## 9. Escalation: the senior developer

The manager reads the escalation record and the coder's diff, then starts a Claude subagent
with a short brief:

    You are a senior developer finishing a task a local coder escalated ... Do NOT commit.
    Change ONLY queue/internal/store/db.go. Do not add or change tests.
    Spec: .claude/specs/bc-04-schema.md. Problems found by the manager:
    1. It added `unskip` inside CREATE TABLE IF NOT EXISTS ... never reaches existing databases.
    2. Missing: ALTER TABLE queue_batches ADD COLUMN unskip ... ignore "duplicate column".
    Checks: cd queue && gofmt -l . && go vet ./... && go test -race ./...,
    then .claude/bin/check.sh bc-04-schema.
    Report: final diff, check results, 1-2 lines on what the coder got wrong.

The subagent fixes the one file, runs the same checks and reports back. Its report is model
output, not your approval of anything.

## 10. Review and lesson (manager)

The manager:
1. reads the final diff, also for tasks that passed;
2. records what the coder got wrong as a lesson:

        python3 .claude/bin/feedback.py resolve .agent-logs/bc-04-schema.escalation.json \
          --id sqlite-add-column-needs-alter \
          --title "SQLite: a new column on an existing table needs ALTER TABLE ..." \
          --resolution "Leave the CREATE TABLE as it was. After the CREATE Exec run ALTER TABLE ..." \
          --terms "ADD COLUMN,ALTER TABLE,CREATE TABLE IF NOT EXISTS,duplicate column" \
          --files "queue/**/*.go"

3. resumes the plan at the next task: `run-plan.sh <plan> <next-task-id>`.

A lesson goes into the context of later tasks whose text matches its terms (step 4). It
starts as an observation and becomes "verified" once a coder run that was given it passes.
`python3 .claude/bin/feedback.py stats` reports the first-try pass rate and how often fix
rounds work.

## Tools

### What JobOps itself runs on

| Area | Tool | Used for |
|---|---|---|
| API | Node.js 24, TypeScript, Fastify, zod | The JobOps API (`api/`): jobs, scoring, tailoring, Gaps, routes |
| Database | SQLite (better-sqlite3 in the API, modernc.org/sqlite in Go) | Jobs, resumes and the queue's tasks |
| Queue and search | Go | Queue server (`queue/`), job board search (`jd-search/`), the `bin/jobops` CLI (`ctl/`), the gateway (`gateway/`) |
| UI | React 19, Vite 8, own CSS | The web app (`ui/`): Pipeline, Batches, Applications, Gaps |
| Browser extension | Chrome extension (`extension/`) | Carries a job's tailored prompt to Claude or ChatGPT |
| Local AI models | llama.cpp (`llama-server`) | One server per role, all on 127.0.0.1 |
| | qwen2.5:7b (`general7`, normally on the laptop) | Parsing job posts, requirement judge |
| | qwen2.5:14b (`general14`) | Rewording bullets, tailoring, gap help |
| | mxbai-embed-large (`embed`) | Embeddings: Gaps search by meaning, coder lesson search |
| Vector search | Qdrant (Docker Compose) | Stores the embeddings |
| Job post reading | playwright-core + Google Chrome, Mozilla Readability, linkedom | Careers-page crawler and reading a job from its link |
| PDF and ATS checks | pdftotext, pdf.js, OpenResume parser (`.scout/openresume-runner`, AGPL, not in git) | Checking a rendered resume reads back correctly |
| Running it | Docker Desktop with Kubernetes (kubeadm) | Pods: api, gateway, queue, worker-laptop, worker-mac; UI at localhost:8080 |
| MCP servers | `jobops-tools`, `jd-search` | Let Claude call JobOps actions (score, tailor, search jobs) |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Type check and tests on push |

### What we use while developing

| Tool | Used for |
|---|---|
| Claude Code (manager) | Plans, specs, reviews every diff, records lessons |
| Claude subagents (senior devs) | Fix escalated tasks, write tests when asked |
| qwen2.5-coder:14b on llama.cpp (`coder`, :8081), with qwen2.5-coder:0.5b as the draft model | The local coder ("new employee") |
| aider | Local coder runner for new files |
| Patch runner (`run-patch.sh`, `patch_coder.py`) | Local coder runner for edits to existing files |
| mini-swe-agent | Optional coder runner, only when asked, in a throwaway worktree |
| `.claude/bin/` scripts | `run-plan.sh`, `autofix.sh`, `ready.sh`, `pipeline.py`, `check.sh`, `feedback.py`, `llm.sh` (steps 2 to 10 above) |
| `llm` shortcut (`~/.local/bin/llm`) | Start and stop the model servers from any folder; `llm help` |
| Heartbeat (Go) and `watch-coders.sh` | Flag stuck or dead coder windows |
| tmux (`jobops` session) | One window per coder task, to watch live |
| Docker + Qdrant | Lesson search for the coders |
| `tsc`, `node --test`, `go vet`, `go test -race`, gofmt | The checks |
| Playwright | Checking UI changes in a real browser |
| graphify (`graphify-out/`) | Knowledge graph of the codebase, updated once per milestone |
| GitHub MCP server | Read-only GitHub searches (scouting tools) |
| `uv` | Installs aider and mini-swe-agent as tools |
| git, `gh` | Branches (`dev`, milestone and fix branches; never `main`), commits only when asked |

## Files and folders

| Path | What it is |
|---|---|
| `.claude/agents/AGENTS.md` | Rules for every agent (wins over the role files) |
| `.claude/agents/coder.md` | The local coder's role |
| `.claude/agents/self-review.md` | What the coder reads before a fix round |
| `.claude/agents/coder-patterns.md`, `fix-hints.yaml` | Patterns and hints handed to coders |
| `.claude/agents/aider.model.*` | aider's model settings for the local server |
| `.claude/specs/plan-*.md` | Plans and task files (the manager writes them) |
| `.claude/specs/<task>.md` | One task's spec (run-plan.sh writes it) |
| `.claude/bin/run-plan.sh` | Runs a task file, task by task |
| `.claude/bin/autofix.sh` | One task: prepare, run, gate, check, fix round or escalate |
| `.claude/bin/ready.sh` | Checks the setup before a run |
| `.claude/bin/pipeline.py` | `prepare` (route + context) and `verify` (edit gate) |
| `.claude/bin/context_bundle.py` | Builds the context bundle |
| `.claude/bin/run-patch.sh`, `patch_coder.py` | Patch runner (edits to existing files) |
| `.claude/bin/run-coder.sh` | aider runner (new files) |
| `.claude/bin/run-mini.sh` | mini-swe-agent runner (only when asked, in a throwaway worktree) |
| `.claude/bin/check.sh` | Type check, tests, Go checks |
| `.claude/bin/llm.sh` | Starts and stops the llama.cpp servers |
| `.claude/bin/heartbeat/`, `watch-coders.sh` | Detect stuck or dead coder windows |
| `.claude/bin/feedback.py` | Records lessons (`resolve`) and stats (`stats`) |
| `.claude/knowledge/fixes.jsonl` | The lessons |
| `.claude/knowledge/retrieve.py` | Finds lessons for a task (embed server + Qdrant) |
| `.agent-logs/` | Everything one run produces (git-ignored) |

### What `.agent-logs/` holds for one task (bc-08)

| File | Contents |
|---|---|
| `bc-08-status.prep.json` | Route and complexity decision |
| `bc-08-status.bundle.md` / `.bundle.json` | The context bundle |
| `bc-08-status.embed.json` | Lessons found for the task |
| `bc-08-status.before.json`, `.after.json`, `.orig` | Snapshot before and after (the guard) |
| `bc-08-status.log` | The runner's log (what the tmux window showed) |
| `bc-08-status.patch.txt` | The model's raw answer |
| `bc-08-status.gate.json` | Edit gate result |
| `bc-08-status.check.json` / `.check.log` | check.sh result and full output |
| `bc-08-status.attempts.jsonl` | One line per attempt: class, timing, lessons given |
| `bc-08-status.result.json` | Final outcome |
| `<task>.escalation.json` | Only when it escalated: why, plus the coder's self-review |

## How it went on this plan

At bc-11, 11 of 16 tasks were done:
- **Passed on the local coder:** bc-07 and bc-08. bc-07 still had a bug the checks missed.
- **Escalated:** the other nine.

Common misses:
- SEARCH text not copied exactly from the file;
- a new import that doesn't exist (`mattn/go-sqlite3`);
- adding a second copy of a function instead of changing it;
- leaving out the main logic while the code still compiled.

Each one has a lesson in `fixes.jsonl`.
