// The Gaps tab (UI): requirements the experience bank does not show for a job, the cached
// explanation of each (gap-model.ts), and the user's answers. No model calls here.
import type { Db } from "../db.ts";
import { gaps } from "../extension/reports.ts";
import { addBullet, addSkill, loadBank, recordLearnable } from "../profile/bank.ts";

export type GapKind = "must" | "nice" | "keyword";
export type GapAnswer = "have" | "other_name" | "learnable" | "no";
export type GapHelp = { meaning: string; similar_terms: string[]; related: { bullet_id: string; why: string }[]; questions: string[] };
export type Gap = { kind: GapKind; requirement: string; help: GapHelp | null; answer: GapAnswer | null; outcome: string | null; updated_at: string | null };
export type AnswerInput = {
  kind: GapKind; requirement: string; answer: GapAnswer;
  entry_id?: string; text?: string; tags?: string[]; story?: string; proof?: string; same_as?: string;
};

export function gapList(db: Db, jobId: string): { gaps: Gap[]; years: string | null; entries: { id: string; title: string; company: string | null; dates: string }[] } {
  const g = gaps(db, jobId, null);
  const rows = db.prepare("SELECT requirement, kind, help, answer, outcome, updated_at FROM gap_notes WHERE job_id = ?").all(jobId) as { requirement: string; kind: string; help: string | null; answer: string | null; outcome: string | null; updated_at: string }[];
  const map = new Map(rows.map(row => [row.requirement, row]));

  const gap = (kind: GapKind) => (r: string): Gap => {
    const row = map.get(r);
    return {
      kind, requirement: r, help: row?.help ? (JSON.parse(row.help) as GapHelp) : null,
      answer: (row?.answer ?? null) as GapAnswer | null, outcome: row?.outcome ?? null, updated_at: row?.updated_at ?? null
    };
  };
  const list: Gap[] = [...g.must.map(gap("must")), ...g.nice.map(gap("nice")), ...g.keywords.map(gap("keyword"))];

  const bank = loadBank();
  const entries = bank ? [...bank.roles, ...bank.projects].filter(e => e.kind !== "break").map(e => ({ id: e.id, title: e.title, company: e.company ?? null, dates: e.dates })) : [];

  return { gaps: list, years: g.years, entries };
}

export function cachedHelp(db: Db, jobId: string, requirement: string): GapHelp | null {
  const row = db.prepare("SELECT help FROM gap_notes WHERE job_id = ? AND requirement = ?").get(jobId, requirement) as { help: string | null } | undefined;
  return row && row.help ? JSON.parse(row.help) as GapHelp : null;
}

export function saveHelp(db: Db, jobId: string, kind: GapKind, requirement: string, help: GapHelp): void {
  const updated_at = new Date().toISOString();
  db.prepare("INSERT INTO gap_notes (job_id, requirement, kind, help, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (job_id, requirement) DO UPDATE SET help = excluded.help, kind = excluded.kind, updated_at = excluded.updated_at").run(jobId, requirement, kind, JSON.stringify(help), updated_at);
}

const filled = (s: string | undefined): s is string => !!s && s.trim().length > 0;

export function answerGap(db: Db, jobId: string, input: AnswerInput): { outcome: string; bullet_id: string | null } {
  const today = new Date().toISOString().slice(0, 10);
  let outcome: string;
  let bullet_id: string | null = null;

  switch (input.answer) {
    case "have":
      if (!filled(input.entry_id) || !filled(input.text) || !filled(input.story)) {
        throw new Error("entry_id, text and story are required");
      }
      const evidence = `answer ${today}: ${input.story}` + (filled(input.proof) ? ` Proof: ${input.proof}` : "");
      const given = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
      const tags = given.length ? given : [input.requirement.toLowerCase()];
      bullet_id = addBullet(input.entry_id, input.text, tags, "medium", { evidence });
      outcome = `bullet ${bullet_id} added`;
      break;
    case "other_name":
      if (input.kind !== "keyword") {
        throw new Error("other_name is only for keywords");
      }
      if (!filled(input.same_as)) {
        throw new Error("same_as is required");
      }
      const skillEvidence = `answer ${today}: same as ${input.same_as}` + (filled(input.story) ? `: ${input.story}` : "");
      addSkill(input.requirement, "have", skillEvidence);
      outcome = `skill added (same as ${input.same_as})`;
      break;
    case "learnable":
      recordLearnable(input.requirement, true, jobId);
      outcome = "learnable";
      break;
    case "no":
      if (input.kind === "keyword") addSkill(input.requirement, "dont_have", "");
      outcome = "not had";
      break;
    default:
      throw new Error("Invalid answer type");
  }

  const updated_at = new Date().toISOString();
  db.prepare("INSERT INTO gap_notes (job_id, requirement, kind, answer, outcome, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (job_id, requirement) DO UPDATE SET answer = excluded.answer, outcome = excluded.outcome, updated_at = excluded.updated_at").run(jobId, input.requirement, input.kind, input.answer, outcome, updated_at);

  return { outcome, bullet_id };
}
