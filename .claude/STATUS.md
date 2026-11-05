# JobOps status

Handoff for the next session. Update this file at the end of every milestone
(and whenever a decision changes). Commit only when the user asks.

Last updated: 2026-11-04, Milestone 8 (containers, local Kubernetes, gateway, CI) built on
branch `milestone-8`, uncommitted. JobOps now runs in Docker Desktop's Kubernetes: `bin/jobops
status`, UI at localhost:8080 (`RUNBOOK-M8.md`); `bin/jobops start` brings everything up in one
command (checked from cold, 2026-11-05: 78 s). `bin/jobops` is now a Go program (`ctl/`, 2026-11-05;
shell version kept at `.agent-logs/jobops.shell-version.sh`): a real supervisor keeps the
port-forwards alive; `ctl` has no tests yet (test plan waits for the user). The local tmux stack is stopped: run one or the
other, never both. Next: commit and merge M8 when the user says, first CI run, then Milestone 6.

> Structured record of what is done and left: `.claude/knowledge/status.yaml`.
> Every Milestone 3 decision: the m3-notes skill, `references/decisions.md`.

## Where things are

- Branches: `dev` is the development branch; each milestone is a sub-branch merged into
  it (`milestone-3` with `m3-engine`, `milestone-4`). `main` holds only the early commits: the user keeps it untouched (never
  commit or merge to it unless asked).
- Done:
  - **Milestone 1: working job API**; **Milestone 2: search and deduplication**.
  - **Milestone 3: profile, matching, resume selection** (README for the scope).
    Engine per the m3-notes skill: bank, scoring and judge, reuse/adapt/not_tailored,
    guarded rewording on the 14B, records, ATS-safe PDF with three-reader parse-back,
    lint. Plus: Workday/SmartRecruiters/careers-site search, `job add <url>`,
    career breaks, soft-skill and degree handling, hidden-text and AI-wording guards.
  - **Milestone 4: local LLM integration**. One model registry
    (`api/config/models.yaml`, override in `profile/models.yaml`, env vars win); every
    model command checks its server first and stops with the llm.sh commands to switch;
    call log `data/model-calls.jsonl` (codes and numbers only) with `models stats`;
    the retry names the failing schema fields.
  - **Chrome extension** (`extension/`): asks Claude or ChatGPT for a report on the tailored
    resume (never contact details), one chat per job and site.
  - **Report loop**: the chat's report is reviewed locally, fix rounds re-select or reword
    bullets through the guard, up to 5 rounds in the same chat (POST /x/fix; round 5 stops).
  - First real tailored resume: Okta Senior Software Engineer (Core Frontier),
    adapt, 77.5; its PDF passes all three readers.
  - **Milestone 5: background agent workflow** (plan `.claude/specs/plan-milestone-5.md`, order
    0, A, H, I, B, C, D, E, F, G):
    - general7 runs on the Lenovo laptop (RTX 3050, http://10.10.10.1:8084/v1, API key); the Mac
      keeps general14. `LLM_GENERAL7_URL` and `LLM_GENERAL7_KEY` in `.env`; a remote model's
      preflight says to start `C:\llama\start-server.cmd`; a refused key names the setting.
    - JD prompt v2 (laptop keyword overlap with Claude 0.37 -> 0.46 on 6 JDs).
    - Qdrant before parsing (optional, QDRANT_URL): reposts reuse the earlier parse (candidates
      from chunk vectors, confirmed by full-text overlap >= 0.9); keywords get canonical names
      only when the name is in the JD and similar-and-contained.
    - Go queue `queue/` (SQLite, one queue per stage, leases, retries, group limits), Node
      workers (`worker laptop|mac`), `batch start|status|retry`, `/batches` routes.
    - Report loop raises the score: engine re-score per round, stop on no gain, best kept,
      chat `fit_score` recorded (`profile/reports/<job>.<source>.loop.json`).
    - Live-checked on DB copies: repost reuse (no model call); a 3-job batch through the queue
      and the laptop worker (fetch 47 matched, 3 parsed and scored).
    - First real batches (user, 2026-11-03): 2 x 3 jobs fetched, parsed, scored, no failures; all
      not_tailored (16-57). Showed loose title matching, so:
    - Search filters (`search-filters`): seniority.include required (level III/3 counts; roles
      with `any_level` exempt), `title_filter` languages (my_languages / other_languages), INR pay
      below compensation.min skipped (keep_if_unlisted keeps posts without a salary). Stored jobs
      are re-checked before every batch (`jd-search check` -> table `job_filter`, `batch status`
      shows `skipped`): on the real data 44 of 121 candidates pass. preferences.yaml: Staff and
      Solutions roles dropped (user). LeetCode Discuss left out (its terms forbid scraping).
  - **Milestone 7: UI and application tracking** (branch `milestone-7`, c4ab48b; written by the
    manager on the user's request, no local coders). `ui/` (React 19, Vite 8, own dark CSS;
    `npm run ui`, 127.0.0.1:5173, no login): Pipeline board, job drawer (why, queue history,
    score arithmetic with per-requirement evidence), Applications board (drag, notes, prep tasks;
    tables `applications`, `application_tasks`), Batches tab, health bar. API `/ui/*` routes in
    `api/src/ui/`. Queue sweep: parsed jobs no batch scored are scored every 2 minutes
    (`JOBOPS_SWEEP_EVERY`, 0 = off; `POST /batches/sweep`). First sweep (2026-11-04): 41 jobs
    scored, all not_tailored (best Okta Core Frontier 77.3 moderate, blocked by another check).
  - **Milestone 8: containers and local Kubernetes** (branch `milestone-8`, uncommitted; written
    by the manager on the user's request, no local coders). One image `jobops:dev` (`Dockerfile`,
    allow-list `.dockerignore`; Chromium, typst, poppler). `infra/k8s/` (kustomize): Deployments
    api, queue, worker-laptop, worker-mac, gateway; ClusterIP Services; PVC `jobops-data` (the
    database); `profile/` as hostPath; Secret from `.env`; ConfigMap `jobops-cluster`
    (host.docker.internal for the Mac's models and Qdrant). `gateway/` (Go, stdlib): ui/dist and
    `/api` proxy. `bin/jobops` up/down/status/logs/cli/ui/db-import/db-backup; ports 8080 (UI)
    and 3000 (extension) are port-forwards on 127.0.0.1 only. Queue worker heartbeat
    (`/workers`, `/workers/ping`) for the health bar; workers stop cleanly on SIGTERM. CI
    `.github/workflows/ci.yml` (not yet run: needs a push). Checked: all pods Running, deleted
    pods replaced in seconds, UI/board/health through the gateway, `bin/jobops cli batch status`,
    pods write `profile/` and reach general14, Qdrant and the laptop; the 130-job database was
    imported (2026-11-04, after stopping the local stack).
- Tests: 126 TypeScript (`npm test`) plus Go (jd-search filter cases; `queue/` store,
  preference-check and an end-to-end `jd-search check` test); `check.sh` runs both Go modules.
- Product models (llama.cpp): general7 (JD parse, judge; 3 slots) on the laptop, started by
  hand with `C:\llama\start-server.cmd` (never an auto-start task); general14 (bank build,
  rewording; 3 slots, -kvu) on the Mac via `.claude/bin/llm.sh`. Never load general7 on the
  Mac next to general14.

## Where to start next

- Next: commit Milestone 8 when the user asks, push, and check the first CI run (it has never
  run). Then merge into `dev` and the graph update. Then Milestone 6.
- Milestone 8 open items: the gateway unit test (`gateway/main_test.go`, written without an
  approved test plan: ask the user to keep it); opening the port-forwards at login (launchd
  agent, only if the user wants it; until then `bin/jobops ui` after a reboot); PostgreSQL in
  place of SQLite later (user choice).
- The database that counts is the cluster's (`bin/jobops db-backup` copies it out);
  `data/jobops.db` on the Mac is the 2026-11-04 copy.
- Milestone 6 (contacts and outreach): plan `.claude/specs/plan-milestone-6.md` and phase A
  specs `.claude/specs/plan-m6-a.md` (git-ignored, approved, not run) on branch `milestone-6`.
- Milestone 7 open item: tests for the `/ui` routes and the sweep (test plan shown to the user,
  not yet approved, so not written).
- Searching for new jobs starts only by hand (`batch start` or the Batches tab); scoring of
  parsed jobs is automatic once the queue server and workers run.
- Leftover branches `mini/m5-h1-key-message`, `mini/m5-i4-parse-wiring`: old mini-runner
  attempts, pushed but never merged (never delete branches).
- Coder tooling (2026-11-03, `tooling/coder-gates`, AGENTS.md rule 7): ready.sh before dispatch,
  complexity route (patch runner for edits, aider for new files, refuses subsystems/multi-file),
  context bundle, 7-check edit gate, failure classes, one fix round for EDIT_FAILURE only, lessons
  observation -> hypothesis -> verified. Measured: TS edits 0/2 -> 1/2 passed, 15.4 -> ~3 min;
  Go new files still fail (unused imports, NULL columns); the user chose to keep the design as is,
  so keep Go tasks small or write them as manager.
- Waiting on the user:
  - lint items in their bank: profile links are labels not URLs, level digits
    in two titles ("II" parses better), a planned-work bullet, repeated opening verb.
- Deferred by the user: review-aware tailoring (`profile/reviews/`), score
  thresholds learned from outcomes (needs Milestone 7).
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
- Watch coders: `tmux attach -t jobops`. Logs: `.agent-logs/`. Heartbeat (run with
  every coder run): `go run -C .claude/bin/heartbeat .` flags IDLE, STUCK and DEAD tasks.
- `check.sh` covers only the TypeScript API and Go. Extension tasks use
  `TEST_CMD="sh extension/tools/check-ext.sh <file>"` (AGENTS.md rule 7).
- Token rules: `.claude/savingTokens.md`. Graph update once per milestone.

## Machine setup (outside the repo)

- Ollama is retired (2026-10-26): every model runs on llama.cpp from GGUF files
  in `~/models/jobops/`, started with `.claude/bin/llm.sh`.
- Docker Desktop: 5 GB memory, Kubernetes on, cluster type kubeadm (not kind: kind sees
  neither the local image nor `/Users`). Change these in its Settings window only: hand-editing
  `settings-store.json` crashed the VM (2026-11-04). Never "Reset to factory defaults" or
  "Reset Kubernetes cluster" without `bin/jobops db-backup` (the volume's reclaim policy is
  Delete).
- The careers crawler drives the installed Google Chrome (playwright-core); the
  OpenResume reader runs from `.scout/openresume-runner` (git-ignored, AGPL).
- aider and mini-swe-agent are `uv` tools; mini-swe-agent needs the `mcp`
  package (`uv tool install --with mcp mini-swe-agent`) and the text-based mode
  flags already in `run-mini.sh`.
- 16 GB RAM: run one 14B at a time; never alongside another model.
- Coder KV cache stays Q8_0 on the Homebrew llama.cpp (user, 2026-10-31). A KV-cache
  benchmark (Q4_0, TurboQuant TBQ3_0/TBQ4_0) was run and then deleted on request; any
  later experiment starts from scratch. The TurboQuant build is still at `~/llama-turboquant`.

## Known issues and lessons

- Coder-written tests were wrong in both milestones (invented error formats,
  bad seed data, changed expected values) while the app was right. Review test
  failures against the approved test plan before "fixing" code.
- aider once wrote to a placeholder path (`path/to/...`); `run-coder.sh` now
  flags that and empty targets.
- A 14B fix round once hung for an hour with no output; the 20-minute timeout
  now stops that.
- Specs must not contain triple-backtick fences (breaks aider's edit parsing).
- Specs must not contain full http:// URLs: aider scrapes them (in M5 it hit the laptop
  without a key). Write "host H port P path X".
- Milestone 5: 21 of 25 coder tasks escalated (no edit, Go redeclarations, made-up imports, a
  wiped file); the manager wrote most of B-F. `feedback.py stats` shows it.
- `autofix.sh` reverts every file changed outside the task during a run, new untracked
  files included: write nothing in the repo while a coder runs.
- Check for a running local stack (`tmux ls`, `pgrep -fl cli.ts`) right before touching the
  cluster's database: on 2026-11-04 the user had started it in between, and both stacks ran on
  separate copies for a few minutes.
- A LoadBalancer Service on Docker Desktop listens on all the Mac's networks, and pods see every
  caller as 192.168.65.3: never expose the UI that way (port-forward on 127.0.0.1).
- After a restart, start Docker (Qdrant) before coder runs; without it `run-coder.sh`
  stops and the log misleadingly says "coder window gone". Keep the `jobops` tmux session
  alive from a foreground command (a background task's tmux server dies with it).
