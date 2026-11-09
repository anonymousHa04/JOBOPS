# JobOps status

Handoff for the next session. Update this file at the end of every milestone
(and whenever a decision changes). Commit only when the user asks.

Last updated: 2026-11-06. **Milestone 8 is done** (user, 2026-11-06): containers, local Kubernetes,
gateway, CI workflow, the Go `bin/jobops` (`ctl/`), plus the M3/M7 follow-ups built on branch
`milestone-8` (Gaps tab and answer memory, click-to-tailor, one score, delete with reasons and skip
keywords, Keep this job, bulk deletes, readable logs for `bin/jobops watch`). JobOps runs in Docker
Desktop's Kubernetes: UI at localhost:8080 (`RUNBOOK-M8.md`), `bin/jobops start` brings everything
up (78 s from cold). The local tmux stack is stopped: run one or the other, never both.
Next: the user commits what is still uncommitted and merges `milestone-8` into `dev`; the first
CI run (needs a push); the open test plans (each needs the user's approval); then Milestone 6.

> Structured record of what is done and left: `.claude/knowledge/status.yaml`.
> Every Milestone 3 decision: the m3-notes skill, `references/decisions.md`.

## Bank gate (branch `atlassian-resume-fix` from milestone-8, 2026-11-07, uncommitted)

Why: Gaps answers on 2026-11-05 put unsupported bullets into the bank (a 1M claim, MCP before
2024-11, model wording, copied evidence, the job post's own term). Tailor and render trusted the
bank, so they reached the Atlassian application on iCIMS. Plan: `.claude/specs/plan-atlassian-fix.md`.
Code by Claude subagents (the user's choice for this work), with a review and a test run for every step.
- `api/src/profile/gate.ts`: one deterministic gate. Every bank write (`addBullet`: Gaps, CLI,
  MCP) blocks with reason codes. A story is required. Render blocks on the hard codes; term_added
  and scope_raised block unless the bullet is `reviewed` (`bullet review <id>`). The PDF route
  returns 409 for a failing resume.
- `bank audit` (read-only) lists failing bullets and skills, plus the chats' `fact_flags`.
- Gaps form: nothing pre-ticked; you pick the job or project, with its dates; Save is off on a
  refused draft. Restart options: Re-tailor from scratch, Restart check (new chat at round 1),
  Start over on a gap.
- Tailoring never picks a bullet the gate refuses: it takes the next best one and lists the rest
  as `left_out` in the Tailor box. The score and the skills line count only passing bullets. A job
  left with no bullets blocks the PDF (`role_dropped`).
- Tests: `api/test/bank-gate.test.ts`, `api/test/restart.test.ts`.
- Bank cleaned on 2026-11-07 with the user's OK: 13 bullets removed, 5 rewritten, 32 skills and the
  `platform engineering` synonym removed; backup in `data/backups/bank-gate-2026-11-07/`.
- 2026-11-08, from the user's answers: 12 bullets reviewed, 6 rewritten (production peak, Adadda
  10k at peak, mentoring merged, JobOps "designed; built by AI coding agents under my review",
  local models exact); "at peak" counts as a scale label. Backup `data/backups/bank-gate-2026-11-08/`.
  `bank audit` lists only `jobops-ats-parseback`, left out until the parser fix makes "three
  parsers" true. Tests 189 pass; pods rebuilt.
- Bank gate done (user, 2026-11-08). Atlassian re-tailored from scratch by the user.
- Bank gate is committed (95be7b4 and before).

## Parser / iCIMS fix (same branch, 2026-11-08, in progress)

Plan and findings: `.claude/specs/plan-parser-icims.md`. Tested with copies of resume 202f9634
uploaded by the user to Atlassian's iCIMS form (`data/ats/icims/v1-v3.pdf`): iCIMS keeps at most 5
dated entries (the career break pushed one job out), takes the employer from a recognised name
("(Client: X)" gave the client), one-line entries were worse, and Education/LinkedIn never fill
from any resume (the user fills them). User (2026-11-08): Claude subagents write the code; commit
at the end of every phase (T1-T6).
- T1 (parse gate): a required reader that is missing fails the check (`reader_missing`); tests opt
  out with `JOBOPS_PARSE_READERS=pdftotext,pdfjs`. OpenResume runs as a bundle
  (`.scout/openresume-runner/dist/parse.mjs`, plain node) hostPath-mounted read-only into the api
  and both worker pods. `ats recheck` (read-only) of the 8 PDFs since 2026-11-06: 3 pass
  (202f9634, 742bd6f6, 42105606-5467923b); 4 read Education as 0 entries, 2 miss a skill
  (OpenResume, which the pods skipped).
- T2 (772623f): career breaks stay in the bank but are off the PDF and the chat's resume text;
  `splitClient` prints "Client: Y" on its own line; skills boxed; Skills under the Summary.
- T3 (d21c7d0): `layoutIssues` blocks more than 5 dated entries and parentheses in a company;
  iCIMS findings in the m3-notes skill (ATS parsing).
- T4: Gurgoan -> Gurugram, India in profile/bank.yaml (user OK; backup
  `data/backups/parser-icims-2026-11-08/`). Atlassian record 202f9634 re-rendered to a scratch
  folder: passes all checks, 2 pages.
- Open for the user (found by `bank audit` 2026-11-08, outside this plan): 10 skills fail
  `skill_unsupported`, most on the Atlassian skills line; the render gate checks bullets, not the
  skills line. Chat fact flags on schneider-electric-load-test (number), schneider-electric-12,
  atdrive-group-3, mcp-server-mcp-servers (wording).
- T5 (2341dc9): `api/test/parser-icims.test.ts`, the 8 approved cases; 209 tests pass.
- T6: pods rebuilt (`bin/jobops up`); the runner is mounted in api, worker-laptop and worker-mac,
  and `ats check` in api and worker-mac lists three readers and passes.
- Skills clean-up (user's decisions, 2026-11-08; backup `data/backups/k3-2026-11-08/`): kept as
  same thing reactjs, containerization, cloud infrastructure; removed core engineering principles,
  compute platform; related work with the user's story and a linked bullet: self-healing
  infrastructure (schneider-electric-5), cell-based architecture (new patch-infotech-6, regional
  cells), Kubernetes control plane (kubeadm; mcp-server-mcp-servers), platform engineering (new
  conde-nast-8 Terraform, new schneider-electric-15 GitHub Actions + Docker), artifact pipelines
  (jobops-kubectl-go-cli; Condé Nast's Vogue pipelines are content/media, not artifacts); new
  skills terraform, ai product engineering (schneider-electric-ai-agents). The 7 related-work
  synonyms are removed (a synonym let a rewording put "Kubernetes control plane" into
  jobops-kubectl-go-cli). jobops-ats-parseback reviewed. `bank audit`: nothing fails; 4 chat flags
  left. Until the accepted-keywords plan: a related skill shows on every skills line.

## Exit gate (plan `.claude/specs/plan-exit-gate.md`, 2026-11-09, in progress)

Why: every check guarded a path, not the output, so each failure came through the next unchecked
path (workflow page https://claude.ai/artifact/8Aba5bqrQMPDCSfFvRCv3J). User's workflow: local
coders write code, Claude subagents write tests and escalated code, I PR-review; a commit per phase.
Docker runs only for Qdrant while coders work (user turns it off otherwise); JobOps pods are at 0
(`bin/jobops down`); general14 is stopped while the coder server runs.
- K0 done: `exitIssues` (render/exit-gate.ts) runs with the bank gate before every render: skills
  line (skill_unsupported), summary (summary_changed), open chat fact flags (fact_flag_open).
  Every render writes `<id>.checks.json` (7 checks; a reader not required or missing has ran=false);
  the PDF route serves only when `pdfChecksPassed` and the live gates pass, so PDFs made before K0
  need a new render. `flag resolve <bullet-id> --why` dismisses a chat flag
  (profile/reports/flag-resolutions.yaml); bank audit skips resolved flags. A static test fails on
  a new caller of saveBank / saveSkillsExtra / addSynonym (replaces the planned write.ts).
  Coder record: 3 of 10 tasks passed on the local coder (k0-02, k0-06, k0-09); 7 escalated to
  Claude subagents (k0-01, 03, 04, 05, 07, 08, and k0-10 only for its test); lessons recorded.
  Tests: api/test/exit-gate.test.ts (16); 225 pass.
- 2026-11-09: the user stopped the local coders (too slow: most tasks escalated); Claude subagents
  now write code and tests. Coder and embed servers, Qdrant and Docker are stopped.
- K1 done (verifier, off until calibrated): render/verify.ts + verify-rules.ts. The 7B model
  (task "verify", qwen2.5:7b, JOBOPS_VERIFY_MODEL) lists claims with quotes; code checks every
  quote is in the source and every number and skill term of the new text is in a quote
  (claim_unsupported), skills-extra skills against their evidence and linked bullets
  (skill_unsupported_model), and the summary against all bullets. Any model failure ->
  verify_not_run (blocks). Cached in verify_cache. With JOBOPS_VERIFY=on, renders through
  tools.render and `ats check <id>` add an 8th check "verifier". `verify eval [file]` (default
  data/verify-eval.yaml) checks A4; `synonyms audit` classifies synonym pairs (read-only).
  Tests api/test/verify.test.ts (28); 253 pass.
  Before turning it on: build the calibration file (user's known-bad and known-good cases), run
  `verify eval` with the laptop's 7B up; a summary "7+ years" claim cannot be quoted from a bullet,
  so add a derived "Total experience: N years" line from role dates to the summary source first.
- K2 done (accepted keywords): skills-extra skills get kind same|related and bullets[] (old
  "(used at ...; bullet X)" evidence still links). A related keyword is a tag on its linked bullets
  only, in memory (withRelatedTags; never written to bank.yaml, never a synonym), so scoring,
  missingKeywords/reword allowed and lint use it there only; the skills line lists it only when a
  linked bullet is on the resume (dropUnlinked), and the exit gate blocks it otherwise
  (skill_unlinked, kind related only). Gaps "Under another name": Same thing (skill + synonym) or
  Related work (pick bullets, story must name the term; no synonym). First use: a rewording that
  adds a related keyword is pending_review -> keyword_review blocks until "Approve wording" (Tailor
  box) or `keyword approve <resume_id> <bullet_id>`; approved_terms hold while the text hash is the
  same. Tests api/test/accepted-keywords.test.ts (12); 265 pass.
- K3 (data, user's decisions 2026-11-09; backups data/backups/k3-labels-2026-11-09/ and
  k3-flags-2026-11-09/): the 10 skills labelled (same: reactjs, containerization, cloud
  infrastructure; related with bullets: self-healing infrastructure, cell-based architecture,
  kubernetes control plane, platform engineering, artifact pipelines, terraform, ai product
  engineering). Chat flags: schneider-electric-load-test confirmed as source of truth
  (`flag resolve --confirm`: every later chat flag on it is resolved and the chat is told not to
  flag it); schneider-electric-12 dismissed (stale); the microservices bullet moved from AtDrive
  (atdrive-group-3 removed) to Schneider as schneider-electric-16 (user: the work was at
  Schneider); mcp-server-mcp-servers rewritten with the kubeadm facts and marked reviewed (the
  user approved the wording). `bank audit`: nothing fails, no open flags. 269 tests pass.
  Still open in K3: `synonyms audit` (needs the laptop's 7B).
- K4 done (4d96f58): iCIMS reports save as references (`ats references` compares every saved
  report in data/ats/ with today's fake resume and says when to re-upload); the summary check's
  source has a "Total experience: N years" line. Template for the user's upload:
  data/ats/icims-TEMPLATE.json -> icims-<date>.json.
- Calibration (779804b, data/verify-eval.yaml, 26 cases, git-ignored): round 1 failed A4 ("same as
  X" quotes passed); rules tuned (skill quote must name the skill); round 2 A4 holds: 0 false
  passes, 14/17 good (82%). False blocks: summary, mcp-server-mcp-servers, conde-nast-7 reword.
- Review mode (2987c8d, user chose "Send to review"): what the verifier cannot confirm is listed
  in the Tailor box ("Not confirmed by the verifier", Approve) or `verify approve <resume_id>
  claim|summary|skill <id>`; approvals in profile/verify-approvals.yaml hold while the text hash
  is the same. JOBOPS_VERIFY=on in infra/k8s/config.yaml (e3f371f).
- K6 done 2026-11-09: `bin/jobops up` + `start` (Kubernetes had been switched off in Docker
  Desktop settings; turned back on). `verify eval` in the api pod: A4 holds (same 0 / 82%).
  Atlassian re-tailored from scratch (batch 147) -> draft b841ad36-...-2104dc41. Verifier held 4
  items (conde-nast-7, jobops-kubectl-go-cli, skill Cloud Infrastructure, summary); the user
  approved all 4 as true. All 8 checks ran and passed (bank_gate, exit_gate, verifier, layout,
  pages_fonts, pdftotext, pdfjs, openresume); `ats check` ok. It is a draft that passes the
  checks, not "ready": not checked are iCIMS's real parse (user's upload) and the fields filled
  by hand.
- **Next (user):** upload draft 2104dc41 to iCIMS (fill Education and LinkedIn by hand) and share
  what autofill shows; upload the fake resume once to iCIMS and Workday (fill
  data/ats/icims-TEMPLATE.json); rewrite the Cloud Infrastructure skill evidence in your own words
  (part of it is model-written guesses). Then: commit STATUS, `/graphify . --update`, merge
  `atlassian-resume-fix` into `dev` when asked.
- Known follow-up: skill evidence matching (names()) does not handle plurals/synonyms.

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
  - **M3/M7 follow-ups on `milestone-8`** (2026-11-05, manager-written, committed by the user):
    - Gaps tab lists every red Score item. Years and degree items go under "Not asked here".
      "Other name" saves to `profile/synonyms.yaml`. "Draft a bullet" puts it under the checked
      job with the fewest bullets.
    - Tailored resumes use the JD's spelling, and new spellings are learned.
    - Tailoring starts only on a click: `retailor-<batch>` tasks; rescore never chains to tailor.
      Tailor now needs only 75+ and a dry run that would make a resume. Open gap questions no
      longer block it (user, 2026-11-06): they show as a note in the Tailor box.
    - Rescore all runs when the bank fingerprint changes (`ui_state`).
    - One score: the whole-bank score gates `decide`. The picker covers musts, then
      responsibilities, then nice-to-haves. Spec in m3-notes `engine-algorithm.md` §4.
    - Delete a job: drawer button, Go `POST /forget`, table `deleted_jobs`. Refused while a task
      is leased.
    - Delete reasons (user, 2026-11-06; manager-written, jd-search Go included):
      - **Why delete it?** (`ui/src/DeleteJob.tsx`, in place of `window.confirm`) offers the
        title's words and the JD's keywords as chips, a box for your own words, and a note.
      - The words go to `preferences.yaml` `skip_keywords` (`addSkipKeywords`, which keeps
        comments) and to `deleted_jobs.reason`/`keywords`.
      - Words of your own target roles or seniority words are refused (`roleWords`), so a
        delete cannot hide every job.
      - jd-search skips a posting whose title or description has a skip word as a whole word
        (`filter.SkipKeyword`, reason `keyword: <word>`), on new fetches and in the stored-job
        re-check before each batch.
      - Checked with Playwright and `jd-search check` on demo data.
      - The suggestions are this job's red Gaps keywords plus its title words. "Already on
        your skip list" shows only the saved words this job has.
      - Top bar **Delete N jobs with skip keywords** (simplified 2026-11-06: no per-job
        checkboxes; never takes tailored, applied or kept jobs) (`ui/src/SkipDelete.tsx`; routes
        `GET /ui/skip-matches`, `POST /ui/skip-matches/delete`) counts live: title or
        description, whole words. A confirm panel lists each job with the word it matched,
        then each is deleted through `deleteJob`, with reason `skip word: <w>`.
      - Jobs marked applied, interview or offer are never bulk-deleted; they are listed apart.
        Checked with Playwright on demo data.
      - Incident 2026-11-06 01:11 IST: the first bulk delete (before the tailored-job checks)
        removed 60 jobs, including two tailored ones: Databricks Senior SWE (Infra) `117457f0…`
        and Okta Workflows `e4e6644d…`.
        - Restored from `data/backups/jobops-20261106-011023.db`: jobs, requirements, 16 gap
          answers, the Databricks tracking row. Both removed from `deleted_jobs` and marked kept.
        - Their 4 resumes (YAML and PDF) are lost: no snapshots, Time Machine not mounted.
          Next: Re-score, then Tailor now.
        - The live DB just before the restore: `jobops-20261106-011723.db`.
      - Board selection (user, 2026-11-06, simplified the same day): only Skipped cards have a
        checkbox, and the Skipped column header ticks the whole column.
        - **Delete N selected** in the top bar (`ui/src/BulkDelete.tsx`; routes
          `POST /ui/jobs/bulk-delete/preview` and `/ui/jobs/bulk-delete`) opens a confirm panel:
          tailored jobs with their resume counts, kept jobs marked.
        - Applied, interview and offer jobs are deleted only with an extra tick, otherwise left.
        - Checked with Playwright on demo data.
      - Logging for `bin/jobops watch` (user, 2026-11-06). Before, a delete showed only as two
        JSON request lines among about 250 polling requests every 30 min.
        - API (`api/src/log.ts`): readable `YYYY/MM/DD hh:mm:ss` lines. Successful GET polling
          is not logged; writes, errors and requests slower than 2 s are.
        - API action lines: job deleted (title, reason, resumes, tasks), bulk-delete
          summaries, skip words added or refused, kept or unkept, gap answered, carried,
          reused or undone, gap match, tailor, rescore and rescore-all queued, gap setting.
          Ids, titles, counts and JD wording only.
        - Browser errors go to `POST /ui/client-log` (`ui/src/clientLog.ts`, throttled) and
          show as `WARN ui error`.
        - Queue: a line on batch start and retry, sweep, rescore, tailor, forget, and task
          lease, done and fail (result summary: decision, score, resume id). Worker heartbeats
          log only state changes: up, quiet after 90 s, back.
        - Gateway: one line per proxied write request and per failed request.
      - **Keep this job** (drawer toggle; table `kept_jobs` in both `db.ts` and the queue's
        `db.go`): a kept job is left out of the stored-job preference check
        (`FilterCandidates`) and of the bulk delete. Delete and forget drop the mark.
      - Each job in the panel has a checkbox, and only ticked jobs are deleted. Tailored jobs
        (`resumes` > 0) are listed first, marked "tailored · N resumes", with a **Keep tailored
        jobs** toggle (user, 2026-11-06).
  - **Add a job by link** (user, 2026-11-06, manager-written on `milestone-8`, uncommitted, not
    deployed): toolbar box "Paste a job link…" (`ui/src/AddJob.tsx`, `POST /ui/jobs/add`,
    `api/src/ui/add-job.ts`). Fetches with `fetchJob` (Greenhouse, Lever, Ashby, Workday,
    SmartRecruiters, careers pages), stores it, marks it kept, and queues an `add` batch (queue
    `POST /add`, `store.Add`): parse, then score, which is final (no tailor; Tailor now stays a
    click). LinkedIn, Naukri, Indeed, Glassdoor, foundit/Monster, Instahyre, iimjobs, hirist and
    Wellfound links are refused. Checked on demo data (curl, the queue chain by hand, Playwright).
    Tests not written: test plan waits for the user.
  - **Change feed, no polling** (user, 2026-11-06, manager-written on `milestone-8`, uncommitted,
    not deployed). Every wait follows Server-Sent Events; health checks still poll (user).
    - Queue: `internal/events` hub; the store publishes after each commit (task queued, leased,
      done, failed; batches; forget; preference check), one event per job a fetch queues.
      `GET /events` streams it. The fetch loop waits on it (30 s fallback for retry backoff).
    - API: `api/src/events/` (SSE client on the npm `eventsource` package, MIT, added by the
      user's choice 2026-11-06; bus). It relays the queue's feed and adds its own writes
      (any write with a job in the path; add, deletes and new `/jobs` publish their own).
      `GET /ui/events` for the browser; `GET /ui/board/:id` returns one card.
    - Workers: idle loops wait on the queue's feed (30 s fallback); SIGTERM wakes them.
    - UI (`ui/src/events.ts`): one EventSource per tab. The board re-reads only the changed card
      (more than 25 at once, a preference check, or a reconnect: one full load). Batches tab, the
      open drawer and Re-score follow it too. No setInterval left except the health bar.
    - Gateway: `statusWriter.Unwrap`, without which the proxy buffered the stream.
    - Checked on demo data: events through the gateway about 20 ms after a queue change;
      Playwright: a card moved Parsing → Scoring → Not tailored in about 0.6 s with one full load
      (two in Vite dev: StrictMode), the drawer followed a lease. Tests wait for the user's plan.
    - Open (older code, not changed): a failed task shows in Failed only when `final = 1`, and
      `failTask` never sets it. Ask the user whether that is intended.
  - **Gap help through the queue, smaller prompts, general14 on demand** (user, 2026-11-07,
    manager-written on `milestone-8`, uncommitted, not deployed; tests first, user's request).
    - Cause of the "Explain all" timeouts: the API called general14 (1 slot) directly while the
      queue leased up to 3 Mac tasks at once; extra requests waited inside llama-server.
    - Queue: stage `gap_help` (Mac group, leased before tailor, final when done), `POST /gap-help`
      (`store.GapHelp`, one task per gap key, open ones not queued twice). Group limits match the
      servers' slots: 3 and 3 (`JOBOPS_MAC_SLOTS`, `JOBOPS_LAPTOP_SLOTS`). general14 back to 3
      slots with `-kvu` (`LLM_GENERAL14_SLOTS`, user 2026-11-07); it ran with 1 before.
    - API: `POST /ui/jobs/:id/gaps/help` returns a saved explanation, else 202 queued;
      `POST .../gaps/help-all`; gap list `help_queued`. The Mac worker runs it (`runStage`).
    - Prompt: `api/src/ui/gap-related.ts` picks at most 5 bullets: word match (scoring index) plus
      Qdrant's nearest (collection `bank_bullets`, re-embedded when the bullets change); none
      found: the whole bank. Was ~1,770 prompt tokens per call.
    - general14: `llm.sh` adds `--sleep-idle-seconds ${LLM_GENERAL14_SLEEP:-300}` (frees the model
      after 5 idle minutes; health stays 200; a request wakes it). Needs a general14 restart.
      Test: `.claude/bin/test_llm_sleep.sh` (0.5B on port 8099).
    - Tests: `api/test/gap-queue.test.ts` (12), `queue/internal/store/gap_test.go`; m5-worker's
      groups test updated. Checked on demo data: Explain all, 3 gaps, fake 14B saw 1 at a time.
  - **Check tab: Claude check after tailoring** (user, 2026-11-07, manager-written on
    `milestone-8`, uncommitted, not deployed). User's choices: the loop applies on its own (best
    engine score kept), the drawer button talks to the extension, flag a score drop and never
    keep a lower version, Claude by default.
    - `api/src/ui/check.ts` + `GET /ui/jobs/:id/check`: the current resume's engine score against
      the job's (whole bank), requirements it lost, each loop round (scores, kept, current, bullets
      added/removed/reworded), the report's missed gaps, bullet notes and from-memory facts.
      `GET /ui/resumes/:rid/pdf` serves a stored record's PDF (path from the id only).
    - `api/src/extension/step.ts` `fixStep` (POST /x/fix): best version always current on return
      (also after a throw); a new best is rendered to PDF (fix rounds never rendered before).
      `saveLoop` creates `profile/reports/`.
    - Extension: bug fixed in background.js (`const { round } = get("loop")` was always
      undefined, so no fix round ever ran from the popup). New `jobops.js` bridge on the JobOps
      page (8080, Vite 5173): `check` message starts the run; status forwarded to the page.
      The user must reload the unpacked extension.
    - Workflow changed the same day (user): the loop goes on until nothing it can fix is left
      (`covered`), a round changes nothing (`no_change`), an error, or 5 fix rounds (was 4; the
      extension now sends round 5). Ties count as kept. Your resume is current again at the end;
      the best version, if it scores the same or higher, waits as `candidate`. Check tab: "Use new
      resume" (current + PDF) / "Keep previous" (`POST /ui/jobs/:id/check/decide`, `decideCheck`).
      Old tests for "round 5 stops" and "no gain keeps the best" were updated to this.
    - Tests: `api/test/check-step.test.ts` (9). Checked on demo data with Playwright and a
      stand-in bridge (Chrome no longer loads unpacked extensions in automated runs).
    - First real check (user, 2026-11-07) stuck at "Fixing (round 1)". Three bugs, each reproduced
      end to end with the real extension in Chrome for Testing (Playwright's cache), a fake
      claude.ai over local HTTPS (--host-resolver-rules), the demo API behind a proxy that holds
      /x/fix like a real round (scratchpad e2e/, not in the repo):
      1. Chrome stops the extension's service worker after ~30 s idle even while it awaits fetch;
         a 2-minute fix round lost its answer. Fixed: `keepAlive` in background.js (an API call
         every 20 s) around saveReport and /x/fix. Shown only with nothing attached to the worker
         (raw DevTools driver on the page, `cdp-run.mjs`): old stuck, fixed passes at 70 s and 3 min.
      2. chat.js gave up on an answer after 6 minutes; now 5 minutes without progress, 20 at most.
         Old failed at 6:04 on a 7-minute answer; fixed saved it.
      3. A round whose resume equals an older record (same content) did not become the newest, so
         the loop saw no change. fixRound makes the tailor's own resume current.
      4. (user, same day) Every attempt sent Claude the same resume: a round that scored lower put
         the best version back, so the prompt carried it with "No bullets changed" and Claude
         repeated itself. Now the chat always gets the round's own version and its real changes,
         the next round builds on it, the best is tracked apart (only it is offered), and a round
         that recreates a version of this check stops the loop (`repeat`). Nike job's loop file
         showed it: v0 83.2, v1 82.3, v2 82.3.
    - Choose this (user, 2026-11-07): each round row of a finished check has a button. The chosen
      version becomes the resume (PDF made unless it is the starting one), the job is re-scored
      (queue `/rescore`), and the next Check starts a new chat (`newChat` → extension
      `forgetChat`). `POST /ui/jobs/:id/check/decide` takes `use` or `resume_id`; loop records
      `chosen`. Buttons wait until the extension reports done. Checked end to end (cdp-run.mjs
      CHOOSE=1): round 1 chosen, PDF made, then prompt 3 was the first-time prompt with it.
    - Resume list (user, same day): the Check tab lists every tailored resume of the job (tailor,
      re-tailor, check rounds), best engine score first, with Claude's fit score and PDF link (a
      "whole bank" row was added, then removed at the user's request).
    - Drawer header (user): "Job score N ⓘ" (whole bank; decides Tailor now) and "Resume N ⓘ" (the
      current resume's own bullets, from GET /ui/jobs/:id/check), each with a hover explanation,
      in place of the bare score next to the state chip. Board cards unchanged. Choose this on
      any row: `POST /ui/jobs/:id/resumes/:rid/choose` (`chooseResume`: own job only, PDF if
      missing, re-score, checks marked chosen so the next one is a new chat). The rounds table
      lost its buttons (details only).
  - **Milestone 8: containers and local Kubernetes** (branch `milestone-8`, committed; written
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

- **Gap answers may name their own requirement** (user, 2026-11-08, on `atlassian-resume-fix`,
  manager-written, uncommitted). A bullet saved from a Gaps answer keeps which gap it answers in its
  evidence: `answer YYYY-MM-DD (for: <requirement>): <story>` (`answerEvidence`, `readAnswer` in
  `api/src/profile/gate.ts`). The bank gate (draft, save, tailor, render) then allows that
  requirement and its terms (`answerAllows`) though the story does not use the word; any other term
  the story lacks is still `term_added`, and other bullets are unchanged. Was: "multi-cloud" for a
  story about AWS + GCP blocked the draft. Tests: 5 in `api/test/bank-gate.test.ts`.
- **Draft wording** (same day): the draft prompt lists the AI-wording words to avoid; a failed draft's
  retry names the exact words ("Do not use: ensuring"); a draft still blocked returns `words` and the
  Gaps message says "Remove or reword: ...". The bank gate's story rule: one listed word used
  normally in the user's own story ("writing and suggesting code") is not model_wording; a phrase,
  a rider, a listed word as a comma rider, or two listed words still are. The bullet stays strict.
  Tests: `api/test/draft-wording.test.ts` (3), 3 more in `bank-gate.test.ts`.
- **Auto-check after tailor** (user, 2026-11-08): Check tab switch "Check with Claude|ChatGPT after
  each tailor, for every job" (`ui_state` check_settings, `GET/POST /ui/check/settings`). `ui/src/
  AutoCheck.tsx` (always mounted): a tailor task done with a new resume (`created` not false, not
  not_tailored) starts a check in a new chat through the extension bridge (`ui/src/extension.ts`,
  shared with the Check tab); one at a time, others wait; a localStorage mark stops a second tab
  starting the same one. Needs a JobOps page open in Chrome. Checked end to end with a real queue
  and a stand-in bridge (off, on, existing resume, queueing, two tabs). Test: settings route.

## Where to start next

- Milestone 8 is done. Still uncommitted on `milestone-8` (the user commits): the 2026-11-05/06
  work below and in "Where things are" (answer memory, delete reasons, skip keywords, Keep this
  job, bulk deletes, logging). Deployed by the user except the last UI changes (Skipped-only
  checkboxes, the always-shown skip-keyword button): redeploy with `bin/jobops db-backup &&
  bin/jobops up`.
- **Gaps answer memory** (`api/src/ui/gap-memory.ts`, deployed and used by the user).
  - Exact asks (normalized, synonyms included) take your earlier answer automatically, marked
    "from <job>", with Undo. Undo marks the gap `declined` for that job.
  - Similar asks are found by key-word overlap. general7 checks each pair (task `gap_match`, JD
    wording only), then you accept or reject it.
  - Every verdict is saved in table `gap_links`, and yours always beat the model's. An accepted
    pair is carried automatically from then on.
  - A carried learnable answer is written for the new JD, because `decide` reads it.
  - Both reuse ways are kept (user, 2026-11-05):
    - Carried answers have **Edit / improve**, which opens the form filled from the earlier
      answer (for example, to turn a skill worth 0.3 into a bullet worth 0.85).
    - Suggestions, and gaps where Undo was used, have **Use my earlier answer**, which fills
      the form without saving.
    - The switch "Fill exact matches automatically" (`ui_state` `gaps_auto_carry`, routes
      `/ui/gaps/settings`) turns suggest-only on for exact matches.
    - **Add previous response and rescore** (user, 2026-11-05) sends the earlier answer for
      this gap in this job's wording and re-scores. It goes in as a skill, or as the other
      name; never as a second bullet. A similar ask is also recorded as "same". A keyword
      then leaves the gaps.
    - On a sentence (must-have, responsibility, nice-to-have), the button skips "Draft a bullet":
      it fills the form and drafts the bullet at once, under the earlier roles' job with the
      fewest bullets. The user checks the draft, then clicks **Add skill and bullet point and
      re-score** (`with_skill`: the skill is saved even with one role). A bullet counts 0.85;
      the skill alone would count 0.3 (engine spec §3, unchanged). `from_previous` records the
      two asks as the same.
    - The story, proof, roles and other name are saved in the new column `gap_notes.input`.
      Older answers are read back from their bullet or skill evidence notes (`parseEvidence`).
  - New routes `POST /ui/jobs/:id/gaps/carry|match|reuse|undo`. New column
    `gap_notes.carried_from`.
- Then: commit and merge into `dev` (user), push, first CI run (never run yet), the test plans
  below, then Milestone 6. Graph updated at the end of Milestone 8 (2026-11-06).
- Two restored jobs (Databricks Senior SWE (Infra), Okta Workflows) have no resumes: Re-score,
  then Tailor now. Their original resume files are lost unless the Time Machine disk has them.
- Finding more jobs: `companies.include` is a test list. A wider search (a seed company list plus
  Adzuna/Jooble discovery) was built and then reverted by the user on 2026-11-06. The approach is
  still open.
- Test plans waiting for the user's approval, run after the deploy: Gaps routes and prompt,
  tailor-ready, Rescore all, spelling learning, picker cover passes, one-score decide, delete
  with `deleted_jobs` and `/forget`, delete reasons with `skip_keywords` (TS and Go `filter`),
  answer memory (carry, match, reuse, undo), Keep this job (`kept_jobs`, queue
  `FilterCandidates`), bulk deletes, the new log lines, `ctl`, and keeping
  `gateway/main_test.go`.
- Dropped by the user (2026-11-05): queue tasks left behind when the queue is down during a
  delete.
- Milestone 8 leftovers (not blocking): the gateway unit test (`gateway/main_test.go`, written without an
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
