import type { Bank, SkillsExtra } from "../profile/schema.ts";
import type { Requirements } from "../requirements/schema.ts";
import { REUSE_EQUIVALENCE } from "../scoring/config.ts";
import type { Band } from "../scoring/config.ts";
import type { Risk } from "../scoring/risk.ts";
import { scoreRequirements, yearsAsked } from "../scoring/score.ts";
import type { ScoreResult, Verdicts } from "../scoring/score.ts";
import { equivalence } from "./equivalence.ts";
import type { ResumeContent } from "./ideal.ts";

// Starting record and decision (engine-algorithm.md §4 steps 1, 5, 6).

export type StoredRecord = { resume_id: string; content: ResumeContent };

// Step 1: score every existing record on its own bullets (cached verdicts, no model
// calls) and start from the best one; ties go to the record listed first.
export function pickStart(
  records: StoredRecord[],
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  opts: { jobId?: string; verdicts?: Verdicts } = {}
): { record: StoredRecord; score: ScoreResult } | null {
  let best: { record: StoredRecord; score: ScoreResult } | null = null;
  for (const record of records) {
    const ids = record.content.bullets.map((b) => b.id);
    const score = scoreRequirements(req, bank, extra, ids, opts.jobId, opts.verdicts);
    if (!best || score.score > best.score.score) best = { record, score };
  }
  return best;
}

export type Decision = {
  decision: "reuse" | "adapt" | "not_tailored";
  reason: string;
  band: Band;
  score: number;
  equivalence: number | null;
  flags: { unsupported_must_haves: string[]; risks: string[] };
  // Step 6: open risk questions stop the engine before any rewording (Option A).
  risk_gate: { open: string[]; blocked: boolean };
};

// Step 5 and 6. The gate and the score are the job's (whole bank); `ideal` gives the page and
// the unsupported-must-have flags; equivalence is against the starting record (null when there
// is none).
export function decide(
  ideal: ResumeContent,
  start: StoredRecord | null,
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  risks: Risk[],
  opts: { jobId?: string; verdicts?: Verdicts; force?: boolean; startBlocked?: string[] } = {}
): Decision {
  // One score (user, 2026-11-05): the job's, from the whole bank, as on the Score tab. It gates
  // tailoring and is the record's score. The ideal set only decides what goes on the page; its
  // own items still flag must-haves the page does not show.
  const s = scoreRequirements(req, bank, extra, undefined, opts.jobId, opts.verdicts);
  const page = scoreRequirements(req, bank, extra, ideal.bullets.map((b) => b.id), opts.jobId, opts.verdicts);
  const unsupported = page.items
    .filter((i) => i.kind === "must" && i.credit < 0.5 && i.label !== "learnable" && yearsAsked(i.requirement) === 0)
    .map((i) => i.requirement);
  const flags = { unsupported_must_haves: unsupported, risks: risks.map((r) => r.id) };
  const eq = start ? equivalence(ideal, start.content).value : null;
  const gate = (blocked: boolean) => ({ open: flags.risks, blocked });

  if (!s.hard.pass) {
    return { decision: "not_tailored", reason: `years: JD asks ${s.hard.years_asked}+, roles add up to ${s.hard.years_have}`,
      band: s.band, score: s.score, equivalence: eq, flags, risk_gate: gate(false) };
  }
  if (s.band === "poor" || s.band === "very_poor") {
    return { decision: "not_tailored", reason: `band ${s.band} (score ${s.score})`,
      band: s.band, score: s.score, equivalence: eq, flags, risk_gate: gate(false) };
  }
  // A start holding a bullet the render gate refuses is not reused as is: the ideal (without
  // that bullet) is adapted instead.
  const startBlocked = opts.startBlocked ?? [];
  const reuse = eq !== null && eq >= REUSE_EQUIVALENCE && startBlocked.length === 0;
  const blocked = flags.risks.length > 0 && !opts.force && !reuse;
  return {
    decision: reuse ? "reuse" : "adapt",
    reason: reuse ? `equivalence ${eq} >= ${REUSE_EQUIVALENCE}` : eq === null ? "no starting record"
      : startBlocked.length ? `starting record has bullets the bank gate refuses: ${startBlocked.join(", ")}` : `equivalence ${eq} < ${REUSE_EQUIVALENCE}`,
    band: s.band, score: s.score, equivalence: eq, flags,
    // Reuse rewrites nothing, so it never waits on questions; flags still travel with it.
    risk_gate: gate(blocked)
  };
}
