# Milestone 3: Candidate profile, matching, and resume selection

Status as of 2026-10-26, branch `m3-engine`. The live, item-by-item state is in
`.claude/knowledge/status.yaml`; design decisions and their reasons are in
`M3-NOTES.md`. This file is the overview.

## Goal

Turn one resume into a verified experience bank, find job posts that fit the
candidate's preferences, score the bank against each job, and produce a
tailored resume per job without inventing anything. All models run locally;
no resume content leaves the machine.

## How it fits together

    preferences.yaml ──► jd-search (Go) ──► POST /jobs ──► jobs table
                                                             │
    resume (profile/) ──► bank build (once, 14B) ──► bank.yaml (user-approved)
                                                             │
    jobs ──► JD parse (7B) ──► requirements ──► score ──► risk check
                                                             │
                                  resume selection engine (next) ──► tailored resume record per JD

## Built

### Candidate data (`profile/`, git-ignored)

- `profile/original/`: the resume (PDF and extracted text) and its sources.
- `profile/preferences.yaml`: target roles (SDE3, FDE, senior, staff, plus
  suggested related roles), 40–45 LPA, Bangalore / remote / hybrid, no visa
  needed, 37 target companies, tailoring budget (4 bullets per role, 14 total,
  25 words).
- `profile/bank.yaml` and `profile/skills-extra.yaml` are created by the bank
  commands below. Nothing in `profile/` is ever committed or logged.

### Job search (`jd-search/`, Go)

- Fetches public job boards (Greenhouse, Lever, Ashby) for every preferred
  company in parallel: 6 workers, per-host rate limits, retries, and board
  auto-detection.
- Filters by role title and aliases, seniority, and location (Bangalore, or
  remote open to India).
- Sends matches to the JobOps API (`POST /jobs`), which removes duplicates.
- Dry run: 37 companies, 21 reached, 4,528 posts, 113 matches.
- Run: `go run ./jd-search/cmd/jd-search run [--dry-run]`; also an MCP server
  (`search_jobs`, `detect_boards`).

### Schemas and storage

- Zod schemas: bank, bullets, extra skills, preferences, resume records
  (`api/src/profile/schema.ts`), parsed JD requirements
  (`api/src/requirements/schema.ts`).
- SQLite tables `job_requirements` and `resume_records` (`api/src/db.ts`).

### Model layer

- `api/src/model/llm.ts`: local llama.cpp provider. Output is forced to the
  schema, validated again with Zod, and retried once; errors are returned with
  the command to start the right server, and never include model output.
- `api/src/model/prompts.ts`: loads the user's three prompts from
  `requierements/` and fills only the given placeholders.
- Model servers (`.claude/bin/llm.sh`): `general7` (qwen2.5:7b, JD parsing and
  rewording) and `general14` (qwen2.5:14b, bank build). Only one large model
  runs at a time on this 16 GB machine; the script enforces it.

### Experience bank (`api/src/profile/bank.ts`)

- One-time build from the resume with the user's prompt 1 on the 14B model.
  The build refuses to overwrite an approved bank.
- Checks: every number in a bullet must appear in the resume, bullet ids are
  unique and prefixed, `short` has at most 15 words, 5–8 tags. Issues name
  bullet ids only, never bullet text.
- Additions the user vouches for: extra skills (have / don't have), bullets
  the user writes (`source: user`), learnable-skill answers per JD, and
  dismissed risk questions.

### JD parsing (`api/src/requirements/parse.ts`)

- The user's prompt 2 on the 7B model: role, seniority, must-have,
  nice-to-have, keywords, themes, summary variant.
- Cached per job and prompt version. Keywords that are not word-for-word in
  the JD are dropped, because applicant tracking systems match literally.

### Scoring (`api/src/scoring/`)

- Each requirement is labeled supported, partial, learnable, not demonstrated,
  or unknown, with the evidence bullet ids. Matching uses synonyms (k8s =
  kubernetes, and so on).
- Score = 60 must-have + 20 nice-to-have + 20 exact keywords.
- Five bands: excellent ≥ 95, strong 85–95, moderate 75–85, poor 60–75,
  very poor < 60.
- Years of experience is the only hard constraint. A job is `tailorable` only
  if it passes and the band is excellent, strong, or moderate.
- Missing skills come back as questions, with the user's earlier answers for
  other JDs.

### Risk check (`api/src/scoring/risk.ts`)

Reasons a good match could still be rejected, each phrased as a question for
the user: missing must-haves, too few years, weak senior signals, few
measurable results, keyword misses, and a title below the role's level.

### Access

- CLI: `node api/src/cli.ts <command>`. Commands: `bank build|check|approve|status`,
  `skill add|no`, `bullet add`, `learnable <skill> yes|no --job <id>`,
  `risk <job>`, `risk skip <id>`, `jobs`, `jd parse <job>`, `jd parse-all`,
  `score <job>`.
- MCP server `jobops-tools` (9 tools, same operations), registered in `.mcp.json`.

## Next: the resume selection engine

Design: `requierements/jobops_resume_selection_generation_engine.md`, with the
decisions in `M3-NOTES.md`. For each JD:

1. Score the existing resume records and pick the best starting point.
2. Build the ideal bullet set for the JD: must-haves first, then impact, within
   the tailoring budget.
3. Compute content equivalence against the starting resume.
4. Decide what to do:
   - excellent fit and ≥ 95% equivalent → **reuse**;
   - strong or moderate fit → **adapt**;
   - poor or very poor fit, or the years constraint fails → **not tailored**;
   - unsupported must-haves are flagged in every case.
5. Adapt: reword with the user's prompt 3 on the 7B model. A check in code
   rejects any rewrite that adds a skill, tool, number, or scope.
6. Open risk questions stop the engine until they are answered (`--force`
   overrides).
7. Write one YAML resume record per JD, never overwritten. The original resume
   is the first record.
8. Expose it as `tailor <job>` in the CLI and in the MCP server.

### Open before or during the engine work

- **Content equivalence formula.** Proposal: per bullet, same id and text = 1,
  reworded = 0.5, otherwise 0, plus one unit for the summary variant; as a
  percentage of the union.
- **Who writes the engine code:** the local coders through the agent system
  (recommended), or the manager.
- **Tests:** 12 minimal cases on a fake resume (7 for the parts built so far,
  5 for the engine), pending user approval.
- **Real bank:** a one-time build on the actual resume and user approval of
  `profile/bank.yaml`; needed only for real tailoring.

## Rules that apply throughout

- No resume content in commits, logs, or cloud models; everything that reads
  it runs locally.
- No invented experience, metrics, employers, or dates. Every tailored bullet
  traces to a bank bullet.
- Section titles in the resume are never changed.
- The rewording model is flagged as temporary; a better option will replace it.

## Related

- `M3-NOTES.md`: decisions, the user's answers, and resolved conflicts.
- `.claude/knowledge/status.yaml`: current state of every item.
- `LOCAL-AGENTS.md`: how the local coding agents run (llama.cpp, knowledge
  layer, feedback loop).
- `README.md`: product scope and roadmap.
