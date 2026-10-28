# Decisions digest (everything agreed so far)

Read this before any JobOps product task. It collects every decision from the
working sessions in one place. Where it disagrees with an older note, this file and
`engine-algorithm.md` win. Live state of each item: `.claude/knowledge/status.yaml`.
History and reasons: `M3-NOTES.md`.

## Privacy and honesty (never break these)

- Resume, bank, reviews, preferences, and tailored records live in `profile/`
  (git-ignored). Never put their content in code, tests, commits, logs, or prompts
  to a cloud model. Only local models (llama.cpp) and local tools read them.
- Never invent experience, numbers, scope, tools, employers, titles, or dates. Every
  bullet traces to a bank entry: `source: resume` (the original resume) or
  `source: user` with `evidence` (the user's own answer).
- Tests use a fake resume only.

## Candidate preferences (profile/preferences.yaml)

- Roles: SDE 3, Forward Deployed Engineer, Senior Software Engineer, Staff Engineer,
  plus suggested related senior roles.
- Compensation 40–45 LPA. Bangalore, remote, or hybrid; no visa needed.
- Target companies: the list in preferences.yaml (public job boards only).
- Tailoring budget: 4 bullets per role, 14 total, 25 words per bullet
  (engine-algorithm suggests 5–6 for the current role, 1–2 for the oldest).

## Matching and decisions

| Topic | Decision |
|---|---|
| Fit bands | excellent ≥ 95, strong 85–95, moderate 75–85, poor 60–75, very poor < 60 |
| Hard constraint | Only years of experience; failing it means no tailoring, whatever the band |
| Tailorable | Years gate passes and band is moderate or better; poor and very poor get a record with `not_tailored` and the reason |
| Learnable skills | Asked each time per JD; the answer is recorded with the JD and earlier answers are shown next time. Score credit 0 (engine-algorithm), but a learnable gap is not a blocker for a moderate fit (user) |
| Risk questions | Option A: the engine stops and asks before any rewording; `--force` overrides |
| Reuse vs adapt | Reuse when content equivalence ≥ 95 (any tailorable band), otherwise adapt; formula in engine-algorithm §5 |
| Resume length | Up to 2 pages (user, 2026-10-28; preferences tailoring.max_pages), overriding one page up to 8 years; over the limit, the weakest bullets are dropped, never an entry's only one |
| Equivalence formula | The §5 formula as written (union + 2, with a skills unit), not its worked examples (union + 1); confirmed by the user 2026-10-28 |
| Unsupported must-haves | Flagged on every decision, including reuse |

## Resume content rules

- Summary: pick the best bank summary variant as written; never reworded.
- Sections: education always included; projects count toward the bullet budget;
  skills ordered JD-first, nothing added beyond the bank and user-confirmed skills.
- Never change section titles. Titles, employers, and dates are fixed fields.
- Rewording: the user's prompt 3 on local `qwen2.5:14b` (switched from 7B 2026-10-27), one bullet per call; the guard
  (engine-algorithm §6) rejects added numbers, terms, raised scope, scope phrases,
  over-length text, and changed fixed fields. **Flagged:** this model is temporary.
- Bullet writing rules: `bullet-writing.md` and SKILL.md (verb ladder, metric
  restraint, no planned work, plain specific words).

## Review-aware tailoring

- The candidate's own resume review lives in `profile/reviews/` (e.g.
  `profile/reviews/initial-resume-review.md`). It is private: read it only with local
  tools or local models, never copy it into code, tests, logs, or this skill.
- When tailoring or reviewing a record: load every file in `profile/reviews/` first,
  treat its findings as known weaknesses to address (or at least not repeat), and
  report which findings each tailored record still leaves open.
- Not built yet (deferred by the user 2026-10-27, after the template step): the
  review is free text, so `review extract` will have local `qwen2.5:14b` turn it once
  into `profile/reviews/findings.yaml` (id, kind, engine action); the user approves
  that file like the bank, and `tailor` applies it. Until then records store
  `review_findings: []`. Tracked in `.claude/knowledge/status.yaml`
  (`m3-review-findings`).
- Engine-fixable findings (skills trimming, ordering, summary variant, spelling,
  length) are applied by the engine; findings that need new facts become questions
  for the user (`bullet-writing.md` question bank), never invented content.

## Records, files, and later steps

- One YAML resume record per JD in `profile/records/`, never overwritten; the original
  resume is the first record. YAML is the source of truth; SQLite `resume_records` is
  the index (content hash, bank hash, engine version).
- Not every JD needs a new resume: reuse is expected when equivalence is high.
- PDF only when applying directly (after a referral attempt gets no positive answer);
  rendered from YAML later (typst), ATS-safe template with a parse-back test.
- Job sources: public Greenhouse, Lever, and Ashby APIs only; no LinkedIn or Indeed
  scraping.

## Runtime and data

- All models run on llama.cpp (`.claude/bin/llm.sh`): `coder` (qwen2.5-coder 14B with
  a 0.5B draft model), `embed` (mxbai), `general7` (qwen2.5 7B: JD parsing, judge),
  `general14` (qwen2.5 14B: bank build, rewording). Only one heavy model runs at a time (16 GB).
- Product code calls models through `api/src/model/llm.ts` (`generate()`), never directly.
- Vector search: Qdrant in Docker on 127.0.0.1; the index is written only after an
  accepted task, and only from the main checkout.

## How coding tasks are done

- Edit only the files the task names. No new dependencies; installed packages and the
  TypeScript/Zod/Node rules are in `.claude/agents/coder-patterns.md`.
- No tests unless the task asks; test cases need the user's approval first.
- Specs never contain code fences or SQL comments; paths are exact, with extensions.
- End every reply with `STATUS: done|blocked` and `BLOCKERS:` (report-format.md).
- Known fixes from earlier failures arrive in your context; apply them.
- The manager reviews, commits, and takes over escalations; agents never commit.
- Work split for the engine: the manager writes ideal/equivalence/decide/guard/scoring
  and their tests; local coders write the `tailor` CLI, MCP tool, YAML writer, prompt-3
  wiring, and lint.
- Docs written for this repo: file paths in backticks; no Markdown links (the user's
  preference); comments for paths where a link would go.
