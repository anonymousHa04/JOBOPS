import type { Db } from "../db.ts";
import { loadBank, loadSkillsExtra, vocabulary } from "../profile/bank.ts";
import type { Bank, Bullet, SkillsExtra } from "../profile/schema.ts";
import { loadRequirements } from "../requirements/parse.ts";
import type { Requirements } from "../requirements/schema.ts";
import {
  bandOf,
  CAP_ONE_MISSING,
  CAP_TWO_MISSING,
  CREDIT,
  DEGREE_EQUIVALENT_YEARS,
  MUST_KEYWORD_WEIGHT,
  MUST_MISSING_BELOW,
  PARTS,
  QUALIFIERS,
  recency,
  TAILORED_BANDS
} from "./config.ts";
import type { Band, Part } from "./config.ts";
import { softSkills } from "../lists.ts";
import { hasTerm, norm, terms } from "./terms.ts";

// Scoring per the m3-notes skill (engine-algorithm.md §2-3): an inverted index finds
// evidence; requirements with a qualifier, or that the index cannot find, are decided
// by a judge (judge.ts). Without a judge verdict an index miss is "unknown", never
// "not_demonstrated".

export type Label = keyof typeof CREDIT;
export type Kind = "must" | "theme" | "nice" | "keyword";
// Where a label came from: the index, the judge, the index without the judge it needed,
// the role dates (years), the bank's education (degree), the user (don't have / learnable),
// a literal keyword check, or nothing.
export type LabelSource = "index" | "judge" | "index_no_judge" | "years" | "education" | "user" | "literal" | "none";

export type ScoreItem = {
  requirement: string;
  kind: Kind;
  label: Label;
  credit: number;
  bullet_ids: string[];
  source: LabelSource;
  qualifier: boolean;
  // A must-have that asks for a soft skill: scored as a theme (no cap), but tailoring
  // still picks a bullet that shows it.
  soft?: boolean;
};

// The judge's verdict on one requirement over the whole bank (see judge.ts).
export type Verdict = { label: "supported" | "partial" | "not_demonstrated"; bullet_ids: string[] };
export type Verdicts = Map<string, Verdict>;

// A missing skill to ask about, with the user's earlier answers for other JDs.
export type SkillQuestion = { skill: string; previous: { job_id: string; learnable: boolean }[] };

export type ScoreResult = {
  score: number;
  band: Band;
  // Years of experience is the only hard constraint: it can't be tailored around.
  hard: { years_asked: number; years_have: number; pass: boolean };
  tailorable: boolean;
  gap: boolean;
  missing_must: number;
  cap: number | null;
  parts: Record<Part, number>;
  coverage: { must: number; theme: number; nice: number; keyword: number };
  items: ScoreItem[];
  ask_user: SkillQuestion[];
};

// Years asked by a requirement like "6+ years of Go" (0 if none).
export function yearsAsked(r: string): number {
  return Number(r.match(/(\d+)\s*\+?\s*(?:years|yrs)/i)?.[1] ?? 0);
}

// Degree level asked by a requirement (0 if it asks for none): "Bachelor's or Master's"
// asks for the lower one.
export function degreeAsked(r: string): number {
  if (!/\b(degree|bachelor|master|ph\.?\s?d|doctorate)/i.test(r)) return 0;
  if (/\bbachelor/i.test(r)) return 1;
  if (/\bmaster/i.test(r)) return 2;
  return /\b(ph\.?\s?d|doctorate)/i.test(r) ? 3 : 1;
}

// Highest degree level in the bank's education (0 if none).
export function degreeHave(bank: Bank): number {
  const level = (d: string) =>
    /\b(ph\.?\s?d|doctor)/i.test(d) ? 3
    : /\b(master|m\.?\s?tech|m\.?\s?sc|ms|mba|mca|m\.?\s?e)\b/i.test(d) ? 2
    : /\b(bachelor|b\.?\s?tech|b\.?\s?sc|bs|ba|bca|b\.?\s?e|degree)\b/i.test(d) ? 1 : 0;
  return Math.max(0, ...bank.education.map((e) => level(e.degree)));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// One side of a date range ("Jan 2021", "03/2020", "2019", "Present") as months since year 0.
function toMonths(s: string, now: Date): number | null {
  const t = s.trim().toLowerCase();
  if (/^(present|current|now|today)$/.test(t)) return now.getFullYear() * 12 + now.getMonth();
  let m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return Number(m[2]) * 12 + Number(m[1]) - 1;
  m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m && MONTHS.includes(m[1])) return Number(m[2]) * 12 + MONTHS.indexOf(m[1]);
  m = t.match(/^(\d{4})$/);
  return m ? Number(m[1]) * 12 : null;
}

