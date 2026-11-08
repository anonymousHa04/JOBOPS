// The Gaps tab (UI): requirements the experience bank does not show for a job, the cached
// explanation of each (gap-model.ts), and the user's answers. No model calls here.
import type { Db } from "../db.ts";
import { addSynonym, askable } from "../lists.ts";
import { addBullet, addSkill, loadBank, loadSkillsExtra, recordLearnable } from "../profile/bank.ts";
import { answerEvidence, storyNames } from "../profile/gate.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { bankTermFor, scoreRequirements, span, yearsAsked } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { event, shortId } from "../log.ts";
import { carriedInput, reuseFor } from "./gap-memory.ts";
import type { CarriedFrom, EarlierInput, Reuse } from "./gap-memory.ts";
import { gapKey } from "./gap-related.ts";

export type GapKind = "must" | "theme" | "nice" | "keyword";
export type GapAnswer = "have" | "other_name" | "learnable" | "no";
export type GapHelp = { meaning: string; similar_terms: string[]; related: { bullet_id: string; why: string }[]; questions: string[] };
export type Gap = {
  kind: GapKind; requirement: string; note: string | null; known_as: string | null; help: GapHelp | null;
  answer: GapAnswer | null; outcome: string | null; updated_at: string | null;
  carried_from: CarriedFrom | null; // the answer was carried from another job's answer
  carried_input: EarlierInput | null; // what that earlier answer typed ("Edit / improve" fills the form)
  declined: boolean;               // the user undid a carried answer here: not carried again
  reuse: Reuse;                     // earlier answers on other jobs (gap-memory.ts)
  help_queued: boolean;             // its explanation is queued or running (stage gap_help)
};
export type AnswerInput = {
  kind: GapKind; requirement: string; answer: GapAnswer;
  entry_id?: string; text?: string; tags?: string[]; story?: string; proof?: string; same_as?: string;
  as_skill?: boolean; entry_ids?: string[]; extra_skills?: string[];
  with_skill?: boolean; // a bullet answer also saves the skill, even with one role checked
  draft_codes?: string[]; // what the guard and gate said about the draft, kept with what was typed
};
export type Entry = { id: string; title: string; company: string | null; dates: string; project: boolean; bullets: number; end: number | null };

export type NotAsked = { kind: GapKind; requirement: string; reason: string };

