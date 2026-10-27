# Engine Algorithm

Contents: 1. Resume model · 2. Matching (index + LLM) · 3. Scoring · 4. Selection and
decision · 5. Content equivalence · 6. Rewrite guard · 7. Records · 8. Tests ·
9. Calibration · 10. Work split and build order

Stack context: TypeScript API (`api/src/`), Zod schemas, SQLite, local llama.cpp models
(7B for JD parsing and rewording, 14B for bank build), Go job search.

---

## 1. Resume model

| Block | Contents | Scored | Changed per JD |
|---|---|---|---|
| Static | Contact, total years, education, certifications, achievements, profiles | No | No |
| Dynamic | Summary variant, skills section, experience bullets | Yes | Yes |

Titles, employers and dates sit in the experience section but are fixed: never changed.
Years of experience is the only hard gate.

Bank entries carry `source: resume | user` and `evidence`. The number check validates
`source: user` bullets against the stored answer, not the original resume (a number can
appear in the resume by coincidence).

---

## 2. Matching: inverted index first, LLM second

1. Canonicalize terms via the synonym map (`k8s`, `EKS` → `kubernetes`).
2. Index `term → [(bullet_id, field)]` over: bullet text, tags, `skills-extra` have,
   qualifiers (`production`, `led`, `at scale`). In-memory `Map` is enough.
3. Second index `term → [job_id]` to find jobs that share must-haves (record reuse).
4. Hashes: bullet text (label cache), `requirement text + prompt version` (LLM cache key),
   record content and bank hash (records).

| Situation | Label source |
|---|---|
| Term in bullet text, no qualifier on the requirement | Index → `supported` |
| Term only in skills field | Index → `skill_list_only` |
| Requirement has a qualifier | LLM judge on index candidates |
| Index finds nothing | LLM judge on top bullets — never auto `not_demonstrated` |

Measure: label source per requirement; index miss rate on the golden set → synonym additions.

---

## 3. Scoring

Credit per requirement = best bullet's label credit × recency.

| Label | Credit |
|---|---|
| `supported_metric` | 0.9 |
| `supported` | 0.85 |
| `partial` | 0.5 |
| `skill_list_only` | 0.3 |
| `learnable`, `not_demonstrated`, `unknown` | 0 |

Recency: current or ended ≤ 12 months 1.0; 12–36 months 0.9; older 0.75.

```
must     = 55 × avg credit (must-haves)
resp     = 15 × avg credit (themes)
nice     = 10 × avg credit (nice-to-haves)
keywords = 20 × weighted literal hits / total weight   (must-have keywords weight 2)
score    = must + resp + nice + keywords
```

