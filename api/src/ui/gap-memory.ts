// Gaps tab answer memory: answers the user gave on other jobs, reused here for the same ask.
//
// - Exact: the same ask after normalizing (synonyms included), or a pair the user confirmed
//   before. The answer is carried over automatically, marked with where it came from; Undo
//   declines it for this job.
// - Similar: asks that share most key words. The local judge model (general7, task gap_match)
//   checks each pair; the user accepts or rejects what it proposes. Both are remembered in
//   gap_links: an accepted pair is carried automatically next time, a rejected pair is never
//   proposed again, and a user verdict always wins over the model's.
//
// Only JD wording goes to the model (the two asks), never bank or profile text.
import { z } from "zod";
import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { ensureModel, forTask, ModelDownError } from "../model/registry.ts";
import { addSkill, forgetLearnable, loadBank, loadSkillsExtra, recordLearnable } from "../profile/bank.ts";
import type { Bank, SkillsExtra } from "../profile/schema.ts";
import { allBullets } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { event, plural, shortId, warnEvent } from "../log.ts";
import { gapList } from "./gaps.ts";
import type { GapAnswer, GapKind } from "./gaps.ts";

// exact: same normalized ask; learned: a pair the user confirmed; model: the judge says same,
// waiting for the user; overlap: shares key words, not checked by the model yet.
export type Match = "exact" | "learned" | "model" | "overlap";
export type Previous = {
  from_job: string | null; // null: from your skills list (skills-extra.yaml), not a job
  company: string; title: string;
  requirement: string; kind: GapKind | null;
  answer: GapAnswer; outcome: string | null;
  match: Match;
  input: EarlierInput | null; // what was typed with it, to fill this job's form (null: nothing to fill)
};
export type CarriedFrom = { job_id: string | null; requirement: string; company: string; title: string; match: Match };
export type Reuse = { exact: Previous | null; similar: Previous[] };
// The story, proof, roles and other name given with a "have" or "other name" answer.
export type EarlierInput = { answer: GapAnswer; story: string; proof: string; entry_ids: string[]; same_as: string };

type Prior = Omit<Previous, "match" | "input"> & { key: string; at: string; carried: boolean; raw_input: string | null; carried_from: string | null };

const MAX_SIMILAR = 3;
const PARALLEL = Math.max(1, Number(process.env.JOBOPS_JUDGE_PARALLEL ?? 3));

export const askKey = (s: string) => norm(s);
const pairKey = (a: string, b: string) => (a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
// Keywords answer keywords; must-haves, responsibilities and nice-to-haves answer each other.
const compatible = (a: GapKind, b: GapKind | null) => b === null || (a === "keyword") === (b === "keyword");

// Words that say nothing about what is asked.
const STOP = new Set(["and", "the", "for", "with", "experience", "experienced", "years", "year", "strong", "ability",
  "able", "knowledge", "understanding", "working", "work", "skills", "skill", "proven", "solid", "good", "excellent",
  "familiarity", "familiar", "plus", "using", "use", "including", "such", "other", "etc", "our", "your", "you", "will",
  "have", "has", "across", "within", "into", "from", "deep", "hands", "demonstrated", "track", "record", "related"]);
const stems = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9+#]+/)
  .filter((w) => w.length >= 2 && !STOP.has(w)).map((w) => (w.length > 6 ? w.slice(0, 6) : w)));
function overlap(a: Set<string>, b: Set<string>): { dice: number; shared: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return { dice: a.size + b.size ? (2 * shared) / (a.size + b.size) : 0, shared };
}
const similarEnough = (kind: GapKind, o: { dice: number; shared: number }) =>
  kind === "keyword" ? o.dice >= 0.5 : o.dice >= 0.5 && o.shared >= 2;

type Link = { verdict: "same" | "different"; source: "model" | "user" };
function links(db: Db): Map<string, Link> {
  const rows = db.prepare("SELECT a, b, verdict, source FROM gap_links").all() as ({ a: string; b: string } & Link)[];
  return new Map(rows.map((r) => [pairKey(r.a, r.b), { verdict: r.verdict, source: r.source }]));
}