function range(dates: string): string[] {
  return dates.split(/\s*(?:-|–|—|\bto\b)\s*/i);
}

// A role's span as months since year 0, or null when its dates do not parse.
export function span(dates: string, now = new Date()): { start: number; end: number } | null {
  const parts = range(dates);
  if (parts.length !== 2) return null;
  const start = toMonths(parts[0], now);
  const end = toMonths(parts[1], now);
  return start !== null && end !== null && end >= start ? { start, end } : null;
}

// Sum of role durations in years; unparseable dates and career breaks are skipped.
export function totalYears(bank: Bank, now = new Date()): number {
  let months = 0;
  for (const role of bank.roles) {
    if (role.kind === "break") continue;
    const parts = range(role.dates);
    if (parts.length !== 2) continue;
    const start = toMonths(parts[0], now);
    const end = toMonths(parts[1], now);
    if (start !== null && end !== null && end >= start) months += end - start;
  }
  return Math.round((months / 12) * 10) / 10;
}

export function allBullets(bank: Bank): Bullet[] {
  return [...bank.roles, ...bank.projects].flatMap((e) => e.bullets);
}

// Recency of every bullet, from the end date of its role or project (1.0 if unknown).
export function bulletRecency(bank: Bank, now = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  const today = now.getFullYear() * 12 + now.getMonth();
  for (const e of [...bank.roles, ...bank.projects]) {
    const parts = range(e.dates);
    const end = toMonths(parts[parts.length - 1] ?? "", now);
    const r = end === null ? 1 : recency(today - end);
    for (const b of e.bullets) out.set(b.id, r);
  }
  return out;
}

const NUMBER = /\d/;
const ACTION_WORDS = ["build", "own", "lead", "drive", "work", "collaborate", "design"];

// A short noun phrase without an action word reads as a skill ("kafka", "react native").
function looksLikeSkill(r: string): boolean {
  const words = norm(r).split(" ");
  return words.length <= 3 && !words.some((w) => ACTION_WORDS.some((a) => w.startsWith(a)));
}

// Inverted index: canonical term -> bullets whose text or tags contain it.
export type BulletIndex = Map<string, Set<string>>;

export function buildIndex(bullets: Bullet[], vocab: Set<string>): BulletIndex {
  const index: BulletIndex = new Map();
  const add = (t: string, id: string) => {
    const set = index.get(t) ?? new Set<string>();
    set.add(id);
    index.set(t, set);
  };
  for (const b of bullets) {
    for (const t of terms(b.text, vocab)) add(t, b.id);
    for (const tag of b.tags) add(norm(tag), b.id);
  }
  return index;
}

export function evidence(r: string, bullets: Bullet[], index: BulletIndex, vocab: Set<string>): string[] {
  const ids = new Set<string>();
  for (const t of terms(r, vocab)) for (const id of index.get(t) ?? []) ids.add(id);
  for (const b of bullets) if (hasTerm(b.text, r)) ids.add(b.id);
  return [...ids];
}

// Requirements the index cannot settle alone: they have a qualifier, or the index
// finds no bullet. These are what the judge must look at (judge.ts).
export function needsJudge(req: Requirements, bank: Bank, extra: SkillsExtra): string[] {
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const bullets = allBullets(bank);
  const index = buildIndex(bullets, vocab);
  const out: string[] = [];
  for (const r of [...req.must_have, ...req.themes, ...req.nice_to_have]) {
    if (yearsAsked(r) > 0) continue;
    if (QUALIFIERS.test(r) || evidence(r, bullets, index, vocab).length === 0) out.push(r);
  }
  return [...new Set(out)];
}

