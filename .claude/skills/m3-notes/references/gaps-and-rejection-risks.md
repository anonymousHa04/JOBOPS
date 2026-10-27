# Gaps and Rejection Risks

Contents: 1. How screening works · 2. Risks by stage · 3. Resume lint checklist ·
4. Common disqualifiers for senior roles · 5. Engine-fixable vs. needs facts · 6. Out of scope

---

## 1. How screening works

Three readers, in order:

1. **ATS**: parses the file into fields and lets recruiters search with filters. It rarely
   auto-rejects; resumes that don't match the searches are simply never seen.
2. **Recruiter**: 5–15 seconds. Looks at company names, current title, years, the top third
   of the page, and the one or two signals the hiring manager asked for.
3. **Hiring manager**: 30–60 seconds, reads bullets. Rejects vague bullets and missing level
   signals even when the recruiter passed the resume.

The top third (header, current title, first 1–3 bullets of the most recent role) does most
of the work.

---

## 2. Risks by stage

### ATS parsing
- Multi-column layouts, tables, text boxes, icons, content in headers/footers.
- Bullets merging across line or page breaks in text extraction.
- Profile links written only as labels ("LinkedIn") — URLs lost if hyperlinks are stripped.
- Inconsistent or unusual date formats (years of experience computed wrong).
- Fix: one ATS-safe template + parse-back test on every generated PDF.

### Recruiter scan
- Most recent role shows no scale or outcome while older roles do (inverted signal).
- Must-have evidence buried below other bullets or in an old role.
- Literal JD keyword missing (synonym present, exact term absent).
- Typos in company, place, or tech names.
- Short tenures (< 12 months) or gaps (> 6 months) without a ready explanation.
- Wording that mirrors the JD sentence by sentence (reads generated).

### Hiring manager
- Execution without level: no design ownership, trade-offs, cross-team impact, mentoring,
  ambiguity, or production responsibility in the current role.
- Vague capability bullets that don't say what the system does.
- Long skills list with many items shown in no bullet (interviewers probe them).
- "Planned" or in-progress work presented at senior level.

### Self-inflicted
- Different resume versions for several roles at one company (same ATS, recruiter sees all).
- Titles, employers, or dates that differ from LinkedIn.
- Claims stretched beyond what can be defended in an interview.

---

## 3. Resume lint checklist

Run on every record. Lint reports; it does not rewrite.

| Check | Flag when |
|---|---|
| Top-third strength | First 2 bullets of the most recent role are duty bullets (no scope or outcome) |
| Inverted evidence | Most recent role has fewer scale/result signals than older roles |
| Outcome structure | Bullet has no action, scope, or outcome |
| Skills evidenced | Skill appears in no bullet |
| Soft-skill lines | Self-descriptions ("communication", "leadership") with no bullet evidence |
| Length | Over one page up to ~8 years of experience |
| Planned work | "planned", "will", "working on" |
| Spelling | Place, company, or tech names not in dictionary/synonym map |
| Verb variety | More than ~40% of bullets start with the same verb |
| Metric density | More than 2 metric-led bullets in one role |
| Fixed fields | Title, employer, or date differs from the bank |
| Links | Profile entries without full URLs |
| LinkedIn | Manual: titles and dates match LinkedIn |

---

## 4. Common disqualifiers for senior roles (SDE3 / FDE / staff)

Ranked by how often they cost a shortlist:

1. Current role lacks scale and outcomes (recruiter sees nothing senior in the top third).
2. No level signals in the current role (reads mid-level).
3. A JD must-have is not demonstrated in any bullet (only in the skills list or nowhere).
4. Skills list much larger than the evidence (credibility, keyword-list impression).
5. Parsing damage (merged bullets, lost links, wrong dates).
6. Generic positioning (same summary for backend, full-stack, and FDE roles).
7. Two pages at under ~8 years, with old roles taking space.
8. Tenure pattern without a ready explanation.

Things a resume cannot change (employer brand, services vs. product background) make the
evidence carry more weight; they are not reasons to inflate it.

---

## 5. Engine-fixable vs. needs facts

| Engine can fix | Needs new facts from the user |
|---|---|
| Skills trimmed to evidenced, JD-relevant items | Scale numbers |
| Literal JD terms swapped in for synonyms | Measured results |
| Must-have evidence ordered first | Ownership (led vs. built) |
| Summary variant per role type | Level signals (design, cross-team, mentoring) |
| ATS template, parse-back, spelling, links | Work that is missing from the resume entirely |
| Length (compress oldest roles) | Explanations for tenure or gaps |

End every review with the fact-gathering questions from `bullet-writing.md`.

---

## 6. Out of scope (by decision)

- Knockout questions (notice period, CTC, location): only companies with budget for the
  target CTC are targeted.
- External factors (internal candidates, frozen roles, application volume).