function saveLink(db: Db, a: string, b: string, verdict: Link["verdict"], source: Link["source"], model: string | null): void {
  const [x, y] = a <= b ? [a, b] : [b, a];
  // A model verdict never replaces the user's.
  db.prepare(`INSERT INTO gap_links (a, b, verdict, source, model, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (a, b) DO UPDATE SET verdict = excluded.verdict, source = excluded.source, model = excluded.model, created_at = excluded.created_at
    WHERE gap_links.source = 'model' OR excluded.source = 'user'`)
    .run(x, y, verdict, source, model, new Date().toISOString());
}

// Every answer given outside this job: Gaps answers on other jobs, then what only the skills
// list holds (a "don't have" or a learnable answer from the CLI). One per ask: an answer given
// by hand wins over a carried one, then the most recent.
function priors(db: Db, jobId: string): Prior[] {
  const rows = db.prepare(`SELECT g.job_id, g.requirement, g.kind, g.answer, g.outcome, g.updated_at, g.carried_from, g.input, j.title, j.company
    FROM gap_notes g JOIN jobs j ON j.id = g.job_id
    WHERE g.job_id != ? AND g.answer IS NOT NULL`).all(jobId) as {
    job_id: string; requirement: string; kind: GapKind; answer: GapAnswer; outcome: string | null; updated_at: string;
    carried_from: string | null; input: string | null; title: string; company: string;
  }[];
  const out: Prior[] = rows.map((r) => ({
    from_job: r.job_id, company: r.company, title: r.title, requirement: r.requirement, kind: r.kind,
    answer: r.answer, outcome: r.outcome, key: askKey(r.requirement), at: r.updated_at,
    carried: !!r.carried_from && r.carried_from !== "declined", raw_input: r.input, carried_from: r.carried_from
  }));
  const seen = new Set(out.map((p) => `${p.key}\u0000${p.from_job}`));
  const extra = loadSkillsExtra();
  for (const s of extra.skills.filter((x) => x.status === "dont_have")) {
    out.push({ from_job: null, company: "", title: "your skills list", requirement: s.name, kind: "keyword",
      answer: "no", outcome: "not had", key: askKey(s.name), at: s.added_at, carried: false, raw_input: null, carried_from: null });
  }
  const job = db.prepare("SELECT title, company FROM jobs WHERE id = ?");
  for (const l of extra.learnable.filter((x) => x.job_id !== jobId)) {
    const key = askKey(l.skill);
    if (seen.has(`${key}\u0000${l.job_id}`)) continue;
    const j = job.get(l.job_id) as { title: string; company: string } | undefined;
    out.push({ from_job: l.job_id, company: j?.company ?? "", title: j?.title ?? "an earlier job", requirement: l.skill, kind: null,
      answer: l.learnable ? "learnable" : "no", outcome: l.learnable ? "learnable" : "not learnable", key, at: l.answered_at, carried: false, raw_input: null, carried_from: null });
  }
  const best = new Map<string, Prior>();
  for (const p of out) {
    const id = `${p.key}\u0000${p.kind === "keyword" || p.kind === null ? "k" : "s"}`;
    const b = best.get(id);
    if (!b || (b.carried && !p.carried) || (b.carried === p.carried && p.at > b.at)) best.set(id, p);
  }
  return [...best.values()];
}

// --- What was typed with an earlier answer -------------------------------------------------
// Answers saved since 2026-11-05 keep it in gap_notes.input. Older ones are read back from the
// evidence the answer wrote: a bullet's evidence ("answer <date>: <story> Proof: <proof>") or
// a skill's ("answer <date>: <story> (used at: <role>; <role>) Proof: <proof>").

type Ctx = { db: Db; bank: Bank | null; extra: SkillsExtra };
const ctx = (db: Db): Ctx => ({ db, bank: loadBank(), extra: loadSkillsExtra() });

