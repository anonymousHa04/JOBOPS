import { norm } from "../scoring/terms.ts";
import type { ResumeContent } from "./ideal.ts";

// Content equivalence between the ideal content for a JD and an existing record
// (engine-algorithm.md §5): how much of the record can be reused unchanged.
//   bullet, same id and same text         1.0
//   bullet, same id, only alias -> JD term 0.9
//   bullet, same id, reworded             0.5
//   bullet on only one side               0
//   summary identical                     1 unit
//   skills                                1 unit x Jaccard
//   equivalence = 100 x matched / (bullet union + 2)
// Note: the spec's worked examples (one rewording ~96.7%, one swap 87.5%) match a
// denominator of union + 1 (no skills unit); the formula as written is implemented here
// and the difference is reported to the user. Decisions come out the same.

export const UNIT = { same: 1, alias: 0.9, reworded: 0.5 } as const;

export function jaccard(a: string[], b: string[]): number {
  const x = new Set(a.map(norm));
  const y = new Set(b.map(norm));
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const v of x) if (y.has(v)) inter++;
  return inter / (x.size + y.size - inter);
}

// `ideal` bullets carry their own reword marks: a shared bullet whose text equals the
// record's but is marked alias-only counts 0.9; marked for a full rewording, 0.5.
export function equivalence(ideal: ResumeContent, record: ResumeContent): { value: number; detail: Record<string, number> } {
  const rec = new Map(record.bullets.map((b) => [b.id, b.text]));
  const ids = new Set([...ideal.bullets.map((b) => b.id), ...record.bullets.map((b) => b.id)]);
  let matched = 0;
  const detail = { same: 0, alias: 0, reworded: 0, one_side: 0, summary: 0, skills: 0 };
  for (const b of ideal.bullets) {
    const old = rec.get(b.id);
    if (old === undefined) continue;
    if (b.text !== old) { matched += UNIT.reworded; detail.reworded++; }
    else if (b.reword?.alias_only) { matched += UNIT.alias; detail.alias++; }
    else if (b.reword) { matched += UNIT.reworded; detail.reworded++; }
    else { matched += UNIT.same; detail.same++; }
  }
  detail.one_side = ids.size - (detail.same + detail.alias + detail.reworded);
  if (ideal.summary_variant === record.summary_variant && ideal.summary_text === record.summary_text) {
    matched += 1;
    detail.summary = 1;
  }
  detail.skills = Math.round(jaccard(ideal.skills, record.skills) * 1000) / 1000;
  matched += detail.skills;
  return { value: Math.round((100 * matched / (ids.size + 2)) * 10) / 10, detail };
}
