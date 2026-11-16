# Bullet Writing Reference

Contents: 1. Question bank · 2. Number reconciliation · 3. Before/after patterns ·
4. Framing work with no measurable gain · 5. Per-role budget · 6. Interview defensibility

All examples use placeholders or generic systems. Real bullets live in `profile/`.

---

## 1. Question bank

Ask only what the bullet needs. One topic per question.

**Scale**
- How many users, engineers, teams, or customers used it?
- How many services, functions, pipelines, or records were involved?
- What was the peak load (concurrent users, requests per second, events per day)?

**Production vs. test**
- What was the highest load seen in production?
- What load did you test to, and what broke beyond it?
- What load was the system designed for?

**Result**
- What changed because of the work (memory, latency, cost, errors, wait time, support load)?
- Roughly by how much? Is that measured or estimated?
- If nothing measurable changed, why was the work done (policy, compliance, enabling later work)?

**Ownership**
- Did you lead the design, build parts, or both? Which parts?
- How large was the team? Who made the final decision?

**Constraint / cross-team**
- What did you have to keep working while changing it (data, security, other teams)?
- How many other teams depended on it?

**Reliability**
- Has the fallback or monitoring ever taken over during a real failure? What happened?

**People**
- Do you review PRs, mentor, onboard, or run design reviews in this role?

---

## 2. Number reconciliation

Users give numbers from memory, and they often measure different things. Before drafting:

1. List every number the user gave for one system.
2. Label each: scale, production, test, design target, or result.
3. Check they are consistent. Members can exceed concurrent users; production load should
   be at or below tested load; tested load relates to the design target.
4. If two numbers claim the same thing and disagree, name it and ask one question.

Worked pattern (generic):

| User said | Label |
|---|---|
| Up to 100 teams × 4–5 engineers per project | Scale (members, ~450) |
| Max 30 concurrent edits seen | Production |
| ~100 concurrent edits in load tests | Test |
| Designed for at most 40 engineers | Design target |
| Load test gave up at 50 agents | Test limit (agents ≠ edits; keep the story consistent) |

Resulting bullet shape: "Led design of real-time collaboration for projects of up to
[members] engineers; handled [prod] concurrent edits in production and [test] in load tests."

Never write "[members] concurrent users" when the system was tested to far fewer.

---

## 3. Before/after patterns

**Task → decision with constraint**
- Before: "Built the backend using Node.js and Go."
- After: "Split the backend between Node.js and Go, moving concurrent [X] work to Go; cut
  memory use by [N]% and ended [user-visible wait]."

**Vague capability → what it does**
- Before: "Integrated AI agents that analyze components and suggest corrections."
- After: "Integrated AI agents that review designs before submission, flagging [issue],
  checking against [goal], and running [check], queued via [infra]."

**Hidden ownership → stated ownership (only if true)**
- Before: "Moved the product to multi-user collaboration."
- After: "Led design of the move to multi-user collaboration for [scale]."

**Seniority in the wrong role**
- Mentoring listed two roles back but also done now → add it to the current role.

**Skills list claim → bullet evidence**
- A skill listed but shown in no bullet is weak (scores as `skill_list_only`). Either add a
  bullet that shows it (from real work) or let the engine drop it for JDs that don't need it.

---

## 4. Framing work with no measurable gain

Policy-driven, compliance, or migration work still counts. State scope and reason, never an
invented benefit.

- Good: "Built the pipeline that migrated [N] [source] functions and their data to
  [target], moving the platform onto [org]'s [policy] architecture."
- Bad: "...improving performance by 30%" (no such gain happened).

Interview answer to "why?": the policy. The engineering story is the cutover and data
transfer, so be ready to explain those.

---

## 5. Per-role budget

Defaults from `preferences.yaml`: 4 bullets per role, 14 total, 25 words per bullet.
Recommended adjustment: current role 5–6, oldest roles 1–2 each, total unchanged. Recruiters
read the top third; put the space there. The bank should hold more bullets than any one
resume shows; the selector picks per JD.

---

## 6. Interview defensibility check

For each bullet, the candidate should be able to answer:
- What exactly did you do, and what did others do?
- How was each number measured?
- What would you do differently?
- For test numbers: what broke beyond the tested load?

If any answer is "I don't know", soften or drop that part of the bullet.
