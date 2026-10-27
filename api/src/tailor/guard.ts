import type { Bank } from "../profile/schema.ts";
import { norm, terms } from "../scoring/terms.ts";
import { metricLed } from "./ideal.ts";

// Rewrite guard (engine-algorithm.md §6): a reworded bullet may only say what its source
// says. Every check is deterministic; failures are codes, and only codes are logged.

export type GuardCode =
  | "number_added" | "term_added" | "scope_raised" | "scope_phrase_added" | "too_long"
  | "number_led" | "fixed_field_changed" | "no_output";

// Scope ladder, low -> high (SKILL.md); stems match verb forms (lead/led/leading).
const LADDER = [
  [/\bassist/i, /\bsupport/i, /\bcontribut/i, /\bhelp/i],
  [/\bbuil[td]/i, /\bdevelop/i, /\bimplement/i, /\bwr[io]te/i, /\badd/i, /\bintegrat/i, /\bmigrat/i],
  [/\bdesign/i, /\bown/i, /\bdrove/i, /\bdriv/i],
  [/\blead/i, /\bled\b/i, /\barchitect/i, /\bspearhead/i, /\bhead/i]
];
const SCOPE_PHRASES = /\b(team of \d+|company-wide|org-wide|single-handedly|end-to-end)\b/gi;
const NUMBER = /\d+(?:[.,]\d+)?/g;

function rank(text: string): number {
  let best = -1;
  LADDER.forEach((stems, level) => { if (stems.some((s) => s.test(text))) best = level; });
  return best;
}
const numbers = (s: string) => new Set((s.match(NUMBER) ?? []).map((n) => n.replace(",", ".")));
const phrases = (s: string) => new Set((s.match(SCOPE_PHRASES) ?? []).map((p) => p.toLowerCase()));

// `allowed`: the JD keywords this bullet was marked for (ideal.ts reword marks); the
// bullet already supports them, so naming them is the point of the rewording.
export function checkRewrite(
  source: string,
  rewrite: string,
  opts: { vocab: Set<string>; allowed: string[]; maxWords: number }
): GuardCode[] {
  const codes: GuardCode[] = [];
  const srcNums = numbers(source);
  if ([...numbers(rewrite)].some((n) => !srcNums.has(n))) codes.push("number_added");
  const srcTerms = new Set(terms(source, opts.vocab));
  const allowed = new Set(opts.allowed.map(norm));
  if (terms(rewrite, opts.vocab).some((t) => !srcTerms.has(t) && !allowed.has(t))) codes.push("term_added");
  if (rank(rewrite) > rank(source)) codes.push("scope_raised");
  const srcPhrases = phrases(source);
  if ([...phrases(rewrite)].some((p) => !srcPhrases.has(p))) codes.push("scope_phrase_added");
  if (rewrite.trim().split(/\s+/).length > opts.maxWords) codes.push("too_long");
  // Metric restraint: never restructure a bullet to lead with a number.
  if (metricLed(rewrite) && !metricLed(source)) codes.push("number_led");
  return codes;
}

// Titles, employers, and dates as rendered must byte-match the bank.
export type FixedFields = { entry_id: string; title?: string; company?: string; dates: string };

export function checkFixedFields(bank: Bank, shown: FixedFields[]): { entry_id: string; code: GuardCode; field: string }[] {
  const byId = new Map<string, { title?: string; company?: string; dates: string }>();
  for (const r of bank.roles) byId.set(r.id, { title: r.title, company: r.company, dates: r.dates });
  for (const p of bank.projects) byId.set(p.id, { title: p.title, company: p.company, dates: p.dates });
  const out: { entry_id: string; code: GuardCode; field: string }[] = [];
  for (const s of shown) {
    const bankEntry = byId.get(s.entry_id);
    for (const field of ["title", "company", "dates"] as const) {
      if (!bankEntry || s[field] !== bankEntry[field]) out.push({ entry_id: s.entry_id, code: "fixed_field_changed", field });
    }
  }
  return out;
}

export type GuardResult = {
  text: string;
  outcome: "accepted" | "accepted_on_retry" | "fallback";
  codes: GuardCode[][]; // per attempt
};

// One model attempt, one retry told the failure codes, then the bank text. Never loops.
// `reword` is the model call (prompt 3); it gets the codes of the failed attempt.
export async function guardedReword(
  source: string,
  opts: { vocab: Set<string>; allowed: string[]; maxWords: number },
  reword: (codes: GuardCode[]) => Promise<string | null>
): Promise<GuardResult> {
  const codes: GuardCode[][] = [];
  for (const attempt of [0, 1]) {
    const text = await reword(attempt === 0 ? [] : codes[0]);
    const c: GuardCode[] = text === null ? ["no_output"] : checkRewrite(source, text, opts);
    codes.push(c);
    if (text !== null && c.length === 0) return { text, outcome: attempt === 0 ? "accepted" : "accepted_on_retry", codes };
  }
  return { text: source, outcome: "fallback", codes };
}
