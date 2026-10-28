import type { Bank, SkillsExtra } from "../profile/schema.ts";
import type { Requirements } from "../requirements/schema.ts";
import { askable } from "../lists.ts";
import { allBullets, scoreRequirements, totalYears, yearsAsked } from "./score.ts";
import type { Verdicts } from "./score.ts";
import { norm } from "./terms.ts";

export type RiskKind = "must_have" | "years" | "senior_signal" | "impact" | "keywords" | "title_level";
export type Risk = { id: string; kind: RiskKind; detail: string; question: string };

const SENIOR_THEMES = ["leadership", "mentoring", "ownership", "architecture", "scale", "cross-team"];
const HIGH_LEVEL = ["staff", "sde 3", "sde iii", "lead", "principal"];
const SENIOR_TITLES = ["senior", "staff", "lead", "principal", "sde 3", "sde iii"];
const has = (s: string, words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(s.toLowerCase()));

// Why a resume that scores well might still be rejected. Each risk is a
// question for the user. Never includes bullet text: ids and JD words only.
export function riskCheck(
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  selected: string[],
  jobId?: string,
  verdicts: Verdicts = new Map()
): Risk[] {
  const risks: Risk[] = [];
  const score = scoreRequirements(req, bank, extra, selected, jobId, verdicts);
  const chosen = allBullets(bank).filter((b) => selected.includes(b.id));

  for (const item of score.items) {
    // A missing must-have (credit below 0.5, per the engine spec), except learnable ones
    // (not a blocker by user decision) and years (the hard constraint, reported below).
    if (item.kind === "must" && item.credit < 0.5 && item.label !== "learnable" && yearsAsked(item.requirement) === 0) {
      const skill = norm(item.requirement);
      const before = extra.learnable
        .filter((a) => a.skill === skill && a.job_id !== jobId)
        .map((a) => `${a.learnable ? "learnable" : "not learnable"} for job ${a.job_id}`);
      risks.push({
        id: `must:${skill}`,
        kind: "must_have",
        detail: `no evidence for must-have "${item.requirement}"`,
        question:
          `The JD needs ${item.requirement}. Have you used it (where?), or is it a skill you can learn for this role?` +
          (before.length ? ` Earlier answers: ${before.join("; ")}.` : "")
      });
    }
  }

  const asked = Math.max(0, ...req.must_have.map(yearsAsked));
  const total = totalYears(bank);
  if (asked > 0 && total < asked) {
    risks.push({
      id: "years",
      kind: "years",
      detail: `hard constraint: JD asks ${asked}+ years; roles add up to ${total}; not tailorable`,
      question: `The JD asks for ${asked}+ years; your listed roles add up to ${total}. Any earlier experience that counts?`
    });
  }

  for (const word of SENIOR_THEMES) {
    if (!req.themes.some((t) => norm(t).includes(word))) continue;
    if (chosen.some((b) => b.tags.some((t) => norm(t).includes(word)))) continue;
    risks.push({
      id: `theme:${word}`,
      kind: "senior_signal",
      detail: `JD theme "${word}" has no tagged bullet`,
      question: `The JD values ${word}. Give one example where you showed it.`
    });
  }

  if (chosen.length > 0 && chosen.filter((b) => b.impact === "high").length < chosen.length / 2) {
    for (const b of chosen.filter((x) => x.impact === "low")) {
      risks.push({
        id: `impact:${b.id}`,
        kind: "impact",
        detail: `bullet ${b.id} has no measurable result`,
        question: `Bullet ${b.id} has no measurable result. What changed (latency, cost, users, revenue)?`
      });
    }
  }

  if (score.coverage.keyword < 0.6) {
    const missing = score.items
      .filter((i) => i.kind === "keyword" && i.label !== "supported" && yearsAsked(i.requirement) === 0)
      .filter((i) => askable(i.requirement)) // not generic words or soft skills
      .map((i) => i.requirement);
    if (missing.length) risks.push({
      id: "keywords",
      kind: "keywords",
      detail: `keyword coverage ${Math.round(score.coverage.keyword * 100)}%`,
      question: `Have or don't have: ${missing.join(", ")}?`
    });
  }

  const latest = bank.roles[0]?.title ?? "";
  if (has(`${req.seniority} ${req.role}`, HIGH_LEVEL) && !has(latest, SENIOR_TITLES)) {
    risks.push({
      id: "title-level",
      kind: "title_level",
      detail: "role is above the latest title",
      question: "This role is above your latest title. Did you work at that level (owned a system, led a team)? Give one example."
    });
  }

  return risks.filter((r) => !extra.dismissed.includes(r.id));
}