export function parseEvidence(ev: string): { story: string; proof: string; used_at: string[] } {
  let s = ev.replace(/^answer \d{4}-\d{2}-\d{2}:\s*/, "");
  let proof = "";
  const p = s.lastIndexOf(" Proof: ");
  if (p >= 0) { proof = s.slice(p + 8).trim(); s = s.slice(0, p); }
  let used: string[] = [];
  const u = s.match(/\s*\(used at: (.*)\)\s*$/);
  if (u) {
    used = u[1].split(";").map((x) => x.trim()).filter((x) => x && !/^bullet /.test(x));
    s = s.slice(0, u.index);
  }
  return { story: s.trim(), proof, used_at: used };
}

function entryIds(bank: Bank | null, names: string[]): string[] {
  if (!bank) return [];
  const entries = [...bank.roles, ...bank.projects];
  return names.map((n) => entries.find((e) => (e.company ? `${e.title} at ${e.company}` : e.title) === n)?.id)
    .filter((x): x is string => !!x);
}

function fromEvidence(c: Ctx, requirement: string, answer: GapAnswer, outcome: string | null): EarlierInput | null {
  const out: EarlierInput = { answer, story: "", proof: "", entry_ids: [], same_as: "" };
  const skill = c.extra.skills.find((s) => s.name === requirement.trim().toLowerCase() && s.status === "have");
  if (answer === "other_name") {
    const ev = (skill?.evidence ?? "").replace(/^answer \d{4}-\d{2}-\d{2}:\s*/, "");
    const m = ev.match(/^same as (.+?)(?:: (.*))?$/s) ?? outcome?.match(/same as ([^)]+)\)/);
    if (!m) return null;
    return { ...out, same_as: m[1].trim(), story: (m[2] ?? "").trim() };
  }
  if (answer !== "have") return null;
  const bulletId = outcome?.match(/bullet (\S+) added/)?.[1];
  if (bulletId && c.bank) {
    const b = allBullets(c.bank).find((x) => x.id === bulletId);
    if (b?.evidence) Object.assign(out, parseEvidence(b.evidence));
    const role = [...c.bank.roles, ...c.bank.projects].filter((e) => bulletId.startsWith(e.id + "-")).sort((x, y) => y.id.length - x.id.length)[0];
    if (role) out.entry_ids.push(role.id);
  }
  if (skill?.evidence) {
    const e = parseEvidence(skill.evidence);
    if (!out.story) { out.story = e.story; out.proof = e.proof; }
    out.entry_ids = [...new Set([...out.entry_ids, ...entryIds(c.bank, e.used_at)])];
  }
  return out.story || out.entry_ids.length ? out : null;
}

// The input of one gap_notes row: its own, else (a carried row) its source's, else the evidence.
function inputOf(c: Ctx, row: { requirement: string; answer: GapAnswer | null; outcome: string | null; raw_input: string | null; carried_from: string | null }, depth = 0): EarlierInput | null {
  if (!row.answer || (row.answer !== "have" && row.answer !== "other_name")) return null;
  if (row.raw_input) return JSON.parse(row.raw_input) as EarlierInput;
  if (row.carried_from && row.carried_from !== "declined" && depth < 3) {
    const from = JSON.parse(row.carried_from) as CarriedFrom;
    const src = from.job_id
      ? c.db.prepare("SELECT requirement, answer, outcome, input AS raw_input, carried_from FROM gap_notes WHERE job_id = ? AND requirement = ?").get(from.job_id, from.requirement) as Parameters<typeof inputOf>[1] | undefined
      : undefined;
    if (src) return inputOf(c, src, depth + 1);
  }
  return fromEvidence(c, row.requirement, row.answer, row.outcome);
}

// For a carried answer on this job: what to fill its form with ("Edit / improve").
export function carriedInput(db: Db, row: { requirement: string; answer: GapAnswer | null; outcome: string | null; input: string | null; carried_from: string | null }): EarlierInput | null {
  return inputOf(ctx(db), { ...row, raw_input: row.input });
}