// Score requirements against bank evidence. `only` limits the evidence to these bullet
// ids (a resume record); default is the whole bank. `jobId` applies the user's
// learnable-skill answers for that JD. `verdicts` holds judge results for the bank;
// a record reuses them filtered to its own bullets (no model calls).
export function scoreRequirements(
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  only?: string[],
  jobId?: string,
  verdicts: Verdicts = new Map()
): ScoreResult {
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const every = allBullets(bank);
  const bullets = only ? every.filter((b) => only.includes(b.id)) : every;
  const byId = new Map(bullets.map((b) => [b.id, b]));
  const index = buildIndex(bullets, vocab);
  const rec = bulletRecency(bank);
  const listed = new Set(
    [...Object.values(bank.skills).flat(), ...extra.skills.filter((s) => s.status === "have").map((s) => s.name)].map(norm)
  );
  const dontHave = new Set(extra.skills.filter((s) => s.status === "dont_have").map((s) => norm(s.name)));
  const answers = extra.learnable.filter((a) => a.job_id === jobId);
  const learnable = new Set(answers.filter((a) => a.learnable).map((a) => norm(a.skill)));
  const years = totalYears(bank);
  const soft = softSkills();

  // Best credit over the given bullets: supported_metric when the bullet has a number.
  const best = (ids: string[], base: "supported" | "partial") => {
    const kept = ids.filter((id) => byId.has(id));
    let top: { credit: number; label: Label } = { credit: 0, label: base };
    for (const id of kept) {
      const text = byId.get(id)?.text ?? "";
      const label: Label = base === "supported" && NUMBER.test(text) ? "supported_metric" : base;
      const credit = CREDIT[label] * (rec.get(id) ?? 1);
      if (credit > top.credit) top = { credit, label };
    }
    return { ...top, ids: kept };
  };

  const label = (r: string, kind: Kind): ScoreItem => {
    const qualifier = QUALIFIERS.test(r);
    const item = (l: Label, credit: number, ids: string[], source: LabelSource): ScoreItem =>
      ({ requirement: r, kind, label: l, credit: Math.round(credit * 1000) / 1000, bullet_ids: ids, source, qualifier });
    const asked = yearsAsked(r);
    if (asked > 0) return item(years >= asked ? "supported" : "not_demonstrated", years >= asked ? 1 : 0, [], "years");
    // A degree is checked against education, never against bullets.
    const degree = degreeAsked(r);
    if (degree > 0) {
      const ok = degreeHave(bank) >= degree || (/\bequivalent\b/i.test(r) && years >= DEGREE_EQUIVALENT_YEARS);
      return item(ok ? "supported" : "not_demonstrated", ok ? 1 : 0, [], "education");
    }
    if (dontHave.has(norm(r))) return item("not_demonstrated", 0, [], "user");
    const verdict = verdicts.get(r);
    const inList = listed.has(norm(r)) || terms(r, vocab).some((t) => listed.has(t));
    if (verdict) {
      // The judge reads bullets only: a "no" leaves a listed skill at skill_list_only.
      if (verdict.label === "not_demonstrated") {
        return inList ? item("skill_list_only", CREDIT.skill_list_only, [], "judge") : item("not_demonstrated", 0, [], "judge");
      }
      const b = best(verdict.bullet_ids, verdict.label);
      // The judge found evidence, but not in this record's bullets.
      if (b.ids.length) return item(b.label, b.credit, b.ids, "judge");
      return inList ? item("skill_list_only", CREDIT.skill_list_only, [], "judge") : item("not_demonstrated", 0, [], "judge");
    }
    const hits = evidence(r, bullets, index, vocab);
    if (hits.length) {
      // A qualifier needs the judge; without its verdict the match counts only as partial.
      const b = best(hits, qualifier ? "partial" : "supported");
      return item(b.label, b.credit, b.ids, qualifier ? "index_no_judge" : "index");
    }
    if (inList) {
      return item("skill_list_only", CREDIT.skill_list_only, [], "index");
    }
    // A soft skill shows in what a bullet says was done ("mentored" for communication):
    // indirect, so partial until the judge rates it.
    const shows = soft.shownBy(r);
    const shownIn = shows ? bullets.filter((b) => shows.test(b.text)).map((b) => b.id) : [];
    if (shownIn.length) {
      const b = best(shownIn, "partial");
      return item(b.label, b.credit, b.ids, "index");
    }
    if (learnable.has(norm(r))) return item("learnable", 0, [], "user");
    return item("unknown", 0, [], "none");
  };

  // A soft-skill must-have (soft-skills.yaml) counts as a theme: scored, but never a
  // missing must-have that caps the score. Degrees stay must-haves.
  const isSoft = (r: string) => degreeAsked(r) === 0 && soft.pattern.test(r);
  const items: ScoreItem[] = [
    ...req.must_have.map((r) => (isSoft(r) ? { ...label(r, "theme"), soft: true } : label(r, "must"))),
    ...req.themes.map((r) => label(r, "theme")),
    ...req.nice_to_have.map((r) => label(r, "nice"))
  ];

  // Keywords: literal, case-insensitive, whole words, counted once, no synonyms;
  // a keyword that also appears in a must-have counts double.
  const haystack = [...bullets.map((b) => b.text), ...listed].join("\n");
  const mustText = req.must_have.join("\n");
  let kwHit = 0;
  let kwTotal = 0;
  for (const k of [...new Set(req.keywords)]) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i");
    const w = re.test(mustText) ? MUST_KEYWORD_WEIGHT : 1;
    const hit = re.test(haystack);
    kwTotal += w;
    if (hit) kwHit += w;
    items.push({
      requirement: k, kind: "keyword", label: hit ? "supported" : "not_demonstrated",
      credit: hit ? 1 : 0, bullet_ids: [], source: "literal", qualifier: false
    });
  }

  const avg = (kind: Kind): number | null => {
    const of = items.filter((i) => i.kind === kind && !(kind === "must" && yearsAsked(i.requirement) > 0));
    return of.length ? of.reduce((n, i) => n + i.credit, 0) / of.length : null;
  };
  const value: Record<Part, number | null> = {
    must: avg("must"), resp: avg("theme"), nice: avg("nice"), keywords: kwTotal ? kwHit / kwTotal : null
  };
  // Parts with no requirements give their points to the others in proportion.
  const present = (Object.keys(PARTS) as Part[]).filter((p) => value[p] !== null);
  const weight = present.reduce((n, p) => n + PARTS[p], 0);
  const parts: Record<Part, number> = { must: 0, resp: 0, nice: 0, keywords: 0 };
  for (const p of present) parts[p] = Math.round(((100 * PARTS[p]) / weight) * (value[p] ?? 0) * 10) / 10;
  let score = Object.values(parts).reduce((a, b) => a + b, 0);

  // Must-have caps: one missing caps the score at 84.9, two or more at 74.9.
  const missing = items.filter(
    (i) => i.kind === "must" && yearsAsked(i.requirement) === 0 && i.credit < MUST_MISSING_BELOW
  );
  const cap = missing.length >= 2 ? CAP_TWO_MISSING : missing.length === 1 ? CAP_ONE_MISSING : null;
  if (cap !== null) score = Math.min(score, cap);
  const rounded = Math.round(score * 10) / 10;
  const band = bandOf(rounded);

  const yearsAskedMax = Math.max(0, ...req.must_have.map(yearsAsked));
  const hard = { years_asked: yearsAskedMax, years_have: years, pass: years >= yearsAskedMax };

  // Ask about each missing skill not answered for this JD; show answers from other JDs.
  const answered = new Set(answers.map((a) => norm(a.skill)));
  // A keyword is matched literally (as an ATS does), so "Agentic AI" misses a bank that
  // says "AI Agents"; it is not a missing skill when the bank has it under a synonym.
  const known = (k: string) => listed.has(norm(k)) || terms(k, vocab).some((t) => listed.has(t) || index.has(t));
  const skills = items
    .filter((i) => (i.label === "unknown" || i.label === "not_demonstrated") && !["years", "education", "user"].includes(i.source))
    .filter((i) => !(i.kind === "keyword" && known(i.requirement)))
    .filter((i) => looksLikeSkill(i.requirement) && !soft.pattern.test(i.requirement))
    .map((i) => norm(i.requirement))
    .filter((r) => !dontHave.has(r) && !answered.has(r));
  const ask_user = [...new Set(skills)].sort().map((skill) => ({
    skill,
    previous: extra.learnable
      .filter((a) => norm(a.skill) === skill && a.job_id !== jobId)
      .map((a) => ({ job_id: a.job_id, learnable: a.learnable }))
  }));

  return {
    score: rounded,
    band,
    hard,
    tailorable: hard.pass && TAILORED_BANDS.includes(band),
    // Learnable gaps are not blockers (user decision); every other missing must-have is.
    gap: missing.some((i) => i.label !== "learnable"),
    missing_must: missing.length,
    cap,
    parts,
    coverage: { must: value.must ?? 1, theme: value.resp ?? 1, nice: value.nice ?? 1, keyword: value.keywords ?? 1 },
    items,
    ask_user
  };
}

export type ScoreSummary = {
  job_id: string;
  score: number;
  band: Band;
  hard: ScoreResult["hard"];
  tailorable: boolean;
  gap: boolean;
  missing_must: number;
  cap: number | null;
  parts: ScoreResult["parts"];
  labels: Partial<Record<Label, number>>;
  needs_judge: number;
  ask_user: SkillQuestion[];
};

export function scoreJob(db: Db, jobId: string, verdicts: Verdicts = new Map()): ScoreSummary {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first");
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const extra = loadSkillsExtra();
  const r = scoreRequirements(req, bank, extra, undefined, jobId, verdicts);
  const labels: Partial<Record<Label, number>> = {};
  for (const i of r.items) if (i.kind !== "keyword") labels[i.label] = (labels[i.label] ?? 0) + 1;
  return {
    job_id: jobId,
    score: r.score,
    band: r.band,
    hard: r.hard,
    tailorable: r.tailorable,
    gap: r.gap,
    missing_must: r.missing_must,
    cap: r.cap,
    parts: r.parts,
    labels,
    needs_judge: needsJudge(req, bank, extra).filter((x) => !verdicts.has(x)).length,
    ask_user: r.ask_user
  };
}
