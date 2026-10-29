// One local fix round of the report loop (plan-report-loop.md): re-tailor the job with the
// chat's missed requirements as focus and its bullet notes as rewording advice, then say what
// changed. The guard in tailor/guard.ts still decides every rewording; nothing is invented here.
import type { Db } from "../db.ts";
import { tailor } from "../tools.ts";
import { gaps, latestRecord } from "./reports.ts";
import type { Report } from "./reports.ts";

export type FixResult = {
  round: number;
  changed: boolean;
  resume_id: string | null;
  added: string[];
  removed: string[];
  reworded: string[];
  needs_facts: string[]; // focus requirements still not shown: they need the user's facts
  error: string | null;
};

export async function fixRound(db: Db, jobId: string, round: number, report: Report): Promise<FixResult> {
  const before = latestRecord(db, jobId);
  const focus = [
    ...(report.missed_gaps ?? []).map((g) => g.requirement),
    ...report.gaps.filter((g) => g.advice === "frame").map((g) => g.gap)
  ];
  const notes = report.bullet_notes ?? [];
  const none = { round, changed: false, resume_id: before?.resume_id ?? null, added: [], removed: [], reworded: [], needs_facts: [] };

  try {
    await tailor(db, jobId, { force: true, focus, notes });
  } catch (err) {
    return { ...none, error: err instanceof Error ? err.message : String(err) };
  }

  const after = latestRecord(db, jobId);
  const was = new Map((before?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const now = new Map((after?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const added = [...now.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !now.has(id));
  const reworded = [...now].filter(([id, text]) => was.has(id) && was.get(id) !== text).map(([id]) => id);

  const g = gaps(db, jobId, after);
  const open = new Set([...g.must, ...g.nice].map((r) => r.toLowerCase()));
  const needs_facts = focus.filter((r) => open.has(r.toLowerCase()));

  return { round, changed: added.length + removed.length + reworded.length > 0, resume_id: after?.resume_id ?? null,
    added, removed, reworded, needs_facts, error: null };
}
