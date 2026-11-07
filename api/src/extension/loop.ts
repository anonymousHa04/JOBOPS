// One local fix round of the report loop (plan-report-loop.md): re-tailor the job with the
// chat's missed requirements as focus and its bullet notes as rewording advice, then say what
// changed. The guard in tailor/guard.ts still decides every rewording; nothing is invented here.
import type { Db } from "../db.ts";
import { tailor } from "../tools.ts";
import { gaps, latestRecord } from "./reports.ts";
import type { Report } from "./reports.ts";
import { reviewReport } from "./review.ts";
import { makeCurrent } from "./rounds.ts";

export type FixResult = {
  round: number;
  changed: boolean;
  resume_id: string | null;
  added: string[];
  removed: string[];
  reworded: string[];
  needs_facts: string[];
  error: string | null;
  review: {
    valid: number;
    wrong: number;
    unclear: number;
    causes: Record<string, number>;
  };
};

export async function fixRound(db: Db, jobId: string, round: number, report: Report, retailor: typeof tailor = tailor): Promise<FixResult> {
  const before = latestRecord(db, jobId);
  const findings = reviewReport(db, jobId, round, report);

  const validFindings = findings.filter(f => f.verdict === "valid");
  const focus = validFindings
    .filter(f => f.kind === "missed_gap")
    .map(f => f.item);
  const notes = validFindings
    .filter(f => f.kind === "bullet_note")
    .map(f => ({ bullet_id: f.item, note: "" }));

  const none = {
    round,
    changed: false,
    resume_id: before?.resume_id ?? null,
    added: [],
    removed: [],
    reworded: [],
    needs_facts: [],
    review: {
      valid: validFindings.filter(f => f.verdict === "valid").length,
      wrong: findings.filter(f => f.verdict === "wrong").length,
      unclear: findings.filter(f => f.verdict === "unclear").length,
      causes: findings.reduce((acc, f) => {
        acc[f.cause] = (acc[f.cause] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    }
  };

  let made: string | null = null;
  try {
    const t = await retailor(db, jobId, { force: true, focus, notes }) as { resume_id?: string | null } | undefined;
    made = t?.resume_id ?? null;
  } catch (err) {
    return { ...none, error: err instanceof Error ? err.message : String(err) };
  }
  // The resume this round made. Content equal to an older record comes back as that record
  // (created: false) without becoming the newest, so the newest record would still be the one
  // before the round, and a real change looked like none (2026-11-07). Make it current.
  if (made && latestRecord(db, jobId)?.resume_id !== made) makeCurrent(db, made);

  const after = latestRecord(db, jobId);
  const was = new Map((before?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const now = new Map((after?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const added = [...now.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !now.has(id));
  const reworded = [...now].filter(([id, text]) => was.has(id) && was.get(id) !== text).map(([id]) => id);

  const g = gaps(db, jobId, after);
  const open = new Set([...g.must, ...g.nice].map((r) => r.toLowerCase()));
  const needs_facts = focus.filter((r) => open.has(r.toLowerCase()));

  return {
    round,
    changed: added.length + removed.length + reworded.length > 0,
    resume_id: after?.resume_id ?? null,
    added,
    removed,
    reworded,
    needs_facts,
    error: null,
    review: none.review
  };
}