// --- Setting: carry exact matches automatically (default) or only propose them -------------
const AUTO_KEY = "gaps_auto_carry";
export function autoCarry(db: Db): boolean {
  const row = db.prepare("SELECT value FROM ui_state WHERE key = ?").get(AUTO_KEY) as { value: string } | undefined;
  return row?.value !== "off";
}
export function setAutoCarry(db: Db, on: boolean): void {
  db.prepare("INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(AUTO_KEY, on ? "on" : "off");
}

const asPrevious = (c: Ctx, p: Prior, match: Match): Previous => ({
  from_job: p.from_job, company: p.company, title: p.title, requirement: p.requirement, kind: p.kind,
  answer: p.answer, outcome: p.outcome, match, input: inputOf(c, p)
});

// For each gap: the answer to carry (exact or learned), and the similar asks to propose.
export function reuseFor(db: Db, jobId: string, gaps: { kind: GapKind; requirement: string }[]): Map<string, Reuse> {
  const c = ctx(db);
  const all = priors(db, jobId);
  const known = links(db);
  const pre = all.map((p) => ({ p, s: stems(p.requirement) }));
  const out = new Map<string, Reuse>();
  for (const g of gaps) {
    const key = askKey(g.requirement);
    const mine = stems(g.requirement);
    let exact: { p: Prior; match: Match } | null = null;
    const similar: { p: Prior; match: Match; score: number }[] = [];
    for (const { p, s } of pre) {
      if (!compatible(g.kind, p.kind)) continue;
      if (p.key === key) {
        exact ??= { p, match: "exact" };
        continue;
      }
      const link = known.get(pairKey(key, p.key));
      if (link?.verdict === "different") continue;
      if (link?.verdict === "same" && link.source === "user") {
        exact ??= { p, match: "learned" };
        continue;
      }
      const o = overlap(mine, s);
      if (link?.verdict === "same") similar.push({ p, match: "model", score: 1 + o.dice });
      else if (similarEnough(g.kind, o)) similar.push({ p, match: "overlap", score: o.dice });
    }
    similar.sort((a, b) => b.score - a.score);
    // The typed input is looked up only for what is shown.
    out.set(g.requirement, {
      exact: exact ? asPrevious(c, exact.p, exact.match) : null,
      similar: exact ? [] : similar.slice(0, MAX_SIMILAR).map((x) => asPrevious(c, x.p, x.match))
    });
  }
  return out;
}

const where = (p: Previous) => (p.from_job && p.company ? `${p.company} (${p.title})` : p.title);

// Writes p's answer as this job's answer to the gap, with what the answer needs for this job:
// a learnable answer is per JD, a "no" to a keyword is a don't-have skill. A "have" needs
// nothing new (the bullet, skill or spelling is already saved): a re-score counts it here.
function apply(db: Db, jobId: string, gap: { kind: GapKind; requirement: string }, p: Previous): { outcome: string; rescore: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  if (p.answer === "learnable") recordLearnable(gap.requirement, true, jobId);
  if (p.answer === "no" && gap.kind === "keyword") addSkill(gap.requirement, "dont_have", `answer ${today}: same as "${p.requirement}" (${where(p)})`);
  const same = askKey(p.requirement) === askKey(gap.requirement);
  const outcome = `${p.match === "exact" ? "from" : "same as"} ${where(p)}${same ? "" : ` "${p.requirement}"`}: ${p.outcome ?? p.answer}`;
  const carried: CarriedFrom = { job_id: p.from_job, requirement: p.requirement, company: p.company, title: p.title, match: p.match };
  // The typed input goes with it, so "Edit / improve" here (and a later job) can fill the form.
  db.prepare(`INSERT INTO gap_notes (job_id, requirement, kind, answer, outcome, carried_from, input, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, requirement) DO UPDATE SET answer = excluded.answer, outcome = excluded.outcome, carried_from = excluded.carried_from, input = excluded.input, updated_at = excluded.updated_at`)
    .run(jobId, gap.requirement, gap.kind, p.answer, outcome, JSON.stringify(carried), p.input ? JSON.stringify(p.input) : null, new Date().toISOString());
  return { outcome, rescore: p.answer === "have" || p.answer === "other_name" };
}

// Carries every exact or learned earlier answer to this job's open gaps (not the ones the user
// declined here), unless the user turned automatic carrying off: then they are only proposed.
// Returns how many, and whether a re-score is needed to count them.
export function carryAnswers(db: Db, jobId: string): { carried: number; rescore: boolean } {
  let carried = 0;
  let rescore = false;
  if (!autoCarry(db)) return { carried, rescore };
  for (const g of gapList(db, jobId).gaps) {
    if (g.answer || g.declined || !g.reuse.exact) continue;
    rescore = apply(db, jobId, g, g.reuse.exact).rescore || rescore;
    carried++;
  }
  if (carried) event(`gaps (job ${shortId(jobId)}): ${plural(carried, "earlier answer")} carried`);
  return { carried, rescore };
}

// The user's verdict on a proposed earlier answer. Accept: this job takes that answer, and a
// similar pair is carried automatically from now on. Reject: a similar pair is never proposed
// again; the same ask (exact) is declined for this job only.
export function reuseAnswer(db: Db, jobId: string, input: { kind: GapKind; requirement: string; from_job: string | null; from_requirement: string; accept: boolean }): { outcome: string; rescore: boolean } {
  const g = gapList(db, jobId).gaps.find((x) => x.kind === input.kind && x.requirement === input.requirement);
  if (!g) throw new Error("not a gap of this job");
  const p = [...(g.reuse.exact ? [g.reuse.exact] : []), ...g.reuse.similar]
    .find((x) => x.from_job === input.from_job && x.requirement === input.from_requirement);
  if (!p) throw new Error("that earlier answer is not proposed for this gap");
  if (p.match === "exact") {
    if (input.accept) return apply(db, jobId, g, p);
    markDeclined(db, jobId, g);
    event(`gap (job ${shortId(jobId)}): earlier answer not used for "${g.requirement}"`);
    return { outcome: "not used for this job", rescore: false };
  }
  saveLink(db, askKey(g.requirement), askKey(p.requirement), input.accept ? "same" : "different", "user", null);
  event(`gap (job ${shortId(jobId)}): "${g.requirement}" ${input.accept ? "=" : "≠"} "${p.requirement}" (your verdict, remembered)`);
  if (!input.accept) return { outcome: "not the same: not proposed again", rescore: false };
  return apply(db, jobId, g, { ...p, match: "learned" });
}

// The user answered this ask from an earlier answer to another ask: they are the same ask
// (carried automatically from now on). Nothing to record when they already are the same.
export function linkSame(db: Db, requirement: string, fromRequirement: string): void {
  const a = askKey(requirement);
  const b = askKey(fromRequirement);
  if (a !== b) saveLink(db, a, b, "same", "user", null);
}

function markDeclined(db: Db, jobId: string, gap: { kind: GapKind; requirement: string }): void {
  db.prepare(`INSERT INTO gap_notes (job_id, requirement, kind, carried_from, updated_at) VALUES (?, ?, ?, 'declined', ?)
    ON CONFLICT (job_id, requirement) DO UPDATE SET answer = NULL, outcome = NULL, carried_from = 'declined', input = NULL, updated_at = excluded.updated_at`)
    .run(jobId, gap.requirement, gap.kind, new Date().toISOString());
}

// Undo a carried answer for this job: the gap is open again and not carried again here. A
// learnable answer carried here is removed for this JD; a "don't have" skill stays (other
// jobs may use it; answering the gap replaces it).
export function declineCarried(db: Db, jobId: string, requirement: string): void {
  const row = db.prepare("SELECT answer, carried_from FROM gap_notes WHERE job_id = ? AND requirement = ?").get(jobId, requirement) as { answer: string | null; carried_from: string | null } | undefined;
  if (!row?.carried_from || row.carried_from === "declined") throw new Error("this answer was not carried from another job");
  if (row.answer === "learnable") forgetLearnable(requirement, jobId);
  db.prepare("UPDATE gap_notes SET answer = NULL, outcome = NULL, carried_from = 'declined', input = NULL, updated_at = ? WHERE job_id = ? AND requirement = ?")
    .run(new Date().toISOString(), jobId, requirement);
  event(`gap (job ${shortId(jobId)}): carried answer undone for "${requirement}"`);
}

const MatchSchema = z.object({ same: z.array(z.number().int()).max(MAX_SIMILAR) });
const PROMPT = `Two job postings can ask for the same thing in different words. A candidate already answered
the earlier asks below ("I have done this" or "I have not"). For each earlier ask, decide whether
that answer would also answer the new ask.

New ask ([kind]): "[ask]"

Earlier asks:
[earlier]

Rules:
- Same: the same skill, tool, practice or duty, at about the same level, in other words
  ("REST APIs" and "RESTful web services"; "on-call for production" and "production support rotation").
- Not the same: a different tool, a broader or narrower ask, or a different level
  ("Kubernetes" and "Docker"; "led a team" and "mentored engineers"; "SQL" and "PostgreSQL tuning").
- When unsure, it is not the same.

Return JSON: {"same": [numbers of the earlier asks that are the same; [] if none]}`;

export type MatchStats = { gaps: number; checked: number; same: number; failed: number; error: string | null };

// Asks the judge model about every similar ask not checked yet, one call per gap (a few at
// once). The model only proposes: the user still accepts or rejects each match.
export async function matchSimilar(db: Db, jobId: string, opts: { baseUrl?: string } = {}): Promise<MatchStats> {
  const todo = gapList(db, jobId).gaps
    .filter((g) => !g.answer && g.reuse.similar.some((p) => p.match === "overlap"))
    .map((g) => ({ g, cands: g.reuse.similar.filter((p) => p.match === "overlap") }));
  const stats: MatchStats = { gaps: todo.length, checked: 0, same: 0, failed: 0, error: null };
  if (!todo.length) return stats;
  if (!opts.baseUrl) {
    try {
      await ensureModel("gap_match", "to check earlier answers");
    } catch (err) {
      if (err instanceof ModelDownError) {
        warnEvent(`gap match (job ${shortId(jobId)}): ${plural(todo.length, "gap")} not checked: ${err.message}`);
        return { ...stats, failed: todo.length, error: err.message };
      }
      throw err;
    }
  }
  const model = forTask("gap_match").model;
  let next = 0;
  const one = async ({ g, cands }: (typeof todo)[number]) => {
    if (stats.error) { stats.failed++; return; }
    const prompt = PROMPT.replace("[kind]", g.kind === "keyword" ? "keyword" : "requirement")
      .replace("[ask]", g.requirement)
      .replace("[earlier]", cands.map((p, i) => `${i + 1}. "${p.requirement}"`).join("\n"));
    const res = await generate({ task: "gap_match", prompt, schema: MatchSchema, baseUrl: opts.baseUrl });
    if (!res.ok) { stats.failed++; stats.error = `${res.error}: ${res.detail}`; return; }
    const same = new Set(res.value.same.filter((n) => n >= 1 && n <= cands.length));
    cands.forEach((p, i) => {
      saveLink(db, askKey(g.requirement), askKey(p.requirement), same.has(i + 1) ? "same" : "different", "model", model);
      stats.checked++;
      if (same.has(i + 1)) stats.same++;
    });
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, async () => {
    while (next < todo.length) await one(todo[next++]);
  }));
  if (stats.error) warnEvent(`gap match (job ${shortId(jobId)}): ${stats.checked} pairs checked, then the model failed: ${stats.error}`);
  else event(`gap match (job ${shortId(jobId)}, ${model}): ${plural(stats.checked, "pair")} checked, ${stats.same} same`);
  return stats;
}