- Keywords: literal, case-insensitive, word boundaries, counted once; no synonyms.
- Empty part: points redistributed proportionally.
- Must-have missing = credit < 0.5. One missing → cap 84.9. Two or more → cap 74.9.
- Bands: excellent ≥ 95, strong 85–95, moderate 75–85, poor 60–75, very poor < 60.
- Tailorable = years gate passes and band ≥ moderate.
- Same formula on the bank/ideal set (tailorability) and on a record (start selection;
  reuses bank labels filtered to the record's ids, no model calls).
- All values in config; they are starting points to calibrate.

```ts
const CREDIT = { supported_metric: 0.9, supported: 0.85, partial: 0.5,
  skill_list_only: 0.3, learnable: 0, not_demonstrated: 0, unknown: 0 } as const;
const PARTS = { must: 55, resp: 15, nice: 10, keywords: 20 };
const recency = (m: number) => (m <= 12 ? 1 : m <= 36 ? 0.9 : 0.75);
```

---

## 4. Selection and decision

1. Score existing records; pick the best starting record.
2. Build the ideal set in code, deterministically (tie-break: score, recency, id):
   must-have evidence first, then themes, then impact; budget per role; every listed role
   keeps at least one bullet; at most 2 metric-led bullets per role.
3. Ideal set is relative to the starting record: reuse the record's wording for shared ids;
   mark for rewording only when a supported JD keyword is missing literally.
4. Skills: supported JD keywords in JD order, then remaining existing skills.
5. Decision:
   - years gate fails, or ideal band poor/very poor → `not_tailored`
   - equivalence ≥ 95 → `reuse`
   - else → `adapt`
   - flags (unsupported must-haves, risks) on every decision
6. Risk gate right after the decision, before rewording (`--force` overrides).
7. `tailor --all --dry-run`: decision table + all risk questions, no rewording.
8. Same company: prefer one record across roles; warn above 3 applications.
9. Review-aware: before step 2, load `profile/reviews/*` (local only). Map each finding to
   an engine action (trim skills, reorder must-have evidence, pick summary variant, fix
   spelling, compress old roles) or to a user question when it needs new facts. The record
   stores `review_findings: [{id, status: addressed|open|needs_facts}]` (ids and statuses
   only, never the review text), and `tailor` reports the open ones.

---

## 5. Content equivalence

| Unit | Value |
|---|---|
| Same id, same text | 1.0 |
| Same id, only alias → JD term | 0.9 |
| Same id, reworded | 0.5 |
| Only on one side | 0 |
| Summary identical | 1 unit |
| Skills | 1 unit × Jaccard |

`equivalence = 100 × matched / (bullet union + 2)`. At 14 bullets + summary: one rewording
≈ 96.7% (reuse), two ≈ 93.3% (adapt), one swap ≈ 87.5% (adapt). 95% means at most one light
rewording and no swaps.

---

## 6. Rewrite guard

Prompt 3 on the 7B model, one bullet per call, low temperature, allowed terms passed in.
Prompt also says: keep numbers only where the source has them; never lead with a number.

| Code | Rule |
|---|---|
| `number_added` | Every number in the rewrite is in the source |
| `term_added` | Every canonical skill/tool is in the source |
| `scope_raised` | Verb not higher on the ladder than the source's |
| `scope_phrase_added` | No new "team of N", "company-wide", "end-to-end", "single-handedly" |
| `too_long` | Within 25 words |
| `fixed_field_changed` | Titles, employers, dates byte-match the bank |

Fail → retry once with codes → fall back to bank text. Never loop. Codes only in logs.

---

## 7. Records

- One YAML per JD in `profile/records/` (git-ignored), never overwritten; original resume
  is the first record.
- YAML = content source of truth. SQLite `resume_records` = index (path, content hash,
  bank hash, scores, decision, flags, engine version).
- ATS template + parse-back test on every generated PDF.

---

## 8. Tests (fake resume only)

1. Identical ideal set → `reuse`; new record written; content byte-matches source.
2. One swapped bullet → `adapt` at 87.5%.
3. Years gate fails → `not_tailored`; zero rewording calls.
4. Unsupported must-have flagged on `reuse`.
5. Rewrite adding a number or tool → rejected; bank text used.

Invariants: source record hash unchanged after `tailor`; same inputs → same ideal set.

---

## 9. Calibration

1. Build and approve the real bank (including `source: user` bullets).
2. Score all matched jobs under old (60/20/20) and new algorithms; compare band histograms.
3. Compare original resume vs. updated bank on the same jobs: the difference shows how much
   of the shortlist problem was missing evidence.
4. After real applications, compare bands with screening outcomes; adjust config.

---

## 10. Work split and build order

Manager: `ideal.ts`, `equivalence.ts`, `decide.ts`, `guard.ts`, scoring, and their tests.
Local coders: `tailor` CLI, MCP tool, YAML writer, prompt-3 wiring, lint.

Order: scoring + index → ideal/equivalence/decide + tests → records + hash test → guard +
fixed-field check → rewording → `tailor` and dry run → template + parse-back → lint,
tenure/gap, same-company warning → MCP tool.
