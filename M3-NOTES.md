# Milestone 3 notes: engine decisions and local-agent findings

Branch: `milestone-3-requirements`. Last updated 2026-10-26.

Two topics:

1. The resume selection engine: which questions the design doc answers, the
   user's answers for the rest, conflicts, and open follow-ups.
2. Local coding agents: what went wrong in Milestone 3, why, and how to fix it.

## Status (2026-10-26)

Built by Claude, uncommitted (user asked to hold commits until the engine work):

- Scoring with the user's five bands and years of experience as the only hard
  constraint (`api/src/scoring/config.ts`, `score.ts`); `tailorable` = hard
  constraint passes and band is excellent, strong, or moderate.
- Learnable-skill answers recorded per JD; earlier answers for the same skill
  are shown when it is asked again (`skills-extra.yaml` → `learnable`).
- Risk check uses those answers; a years shortfall is marked "not tailorable".
- CLI `node api/src/cli.ts` (bank, skill, bullet, learnable, risk, jobs, jd,
  score) and MCP server `jobops-tools` (9 tools), sharing `api/src/tools.ts`.
- `.mcp.json` registers `jobops-tools` and `jd-search` (load on restart).

Next: the engine (selection, content equivalence, rewrite check, records,
tailoring), in the design-doc session.

---

> **2026-10-27: the engine spec is now the `m3-notes` skill**
> (`.agents/skills/m3-notes/references/engine-algorithm.md`). Where it differs from
> the decisions below (scoring weights and caps, labels, decision rule, guard codes,
> record location, equivalence formula), the skill wins. The decisions below stay as
> the history of how they were reached.

## 1. Resume selection engine: decisions

Design source: `requierements/jobops_resume_selection_generation_engine.md` <!-- requierements/jobops_resume_selection_generation_engine.md -->.
Plan tasks: m3-11 (select), m3-12 (guard), m3-13 (records), m3-14 (engine).

### Answered by the design doc

| # | Question | Doc says | Decision |
|---|---|---|---|
| 1 | Reuse threshold | "Strong fit and content equivalence ≥95% → reuse" | 95%, in config, treated as an initial rule |
| 2 | Skip very poor fits? | "Poor fit → assemble a new variant"; every JD gets a record | **Overridden by the user's answer 1b below:** only excellent, strong, and moderate JDs get a tailored resume; poor and very poor are not tailored (the JD still gets a record) |
| 4 | Starting resume | Assumes existing resumes to rank | The original resume becomes record `original` (all bullets, bank order) |
| 5 | Re-running the same JD | Source never modified; each JD record keeps its own history | New record each run, never overwritten, linked by `source_resume_id` |
| 11 | Which records to compare | "Retrieve existing resumes; rank by role fit and coverage" | All records |

### Not covered by the doc: user's answers (2026-10-26)

All thresholds live in config and can change later.

| # | Question | User's answer |
|---|---|---|
| 1b | Fit bands | Five bands: **excellent** ≥ 95, **strong** 85–95, **moderate** 75–85, **poor** 60–75, **very poor** < 60. Only excellent, strong, and moderate qualify for a tailored resume. |
| 3 | Hard constraints vs learnable skills | Constraints that can't be changed (e.g. years of experience) get high weight and are never tailored around. Only strong and moderate fits are tailored. For moderate fits, a gap in a skill that can be learned (e.g. LangChain, under agentic skills) can be considered, so moderate JDs still have a chance. |
| 6 | May "adapt" reword bullets? | Same rule as 3: reword only for strong and moderate fits; never reword around a hard constraint. The code check still rejects any rewrite that adds a skill, tool, number, or scope the source bullet lacks. |
| 7 | Model for rewording | **Local `qwen2.5:7b`** (changed 2026-10-26 from Claude). **FLAGGED:** temporary; the user has found a better option to switch to later. |
| 8 | Summary | Default: pick the best bank summary variant as written; no rewording. |
| 9 | Sections | Default: education always included; projects count toward the 14-bullet budget; skills reordered JD-first, nothing added beyond the bank and user-confirmed extra skills. **Never change section titles.** |
| 10 | Risk questions | **Option A**: the engine stops, returns the questions, and writes no resume until the user answers or runs `tailor <job> --force`. Same rule as 3: an unmet hard constraint is not tailorable; a learnable-skill gap in a moderate fit becomes a question, not a blocker. |

