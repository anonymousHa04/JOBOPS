# JobOps — Resume Selection & Generation Engine

## 1. Final Goal

Build an intelligent resume selection and generation engine that takes a new job description (JD), evaluates the resumes already available, and decides whether to reuse an existing resume, adapt one, or generate a new variant from verified experience.

**Every incoming JD must have its own resume record**, even when its resume content is identical to an existing one. This preserves the relationship between a job application and the exact resume associated with it.

The system should maximize resume relevance to each role while minimizing unnecessary edits, duplicate work, and unsupported claims.

## 2. Problem Statement

A candidate maintains multiple resumes tailored to different job descriptions, companies, and roles. When a new JD arrives, the system must determine:

1. Which existing resume is the closest match to the new JD?
2. How well does that resume satisfy the new role's requirements?
3. Can the existing resume be reused unchanged, or does it need modifications?
4. If modifications are required, should the system adapt the closest resume or assemble a new variant from the candidate's verified experience?
5. How should the resulting resume be stored and linked to the new JD for future reference?

The challenge is that **similar job descriptions do not necessarily require the same resume**, and similar resumes do not necessarily demonstrate the same qualifications. A resume may look highly relevant semantically but still lack evidence for a critical requirement.

## 3. Core Decision Logic

1. **Input a new JD.** Extract the role, skills, responsibilities, and must-have requirements.
2. **Retrieve existing resumes.** Rank them by role fit and requirement coverage.
3. **Evaluate the best-matching resume.** Check verified evidence, must-have requirements, and content equivalence.
4. **Choose an action:**
   - **Reuse:** The resume is suitable and its content can remain materially unchanged.
   - **Adapt:** The resume is suitable but needs targeted, evidence-backed changes.
   - **Assemble a new variant:** Existing resumes are insufficient; compose a resume from verified experience.
   - **Flag gaps:** A critical requirement lacks verified supporting evidence.
5. **Create a new JD-specific resume record.** Link it to the JD and preserve the source resume, scores, and change history.

## 4. Two Separate Scores

The system must calculate two distinct scores rather than using one similarity score for every decision.

| Score | What it measures | Purpose |
|---|---|---|
| **JD suitability score** | How well an existing resume meets the new JD's requirements | Select the best starting resume |
| **Content equivalence score** | How much of the existing resume can be reused without material changes | Decide whether to reuse or modify its content |

A high JD suitability score does not automatically mean the resume should be reused unchanged.

For example, two backend roles may have very similar descriptions, but one may require production Kubernetes experience. If the existing resume does not substantiate that experience, the system must flag the gap instead of treating the resumes as interchangeable.

## 5. Initial Decision Policy

| Condition | Action |
|---|---|
| Strong JD fit and content equivalence ≥95% | Reuse content with no material changes |
| Strong JD fit but content equivalence below 95% | Adapt the closest resume |
| Moderate JD fit | Inspect requirement coverage and verified experience before deciding |
| Poor fit across existing resumes | Assemble a new variant from verified experience |
| Unsupported must-have requirement | Flag the gap regardless of the overall score |

The **95% threshold is an initial business rule**, not a universal truth. It should be validated against real JDs and resume pairs. Critical requirement gaps must override aggregate scores.

## 6. Data and Traceability Requirements

Every generated or reused resume record should preserve:

- `jd_id` — the job description it targets.
- `resume_id` — the unique JD-specific resume record.
- `source_resume_id` — the existing resume used as the starting point, if any.
- `jd_suitability_score` — the resume's fit for the target role.
- `content_equivalence_score` — the degree of material content reuse.
- `decision` — reuse, adapt, assemble, or flag gaps.
- `changes` — modifications made and the reasons for them.
- `evidence_refs` — links to verified candidate experience supporting the claims.

The source resume must remain unchanged. A new JD-specific record should reference its source and preserve its own content and change history, even when the content is identical.

## 7. Success Criteria

The engine is successful when it can:

1. Select the most suitable existing resume for a new JD.
2. Distinguish role suitability from content equivalence.
3. Avoid unnecessary resume rewrites when existing content is already suitable.
4. Identify material gaps and unsupported claims.
5. Generate tailored variants using only verified experience.
6. Maintain a traceable, independent resume record for every JD.
7. Improve its decision thresholds using outcomes from real applications.

## Guiding Principle

**Reuse the best existing evidence wherever possible, modify only what the target role justifies, and create a separate, traceable resume record for every job application.**
