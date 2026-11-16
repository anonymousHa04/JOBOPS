---
name: m3-notes
description: JobOps M3 playbook for writing and reviewing resume experience bullets from verified evidence, finding gaps that get resumes rejected, and working on the resume selection engine (scoring, inverted index, content equivalence, reuse/adapt decision, rewrite guard). Use this skill whenever the user wants to write, rewrite, tighten or check resume bullets, turn work facts or interview answers into bullets, add bullets to the experience bank (bank.yaml, `bullet add`), review a resume for why it is not getting shortlisted, check a resume against a JD, or touch scoring, tailoring, `tailor`, `score`, `risk`, or engine code in the JobOps repo, even if they don't mention M3 or this skill by name.
---

# M3 Notes: Bullets, Gaps, and the Selection Engine

This skill holds the decisions made for JobOps Milestone 3. **Start every task by reading
`references/decisions.md`**: it collects every decision agreed so far (privacy, bands, years
gate, learnable skills, risk questions, rewording, sections, records, runtime, how coding
tasks are done). Use this skill for three jobs:

1. **Writing bullets** from verified facts (most common). Workflow below.
2. **Finding gaps** in a resume or a tailored record. Read `references/gaps-and-rejection-risks.md`.
3. **Engine work** (scoring, matching, equivalence, decision, guard, records, tests).
   Read `references/engine-algorithm.md`.

The one rule behind all three: **nothing goes on a resume that the candidate cannot
defend in an interview.** No invented numbers, scope, tools, employers, titles or dates.
Every bullet traces to a bank entry whose evidence is either the original resume or an
answer the user gave.

Privacy: resume content (bullets, answers, reviews) belongs in `profile/`, which is
git-ignored. Never put real resume content into this skill, commits, or logs.

---

## Writing bullets

### Step 1: Gather facts before writing

A bullet is only as good as the facts behind it. When a bullet lacks scale, outcome or
ownership, ask for the missing fact instead of filling it in. Use the question bank in
`references/bullet-writing.md` (scale, measured result, ownership, constraint, reliability,
mentoring). Ask only the questions the bullet actually needs.

### Step 2: Reconcile the numbers

Before drafting, check that the user's numbers agree with each other. Real example of the
pattern: "~450 people per session", "designed for 40 engineers" and "load test broke at 50"
cannot all describe concurrent users. Usually they measure different things (members vs.
concurrent editors vs. test load). Name the conflict, propose the likely reading, and ask
one question. An interviewer will find a mismatch the resume hides.

Separate these kinds of numbers explicitly; they answer different interview questions:
- **Scale**: how big (members, teams, services, data volume).
- **Production**: what real usage looked like.
- **Test/headroom**: what was tested beyond production.
- **Result**: what changed because of the work.

### Step 3: Draft with action + scope + outcome

Structure: strong verb (true to the user's role) + what was built or decided + scope or
outcome. Google's version: accomplished X, as measured by Y, by doing Z. Not every bullet
needs all three; a bullet with clear scope and no metric is fine.

Hard rules:
- **Word budget**: 25 words maximum per bullet (from `preferences.yaml`); count them.
- **Verb honesty**: use the scope ladder. "Led design" only if the user led it; "built" for
  parts they built. Never move a verb up the ladder in a rewrite.

  ```
  assisted / supported / contributed
  built / developed / implemented / wrote
  designed / owned / drove
  led / architected / spearheaded / headed
  ```
- **Numbers**: only numbers the user stated. Keep "about" if the user was approximate.
- **No gain that didn't happen**: policy-driven or compliance work is stated as scope
  ("migrated 40 functions to meet an Azure-only policy"), never with an invented benefit.
- **Decisions over tasks** for senior roles: show the trade-off or constraint
  ("kept X so 3 other teams' workflows stayed intact").
- **Metric restraint**: at most 2 metric-led bullets per role, about half overall. Never
  restructure a bullet to lead with a number. A resume full of percentages reads generated.
- **Plain, specific words**: name the system, users, and what it does. "AI agents that
  analyze components" says little; "AI agents that check designs against manufacturing
  goals before submission" says what they do.
- **Done work only**: no "planned", "will", "working on" for senior-level resumes.

### Step 4: Check the draft

Run the checker on drafted bullets:

```bash
python scripts/check_bullets.py bullets.yaml
```

It flags: over 25 words, numbers not found in the evidence, verbs above the evidence's
ladder level, planned-work phrasing, repeated opening verbs, and soft-skill filler. Fix
every flag or explain why it is a false positive.

### Step 5: Produce bank entries

Output each bullet as a bank entry with its evidence, so the bank's number check
validates against the user's answers (not only the original resume):

```yaml
- id: <roleprefix>-<short-topic>
  source: user            # or: resume
  evidence: >
    answer YYYY-MM-DD: <the facts exactly as the user stated them>
  text: "<the bullet>"
```

Then tell the user three things briefly: what each number answers in an interview, the
likely follow-up question (e.g. "what broke at 50?"), and which JDs the bullet suits (the
selector decides per JD; the bank can hold more bullets than any resume shows).

### Output format for bullet requests

For each bullet: the bullet in a quote block, then one line on why it is built that way if
it is not obvious. After all bullets: open conflicts or questions (one question at a time
when possible), then the bank entries in one YAML block.

---

## When reviewing a whole resume

Read `references/gaps-and-rejection-risks.md` and walk its checklist in order (parsing →
recruiter scan → hiring manager → self-inflicted). Rank findings by how likely each is to
cost a shortlist. Separate what the engine can fix (skills trimming, template, spelling,
summary variant) from what needs new facts from the user (scale, outcomes, ownership), and
end with the fact-gathering questions.

For the candidate's own earlier review, look in `profile/reviews/` if it exists. It is
private: read it only with local tools or local models, never copy it into this skill,
code, tests, or logs.

## When tailoring a resume (review-aware)

Before tailoring or reviewing any record, load every file in `profile/reviews/` (locally)
and treat its findings as known weaknesses: the tailored record must address them where
the engine can (skills trimmed to evidence, must-have evidence first, summary variant,
spelling, length), must not repeat them, and must list which findings stay open. Findings
that need new facts become questions for the user from `references/bullet-writing.md`;
never fill them with invented content. Details: `references/decisions.md`
("Review-aware tailoring") and `references/engine-algorithm.md` §4.

---

## Reference files

- `references/decisions.md`: every decision agreed so far, in one place. Read first.
- `references/bullet-writing.md`: question bank, before/after patterns, number
  reconciliation, framing for no-gain work. Read when writing bullets.
- `references/gaps-and-rejection-risks.md`: rejection risks by stage, resume lint checks,
  common disqualifiers. Read when reviewing a resume or record.
- `references/engine-algorithm.md`: matching, scoring, equivalence, decision, guard,
  records, tests, calibration, build order. Read for any engine or scoring work.
- `scripts/check_bullets.py`: deterministic checks for drafted bullets.