// Every requirement that is red on the Score tab: must-haves, responsibilities and
// nice-to-haves under 0.5 credit, keywords not found word for word. Each carries a note on why
// it is red. Only what an answer cannot change (years, degrees) is listed apart, in not_asked.
export function gapList(db: Db, jobId: string): { gaps: Gap[]; not_asked: NotAsked[]; years: string | null; entries: Entry[] } {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("This job has not been parsed yet.");
  const bank = loadBank();
  if (!bank) throw new Error("No experience bank: run bank build.");
  const extra = loadSkillsExtra();
  const r = scoreRequirements(req, bank, extra, undefined, jobId, loadVerdicts(db, req, bank, extra));

  const rows = db.prepare("SELECT requirement, kind, help, answer, outcome, updated_at, carried_from, input FROM gap_notes WHERE job_id = ?").all(jobId) as { requirement: string; kind: string; help: string | null; answer: string | null; outcome: string | null; updated_at: string; carried_from: string | null; input: string | null }[];
  const map = new Map(rows.map(row => [row.requirement, row]));

  const queued = queuedHelp(db, jobId);
  const list: Gap[] = [];
  const notAsked: NotAsked[] = [];
  for (const i of r.items) {
    const kind = i.kind as GapKind;
    if (i.credit >= (kind === "keyword" ? 1 : 0.5)) continue;
    if (kind !== "keyword" && (yearsAsked(i.requirement) > 0 || i.source === "years")) {
      notAsked.push({ kind, requirement: i.requirement, reason: "Asks for years of experience: it comes from your role dates (the Years line), so an answer cannot change it." });
      continue;
    }
    if (i.source === "education") {
      notAsked.push({ kind, requirement: i.requirement, reason: "A degree requirement: it comes from your education entries, not from answers." });
      continue;
    }
    let note: string | null = null;
    const knownAs = kind === "keyword" ? bankTermFor(bank, extra, i.requirement) : null;
    if (knownAs) note = `Your bank has this as "${knownAs}", but keywords are matched word for word, as an ATS does. If it is the same thing, use "I have it under another name".`;
    else if (kind === "keyword" && !askable(i.requirement)) note = "A general term. An ATS still looks for these exact words: answer if it fairly describes your work.";
    else if (i.source === "index_no_judge") note = "Not judged yet: it counts as 0 until the judge runs. Re-score to run it.";
    else if (i.soft) note = "A soft skill: scored as a responsibility, never caps the score.";
    const row = map.get(i.requirement);
    const carried = row?.carried_from && row.carried_from !== "declined" ? (JSON.parse(row.carried_from) as CarriedFrom) : null;
    list.push({
      kind, requirement: i.requirement, note, known_as: knownAs,
      help: row?.help ? (JSON.parse(row.help) as GapHelp) : null,
      answer: (row?.answer ?? null) as GapAnswer | null, outcome: row?.outcome ?? null, updated_at: row?.updated_at ?? null,
      carried_from: carried,
      carried_input: carried && row ? carriedInput(db, { ...row, answer: row.answer as GapAnswer | null }) : null,
      declined: row?.carried_from === "declined", reuse: { exact: null, similar: [] },
      help_queued: queued.has(gapKey(i.requirement))
    });
  }
  // Earlier answers on other jobs, for the open gaps only.
  const reuse = reuseFor(db, jobId, list.filter((g) => !g.answer));
  for (const g of list) g.reuse = reuse.get(g.requirement) ?? g.reuse;

  // project, bullets and end describe each job or project the user can pick for a drafted
  // bullet (the UI shows each with its dates; nothing is picked automatically).
  const projects = new Set(bank.projects.map((p) => p.id));
  const entries: Entry[] = [...bank.roles, ...bank.projects].filter(e => e.kind !== "break").map(e => ({
    id: e.id, title: e.title, company: e.company ?? null, dates: e.dates,
    project: projects.has(e.id), bullets: e.bullets.length, end: span(e.dates)?.end ?? null
  }));
  const years = r.hard.pass ? null : `asks ${r.hard.years_asked}+ years; I have ${r.hard.years_have}`;
  return { gaps: list, not_asked: notAsked, years, entries };
}