### How the answers fit together

    fit score → band
      excellent (≥95)  → reuse if content equivalence ≥ 95%, otherwise adapt
      strong (85–95)   → adapt
      moderate (75–85) → adapt; learnable-skill gaps allowed (asked, not blocking)
      poor (60–75)     → no tailored resume; record kept with the reason
      very poor (<60)  → no tailored resume; record kept with the reason
    any unmet hard constraint → no tailoring, flagged, regardless of band
    any open risk question    → engine stops and asks (Option A); --force overrides

### Conflicts (resolved 2026-10-26)

1. **#7 (Claude for rewording) vs the privacy rules.** README ("Model roles":
   all models run locally so resumes stay on the machine), STATUS.md, and
   AGENTS.md ("local models only; never a cloud model") all say resume content
   must not go to a cloud model. Rewording with Claude sends bullet text to
   Anthropic's API. Options:
   - (a) Accept it for rewording only, and update README/AGENTS.md to say so
     (bullets and JD requirements are sent; contact data and the full resume
     file are not).
   - (b) Keep rewording local (`qwen2.5:14b`) and use Claude only for
     non-resume steps.
   - (c) Claude rewords only after the user approves each call.

   **Decision: (b), local.** First chosen as (a), then changed the same day:
   rewording uses local `qwen2.5:7b`, so no resume content leaves the machine.
   **FLAGGED:** the rewording model will be replaced by an option the user has
   found. README "Model roles" carries the same flag.
2. **1b vs the design doc.** The doc says a poor fit should get an assembled
   resume; the user's bands say poor and very poor get none. Following the
   user. The record for such a JD will say `decision: not_tailored` with the
   band and the reason.
3. **Scoring weights.** The current score is 60 must-have / 20 nice-to-have /
   20 keywords and has no hard-constraint weight. The answers need a hard-
   constraint check first (pass/fail), then the band from the score. The bands
   are higher than the old defaults (75/50), so the weighting may need tuning
   on real JDs.

   **Decision: agreed.** Hard-constraint check first (pass/fail), then the band
   from the score; weights tuned on real JDs.

### Follow-ups (answered 2026-10-26)

| # | Question | Answer |
|---|---|---|
| 1 | Hard constraints | **Only years of experience.** Location, degree, and the rest are scored normally. |
| 2 | Learnable skills | **Ask each time.** Record every answer (skill, learnable yes/no, which JD) so the same question isn't asked again for another resume or JD. |
| 3 | Excellent band | **Fit score ≥ 95.** Reuse when content equivalence is also ≥ 95%, otherwise adapt. |
| 4 | Content equivalence formula | **Deferred:** to be defined while working on the engine design doc. |

### Flagged

- **Rewording model.** Local `qwen2.5:7b` for now; to be replaced by the
  option the user found.
- **Content equivalence formula.** Not defined yet; part of the engine work.

---

## 2. Local coding agents: findings

Setup: `qwen2.5-coder:14b` on Ollama (8k context, 16 GB Mac), aider for new
files, mini-swe-agent for edits and fix rounds, `check.sh` (typecheck + tests)
as the gate.

### What happened

| Task | Runner | Result | What went wrong |
|---|---|---|---|
| m3-01 profile schema | aider | Passed check, wrong | Schemas not exported (only types) |
| m3-02 requirements schema | aider + mini | Escalated | `.transform().min()` (Zod v4); fix round timed out |
| m3-03 model provider | aider + mini | Escalated | Imported uninstalled `abort-controller`; `schema.toJSONSchema()`; no `JSON.parse`; `unknown` errors; fix round timed out |
| m3-04 prompts | aider | Passed check, wrong | Read `requirements/*.txt` (real: `requierements/*.md`); `fill` threw on any bracket, breaking prompt 3 |
| m3-05 bank | aider + mini | Escalated | No `.ts` in imports, types never imported, invented fields (`b.entries`, `b.skills[i].name`); fix round stuck on shell quoting |
| m3-07 db tables | mini | Escalated | SQL syntax error (partly a SQL comment in the spec) |
| m3-08 JD parse | aider + lint loop | Stopped by user | Lint loop worked (errors and hints fed back), but row and JSON types were still guessed |

