import type { Db } from "../db.ts";
import { loadBank, loadSkillsExtra, vocabulary } from "../profile/bank.ts";
import type { Bank, Bullet, SkillsExtra } from "../profile/schema.ts";
import { loadRequirements } from "../requirements/parse.ts";
import type { Requirements } from "../requirements/schema.ts";
import { bandOf, TAILORED_BANDS, WEIGHTS } from "./config.ts";
import type { Band } from "./config.ts";
import { hasTerm, norm, terms } from "./terms.ts";

// "learnable": missing, but the user said it can be learned for this JD (counts half, no gap).
export type Label = "supported" | "partial" | "learnable" | "not_demonstrated" | "unknown";
export type Kind = "must" | "nice" | "keyword";

export type ScoreItem = { requirement: string; kind: Kind; label: Label; bullet_ids: string[] };

// A missing skill to ask about, with the user's earlier answers for other JDs.
export type SkillQuestion = { skill: string; previous: { job_id: string; learnable: boolean }[] };

export type ScoreResult = {
  score: number;
  band: Band;
  // Years of experience is the only hard constraint: it can't be tailored around.
  hard: { years_asked: number; years_have: number; pass: boolean };
  tailorable: boolean;
  gap: boolean;
  coverage: { must: number; nice: number; keyword: number };
  items: ScoreItem[];
  ask_user: SkillQuestion[];
};

// Years asked by a requirement like "6+ years of Go" (0 if none).
export function yearsAsked(r: string): number {
  return Number(r.match(/(\d+)\s*\+?\s*(?:years|yrs)/i)?.[1] ?? 0);
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

// Sum of role durations in years; unparseable dates are skipped.
export function totalYears(bank: Bank, now = new Date()): number {
  let months = 0;
  for (const role of bank.roles) {
    const parts = role.dates.split(/\s*(?:-|–|—|\bto\b)\s*/i);
    if (parts.length !== 2) continue;
    const start = toMonths(parts[0], now);
    const end = toMonths(parts[1], now);
    if (start !== null && end !== null && end >= start) months += end - start;
  }
  return Math.round((months / 12) * 10) / 10;
}

const ACTION_WORDS = ["build", "own", "lead", "drive", "work", "collaborate", "design"];

export function allBullets(bank: Bank): Bullet[] {
  return [...bank.roles, ...bank.projects].flatMap((e) => e.bullets);
}

// A short noun phrase without an action word reads as a skill ("kafka", "react native").
function looksLikeSkill(r: string): boolean {
  const words = norm(r).split(" ");
  return words.length <= 3 && !words.some((w) => ACTION_WORDS.some((a) => w.startsWith(a)));
}

// Deterministic match of requirements against bank evidence. `only` limits the
// evidence to these bullet ids (a resume record); default is the whole bank.
// `jobId` applies the user's learnable-skill answers for that JD.
export function scoreRequirements(
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  only?: string[],
  jobId?: string
): ScoreResult {
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const every = allBullets(bank);
  const bullets = only ? every.filter((b) => only.includes(b.id)) : every;
  const have = new Set(extra.skills.filter((s) => s.status === "have").map((s) => norm(s.name)));
  const dontHave = new Set(extra.skills.filter((s) => s.status === "dont_have").map((s) => norm(s.name)));
  const known = new Set([...Object.values(bank.skills).flat(), ...every.flatMap((b) => b.tags)].map(norm));

  const answers = extra.learnable.filter((a) => a.job_id === jobId);
  const learnable = new Set(answers.filter((a) => a.learnable).map((a) => norm(a.skill)));
  const years = totalYears(bank);
  const label = (r: string): { label: Label; ids: string[] } => {
    // Years are judged by the role dates (the hard constraint below).
    const asked = yearsAsked(r);
    if (asked > 0) return { label: years >= asked ? "supported" : "not_demonstrated", ids: [] };
    const rt = terms(r, vocab);
    const ids = bullets
      .filter((b) => b.tags.some((t) => rt.includes(norm(t))) || hasTerm(b.text, r))
      .map((b) => b.id);
    if (ids.length > 0 || (rt.length > 0 && rt.every((t) => have.has(t)))) return { label: "supported", ids };
    if (rt.some((t) => known.has(t))) return { label: "partial", ids };
    if (rt.length === 0 && looksLikeSkill(r)) {
      return { label: learnable.has(norm(r)) ? "learnable" : "not_demonstrated", ids };
    }
    return { label: "unknown", ids };
  };

  const items: ScoreItem[] = [];
  const groups: [Kind, string[]][] = [["must", req.must_have], ["nice", req.nice_to_have], ["keyword", req.keywords]];
  for (const [kind, list] of groups) {
    for (const r of list) {
      const { label: l, ids } = label(r);
      items.push({ requirement: r, kind, label: l, bullet_ids: ids });
    }
  }

  const cov = (kind: Kind): number => {
    const of = items.filter((i) => i.kind === kind);
    if (of.length === 0) return 1;
    const half = (l: Label) => l === "partial" || l === "learnable";
    const got = of.reduce((n, i) => n + (i.label === "supported" ? 1 : half(i.label) ? 0.5 : 0), 0);
    return got / of.length;
  };
  const coverage = { must: cov("must"), nice: cov("nice"), keyword: cov("keyword") };
  const score = WEIGHTS.must * coverage.must + WEIGHTS.nice * coverage.nice + WEIGHTS.keyword * coverage.keyword;

  const yearsAskedMax = Math.max(0, ...req.must_have.map(yearsAsked));
  const hard = { years_asked: yearsAskedMax, years_have: years, pass: years >= yearsAskedMax };
  const rounded = Math.round(score * 10) / 10;
  const band = bandOf(rounded);

  // Ask about each missing skill not answered for this JD; show answers from other JDs.
  const answered = new Set(answers.map((a) => norm(a.skill)));
  const skills = items
    .filter((i) => i.label === "not_demonstrated" && yearsAsked(i.requirement) === 0)
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
    gap: items.some((i) => i.kind === "must" && i.label === "not_demonstrated" && yearsAsked(i.requirement) === 0),
    coverage,
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
  supported: number;
  partial: number;
  learnable: number;
  missing: number;
  ask_user: SkillQuestion[];
};

export function scoreJob(db: Db, jobId: string): ScoreSummary {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first");
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const r = scoreRequirements(req, bank, loadSkillsExtra(), undefined, jobId);
  const count = (l: Label) => r.items.filter((i) => i.label === l).length;
  return {
    job_id: jobId,
    score: r.score,
    band: r.band,
    hard: r.hard,
    tailorable: r.tailorable,
    gap: r.gap,
    supported: count("supported"),
    partial: count("partial"),
    learnable: count("learnable"),
    missing: count("not_demonstrated"),
    ask_user: r.ask_user
  };
}