// Keys of this job's gaps whose explanation is queued or running in the queue (gap_help tasks,
// prompt_version gap-<key>-<batch>). The queue's table exists only once the queue server ran.
function queuedHelp(db: Db, jobId: string): Set<string> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queue_tasks'").get()) return new Set();
  const rows = db.prepare("SELECT prompt_version FROM queue_tasks WHERE job_id = ? AND stage = 'gap_help' AND state IN ('queued', 'leased')")
    .all(jobId) as { prompt_version: string }[];
  return new Set(rows.map((r) => r.prompt_version.split("-")[1]));
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
      if (input.as_skill) {
        const ids = (input.entry_ids ?? []).filter(filled);
        if (!filled(input.story) || !ids.length) throw new Error("story and at least one role are required");
        if (!storyNames(input.story, input.requirement)) throw new Error("blocked: skill_unsupported");
        const bank = loadBank();
        const roles = bank ? [...bank.roles, ...bank.projects] : [];
        const names = ids.map((id) => {
          const e = roles.find((r) => r.id === id);
          return e ? (e.company ? `${e.title} at ${e.company}` : e.title) : id;
        });
        const skillNote = `answer ${today}: ${input.story} (used at: ${names.join("; ")})` + (filled(input.proof) ? ` Proof: ${input.proof}` : "");
        addSkill(input.requirement, "have", skillNote);
        outcome = `skill added (used at ${ids.length} role${ids.length === 1 ? "" : "s"})`;
        break;
      }

      if (!filled(input.entry_id) || !filled(input.text) || !filled(input.story)) {
        throw new Error("entry_id, text and story are required");
      }
      // Which gap it answers goes with it: the bank gate lets the requirement's own name in.
      const evidence = answerEvidence(today, input.requirement, input.story) + (filled(input.proof) ? ` Proof: ${input.proof}` : "");
      const given = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
      const tags = given.length ? given : [input.requirement.toLowerCase()];
      bullet_id = addBullet(input.entry_id, input.text, tags, "medium", { evidence });
      outcome = `bullet ${bullet_id} added`;
      // Other checked roles: the requirement is also saved as a skill, with every checked role as
      // context (the bullet is the evidence at one of them).
      const others = [...new Set([...(input.entry_ids ?? []), ...(input.with_skill ? [input.entry_id] : [])].filter(filled))];
      // Only when the story names the requirement; else the bullet alone is saved.
      const wantSkill = others.length > 1 || (input.with_skill && others.length > 0);
      if (wantSkill && !storyNames(input.story, input.requirement)) {
        outcome += "; skill not added (your story does not name it)";
      } else if (wantSkill) {
        const bank = loadBank();
        const roles = bank ? [...bank.roles, ...bank.projects] : [];
        const names = others.map((id) => {
          const e = roles.find((r) => r.id === id);
          return e ? (e.company ? `${e.title} at ${e.company}` : e.title) : id;
        });
        addSkill(input.requirement, "have", `answer ${today}: ${input.story} (used at: ${names.join("; ")}; bullet ${bullet_id})`);
        outcome += `; skill added (used at ${others.length} role${others.length === 1 ? "" : "s"})`;
      }
      // Skills the user's own story names, that they ticked under the draft.
      const extras = [...new Set((input.extra_skills ?? []).map((s) => s.trim()).filter(Boolean))]
        .filter((s) => input.story!.toLowerCase().includes(s.toLowerCase()));
      for (const s of extras) addSkill(s, "have", `answer ${today}: named in the story for "${input.requirement}": ${input.story}`);
      if (extras.length) outcome += `; ${extras.length} more skill${extras.length === 1 ? "" : "s"} (${extras.join(", ")})`;
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
      // Remember the spelling for later jobs: the tailored resume then uses the job's own word
      // in the skills line and bullets wherever the bank has the skill under its usual name.
      const learned = addSynonym(input.requirement, norm(input.same_as));
      outcome = `skill added (same as ${input.same_as})` + (learned ? "; spelling saved for later jobs" : "");
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
  // What the user typed, so another job's form can be filled from it (gap-memory.ts).
  const typed = input.answer === "have" || input.answer === "other_name" ? JSON.stringify({
    answer: input.answer, story: input.story ?? "", proof: input.proof ?? "", same_as: input.same_as ?? "",
    text: input.text ?? "", draft_codes: input.draft_codes ?? [],
    entry_ids: [...new Set([...(input.entry_ids ?? []), ...(input.entry_id ? [input.entry_id] : [])].filter(filled))]
  }) : null;
  // An answer given here replaces a carried one (and its carried_from mark).
  db.prepare("INSERT INTO gap_notes (job_id, requirement, kind, answer, outcome, carried_from, input, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (job_id, requirement) DO UPDATE SET answer = excluded.answer, outcome = excluded.outcome, carried_from = NULL, input = excluded.input, updated_at = excluded.updated_at").run(jobId, input.requirement, input.kind, input.answer, outcome, typed, updated_at);

  event(`gap answered (job ${shortId(jobId)}): ${input.kind} "${input.requirement}": ${input.answer}, ${outcome}`);
  return { outcome, bullet_id };
}