Of 7 tasks, none was right on the first try: 2 passed the check while wrong,
4 escalated to the manager, and 1 was stopped. Every mini-swe-agent fix round
used its full 20 minutes without converging.

### Why they don't get it right the first time

1. **They can't see what they depend on.** The coder gets the spec and the
   file it writes. It never sees `schema.ts`, `db.ts`, or the modules it
   imports, so it guesses their shapes. Most bugs were made-up interfaces, not
   bad logic.
2. **Training habits beat the instructions.** The model writes the most common
   Node/TS it was trained on: `import * as fs from 'fs'`, imports without
   `.ts`, Zod v3 calls, npm packages for things Node 24 has built in.
3. **The context is too small.** In 8k tokens it holds coder.md, the patterns,
   the spec, and then the whole file it writes. With a 7-function spec, the
   details near the end get dropped ("export these", "check `short`, not `text`").
4. **The specs were written for a stronger reader.** Compact prose left
   requirements implied (export everything named, replace only given keys,
   exact folder). The 14B model takes the gist and fills the gaps with
   plausible guesses.
5. **There was no feedback before hand-off.** Before the lint loop, aider wrote
   once and stopped without compiling. Fix rounds ran in mini-swe-agent, which
   edits through shell commands and loops on quoting.
6. **"It compiles" was the only gate.** With no contract or smoke check,
   wrong-but-valid code was committed (m3-01, m3-04).

In short: the models write function bodies well, but they guess interfaces.

### Already in place (uncommitted tooling)

| Fix | Files | Addresses |
|---|---|---|
| Patterns file: Zod v4, Node 24 built-ins, allowed packages, `.ts` imports, `unknown` handling, a pre-finish checklist | `.claude/agents/coder-patterns.md` | 2, 4 |
| API map: one line per export in `api/src`, rebuilt before each task | `.claude/bin/api-map.sh` | 1 (names only, not shapes) |
| aider lint loop: typecheck after each edit; errors and hints sent back to the model | `.claude/bin/tsc-lint.sh`, `run-coder.sh` | 5 |
| Fix hints: error pattern → fix; shown to aider, mini, and in check reports | `.claude/agents/fix-hints.yaml`, `.claude/bin/hints.sh` | 2, 4, 5 |
| No automatic fix rounds (`MAX_FIXES=0`): a failure goes to the manager at once | `.claude/bin/autofix.sh` | 5 |
| coder.md no longer tells the coder to write tests | `.claude/agents/coder.md` | 3 |

### Proposed next (not built yet)

| # | Fix | How | Addresses |
|---|---|---|---|
| 1 | **Skeleton first** | The manager writes each new file with imports, exported signatures, and types, plus `throw new Error("TODO")` bodies; the coder only fills the bodies. Interfaces can't drift. | 1, 2, 3, 4 |
| 2 | **Dependency files in context** | A `reads:` line per plan task (e.g. `reads: api/src/profile/schema.ts`), passed to aider as `--read`. The coder sees real types instead of guessing. | 1 |
| 3 | **Contract check** | An `exports:` line per task, checked by `check.sh`; an optional `verify:` one-liner (`node -e ...`) as a smoke test. | 6 |
| 4 | **Fix rounds via aider** | `FIX_RUNNER=aider`, `MAX_FIXES=1`, with the check report and hints as the message. mini-swe-agent only for multi-file edits. | 5 |
| 5 | **Smaller tasks** | At most 2–3 functions or about 80 lines per task. | 3 |
| 6 | **Spec hygiene** | No code fences, no SQL comments, exact paths with extensions, and a "do not" line for known traps. | 4 |
| 7 | **Model** (last resort) | `qwen2.5-coder:14b` at 8k is the ceiling on 16 GB; smaller tasks help more than a bigger model. Revisit only if 1–6 aren't enough. | 3 |

Expected effect: fixes 1–3 remove most first-try failures, because the
interface comes from the manager and the coder writes only logic it can see
the types for.
