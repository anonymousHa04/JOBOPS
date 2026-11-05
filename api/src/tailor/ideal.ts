import { vocabulary } from "../profile/bank.ts";
import type { Bank, Bullet, Preferences, SkillsExtra } from "../profile/schema.ts";
import type { Requirements } from "../requirements/schema.ts";
import { allBullets, bulletRecency, scoreRequirements } from "../scoring/score.ts";
import type { Verdicts } from "../scoring/score.ts";
import { hasTerm, norm, terms } from "../scoring/terms.ts";
import { softSkills, synonyms } from "../lists.ts";
import { CREDIT, MAX_SKILLS } from "../scoring/config.ts";

// The ideal resume content for one JD (engine-algorithm.md §4, steps 2-4): chosen in
// code, deterministically, from the bank. Rewording happens later and only where this
// marks it; the text here is the bank's (or the starting record's) wording.

export type ContentBullet = {
  id: string;
  entry_id: string;
  text: string;
  // Why the bullet would be reworded: a JD keyword it supports is missing literally.
  reword: null | { alias_only: boolean; keywords: string[] };
};

export type ResumeContent = {
  summary_variant: string;
  summary_text: string;
  bullets: ContentBullet[]; // in resume order: entries in bank order, must-have evidence first
  skills: string[];
};

export type Budget = Preferences["tailoring"];

const IMPACT = { high: 3, medium: 2, low: 1 } as const;
// A bullet that leads with a number (a number within its first three words).
export const metricLed = (text: string) => /^\W*(\S+\s+){0,2}\S*\d/.test(text);

function entryOf(bank: Bank): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of [...bank.roles, ...bank.projects]) for (const b of e.bullets) m.set(b.id, e.id);
  return m;
}

// Words of a JD keyword the bullet supports but does not contain literally.
function missingKeywords(b: Bullet, keywords: string[], vocab: Set<string>): { keywords: string[]; aliasOnly: boolean } {
  const canon = new Set(terms(b.text, vocab));
  for (const t of b.tags) canon.add(norm(t));
  const missing: string[] = [];
  for (const k of keywords) {
    const literal = new RegExp(`(^|[^A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(b.text);
    if (!literal && canon.has(norm(k))) missing.push(k);
  }
  // Alias-only: the bullet already names the same thing by another name (k8s -> Kubernetes).
  const aliasOnly = missing.length > 0 && missing.every((k) => terms(b.text, vocab).includes(norm(k)));
  return { keywords: missing, aliasOnly };
}

// The skills line in the JD's own spelling: a skill the JD names another way ("React JS" for
// the bank's "React") is written as the JD writes it. Only a respelling: never a new skill.
export function jdSpelling(skills: string[], keywords: string[]): string[] {
  const byCanon = new Map<string, string>();
  for (const k of keywords) if (!byCanon.has(norm(k))) byCanon.set(norm(k), k);
  return skills.map((s) => byCanon.get(norm(s)) ?? s);
}

// JD spellings of the candidate's skills that the synonym lists do not have word for word
// (alias -> the skill's usual name), to save for later jobs.
export function newSpellings(keywords: string[], bank: Bank, extra: SkillsExtra): [string, string][] {
  const syn = synonyms();
  const have = new Set([...Object.values(bank.skills).flat(), ...extra.skills.filter((s) => s.status === "have").map((s) => s.name)].map(norm));
  const out = new Map<string, string>();
  for (const k of keywords) {
    const alias = k.trim().toLowerCase().replace(/\s+/g, " ");
    const to = norm(k);
    if (alias !== to && syn[alias] === undefined && have.has(to)) out.set(alias, to);
  }
  return [...out];
}

export function idealContent(
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  budget: Budget,
  opts: { start?: ResumeContent; jobId?: string; verdicts?: Verdicts } = {}
): ResumeContent {
  const bullets = allBullets(bank);
  const entry = entryOf(bank);
  const rec = bulletRecency(bank);
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const scored = scoreRequirements(req, bank, extra, undefined, opts.jobId, opts.verdicts);

  // What each bullet is evidence for (supported or partial).
  const musts = new Map<string, Set<string>>();
  const themes = new Map<string, number>();
  // Requirements that get one covering bullet each: must-haves and soft-skill must-haves.
  const cover = new Map<string, Set<string>>();
  for (const i of scored.items) {
    if (i.credit <= 0 || i.kind === "keyword") continue;
    for (const id of i.bullet_ids) {
      if (i.kind === "must") musts.set(id, (musts.get(id) ?? new Set()).add(i.requirement));
      // A soft-skill must-have is scored as a theme: it ranks as one theme (not also as a
      // must-have), but still gets one bullet that shows it.
      if (i.kind === "must" || i.soft) cover.set(id, (cover.get(id) ?? new Set()).add(i.requirement));
      if (i.kind === "theme") themes.set(id, (themes.get(id) ?? 0) + 1);
    }
  }
  // A bullet's own evidence credit (§3): a measured result earns supported_metric, times
  // its recency. Breaks ties before the id does.
  const credit = (b: Bullet) => (/\d/.test(b.text) ? CREDIT.supported_metric : CREDIT.supported) * (rec.get(b.id) ?? 1);
  // Rank: must-have evidence, then themes, then impact, then evidence credit, then id.
  const rank = [...bullets].sort((a, b) =>
    (musts.get(b.id)?.size ?? 0) - (musts.get(a.id)?.size ?? 0) ||
    (themes.get(b.id) ?? 0) - (themes.get(a.id) ?? 0) ||
    IMPACT[b.impact] - IMPACT[a.impact] ||
    credit(b) - credit(a) ||
    a.id.localeCompare(b.id)
  );

  const chosen: Bullet[] = [];
  const perEntry = new Map<string, number>();
  const metricPerEntry = new Map<string, number>();
  const fits = (b: Bullet) => {
    const e = entry.get(b.id) ?? "";
    return chosen.length < budget.bullets_total &&
      (perEntry.get(e) ?? 0) < budget.bullets_per_role &&
      (!metricLed(b.text) || (metricPerEntry.get(e) ?? 0) < 2) &&
      !chosen.includes(b);
  };
  const take = (b: Bullet) => {
    const e = entry.get(b.id) ?? "";
    chosen.push(b);
    perEntry.set(e, (perEntry.get(e) ?? 0) + 1);
    if (metricLed(b.text)) metricPerEntry.set(e, (metricPerEntry.get(e) ?? 0) + 1);
  };
  // 1. Cover every must-have with its best bullet; 2. fill by rank.
  const covered = new Set<string>();
  for (const b of rank) {
    const adds = [...(cover.get(b.id) ?? [])].filter((r) => !covered.has(r));
    if (adds.length && fits(b)) { take(b); adds.forEach((r) => covered.add(r)); }
  }
  for (const b of rank) if (fits(b)) take(b);
  // 3. Every listed role keeps at least one bullet (swap out the weakest from a role with more).
  for (const role of bank.roles) {
    if (role.bullets.length === 0 || (perEntry.get(role.id) ?? 0) > 0) continue;
    const best = rank.find((b) => entry.get(b.id) === role.id);
    if (!best) continue;
    if (chosen.length >= budget.bullets_total) {
      const drop = [...chosen].reverse().find((b) => (perEntry.get(entry.get(b.id) ?? "") ?? 0) > 1);
      if (!drop) continue;
      chosen.splice(chosen.indexOf(drop), 1);
      const e = entry.get(drop.id) ?? "";
      perEntry.set(e, (perEntry.get(e) ?? 1) - 1);
      if (metricLed(drop.text)) metricPerEntry.set(e, (metricPerEntry.get(e) ?? 1) - 1);
    }
    take(best);
  }

  // Resume order: entries in bank order; inside an entry, by rank (must-have evidence first).
  const order = new Map(rank.map((b, i) => [b.id, i]));
  const entries = [...bank.roles, ...bank.projects].map((e) => e.id);
  const startText = new Map(opts.start?.bullets.map((b) => [b.id, b.text]) ?? []);
  const out: ContentBullet[] = chosen
    .sort((a, b) =>
      entries.indexOf(entry.get(a.id) ?? "") - entries.indexOf(entry.get(b.id) ?? "") ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((b) => {
      // Reuse the starting record's wording for shared ids (§4 step 3).
      const text = startText.get(b.id) ?? b.text;
      const m = missingKeywords({ ...b, text }, req.keywords, vocab);
      return { id: b.id, entry_id: entry.get(b.id) ?? "", text,
        reword: m.keywords.length ? { alias_only: m.aliasOnly, keywords: m.keywords } : null };
    });

  // Skills: supported JD keywords in JD order, then the other skills the chosen bullets
  // show, up to MAX_SKILLS; never soft skills (gaps-and-rejection-risks.md: skills trimmed
  // to evidence; a long unevidenced list reads padded and ATS parsers drop it).
  // Nothing is added beyond the bank and user-confirmed skills.
  const existing = [...new Set([...Object.values(bank.skills).flat(),
    ...extra.skills.filter((s) => s.status === "have").map((s) => s.name)])];
  const byCanon = new Map(existing.map((s) => [norm(s), s]));
  // A JD keyword goes first, in the JD's own spelling, when it is already one of the
  // candidate's skills (literal JD terms for ATS search; nothing new is added).
  const skills: string[] = [];
  for (const k of req.keywords) {
    const c = norm(k);
    if (byCanon.has(c) && !skills.some((s) => norm(s) === c)) skills.push(k);
  }
  const shown = (skill: string) => chosen.some((b) => b.tags.some((t) => norm(t) === norm(skill)) || hasTerm(b.text, skill));
  for (const s of existing) if (!skills.some((x) => norm(x) === norm(s)) && shown(s)) skills.push(s);
  const soft = softSkills().pattern;
  skills.splice(0, skills.length, ...skills.filter((s) => !soft.test(s)).slice(0, MAX_SKILLS));

  // Summary: the bank variant the JD asks for, as written (never reworded).
  const summary = bank.summaries.find((s) => s.variant === req.summary_variant) ?? bank.summaries[0];
  return { summary_variant: summary?.variant ?? "", summary_text: summary?.text ?? "", bullets: out, skills };
}
