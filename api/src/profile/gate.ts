// Bank gate: the deterministic checks a bullet must pass to be in the bank. Gaps answers once
// put unsupported bullets in the bank (an unlabeled scale claim, a tool used before it existed,
// model wording, a story pasted from other bullets), and tailor/render trusted them. No model
// calls; the result is reason codes only, never resume text.
import type { Bank, Bullet, SkillsExtra } from "./schema.ts";
import { loadSkillsExtra, vocabulary } from "./bank.ts";
import { checkRewrite } from "../tailor/guard.ts";
import { aiTellsIn } from "../tailor/writing.ts";
import { span } from "../scoring/score.ts";
import { terms } from "../scoring/terms.ts";

// Release month (YYYY-MM) of tools a bullet could not have used before; whole-word match.
const RELEASES: [RegExp, string][] = [
  [/\b(mcps?|model context protocol)\b/i, "2024-11"],
  [/\bchatgpt\b/i, "2022-11"],
  [/\bgpt-4/i, "2023-03"],
  [/\bclaude\b/i, "2023-03"],
  [/\blangchain\b/i, "2022-10"],
  [/\bllamaindex\b/i, "2022-11"],
  [/\bollama\b/i, "2023-07"],
  [/\bllama\b/i, "2023-02"],
  [/\bgithub copilot\b/i, "2021-06"],
  [/\bbun\b/i, "2022-07"]
];

// Words that say what kind of number a big one is (real traffic, a test, or a design goal).
const SCALE_LABEL = /\b(production|load[- ]test(ed|ing)?|simulated|benchmark(ed)?|designed for|design target|target(ed)?|planned|capacity|at peak|peak)\b/i;

const MULT: Record<string, number> = { thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100
};
const WORD_ALT = Object.keys(WORDS).join("|");
// A number not glued to letters ("k8s", "EC2", "p99" are names), with commas grouping
// thousands and an optional scale word or suffix ("1,000,000", "1.5M", "10 million").
// Case matters: only "M" is million; "8b", "14B", "5m", "16k" are model sizes, minutes, context.
const DIGITS = /(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:(M|[Mm]n|[Bb]n)(?![A-Za-z])|\s+([Tt]housand|[Mm]illion|[Bb]illion)\b)?/g;
const WORD_SCALE = new RegExp(`\\b(${WORD_ALT})\\s+(thousand|million|billion)\\b`, "g");
const WORD_ALONE = new RegExp(`\\b(${WORD_ALT})\\b`, "g");
// A bare 1900-2099 is a year (not scale) only with date context around it: a month name,
// a range ("2019-2023", "2019 to 2023"), or "in/since/from/by/until/to/of" before it.
// Otherwise it is a count ("Ran 2000 pods").
const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const YEAR_BEFORE = new RegExp(`(\\b(${MONTH})[a-z]*\\.?,?|\\b(in|since|from|by|until|to|of)|\\b(19|20)\\d\\d\\s*(-|–|—|to))\\s*$`, "i");
const YEAR_AFTER = new RegExp(`^\\s*((${MONTH})[a-z]*\\b|(-|–|—|to)\\s*(19|20)\\d\\d\\b)`, "i");
function isYear(raw: string, before: string, after: string): boolean {
  return /^(19|20)\d\d$/.test(raw) && (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after));
}

// Numbers in a text; `words` also counts number words alone ("five"), which the story may use
// for a digit in the bullet. Bullet text only counts number words with a scale ("one million").
function numbers(text: string, words: boolean): { value: number; year: boolean }[] {
  const t = text.toLowerCase();
  const out: { value: number; year: boolean }[] = [];
  for (const m of text.matchAll(DIGITS)) {
    const base = Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
    const mult = MULT[(m[3] ?? m[4] ?? "").toLowerCase()] ?? 1;
    const year = mult === 1 && !m[2] && isYear(m[1], text.slice(0, m.index), text.slice(m.index + m[0].length));
    out.push({ value: base * mult, year });
  }
  for (const m of t.matchAll(WORD_SCALE)) out.push({ value: WORDS[m[1]] * MULT[m[2]], year: false });
  if (words) for (const m of t.matchAll(WORD_ALONE)) out.push({ value: WORDS[m[1]], year: false });
  return out;
}

const STOP = new Set(["and", "the", "for", "of", "with", "a", "an", "to", "in", "on", "by", "via"]);
const normWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const wordSet = (s: string) => new Set(normWords(s).filter((w) => !STOP.has(w)));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

// Whole-word match with dots and hyphens dropped ("node.js" = "nodejs"; "go" is not in "good").
// A name of 4+ characters also matches with spaces, dots and hyphens anywhere in it
// ("sonar qube" = "sonarqube"), still as whole words ("java" is not in "javascript").
export function names(story: string, name: string): boolean {
  const flat = (x: string) => x.toLowerCase().replace(/[.-]/g, "");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const word = (n: string, s: string) => new RegExp(`(^|[^a-z0-9])${n}(?=$|[^a-z0-9])`).test(s);
  if (word(esc(flat(name)), flat(story))) return true;
  const bare = name.toLowerCase().replace(/[\s.-]/g, "");
  return bare.length >= 4 && word([...bare].map(esc).join("[\\s.-]*"), story.toLowerCase());
}

// A requirement is saved as a skill only when the user's own story names it.
export const storyNames = (story: string, requirement: string) => names(story, requirement.replace(/^experience with /i, ""));

// A Gaps answer's evidence: "answer YYYY-MM-DD: <story>", and for a bullet written as the answer
// to one requirement, "answer YYYY-MM-DD (for: <requirement>): <story>". The date and the
// requirement are not facts of the story (its digits support nothing).
const ANSWER_PREFIX = /^answer \d{4}-\d{2}-\d{2}(?: \(for: ([^)]*)\))?:\s*/;

export function readAnswer(evidence: string): { story: string; answers: string | null } {
  const m = evidence.match(ANSWER_PREFIX);
  return { story: m ? evidence.slice(m[0].length) : evidence, answers: m?.[1]?.trim() || null };
}

export const answerEvidence = (date: string, requirement: string, story: string) =>
  `answer ${date} (for: ${requirement.replace(/[()]/g, " ").replace(/\s+/g, " ").trim()}): ${story}`;

// The terms a bullet answering this requirement may name though the story does not: the
// requirement itself, and the vocabulary terms in it (user, 2026-11-08). The user said "I have
// it" for exactly this ask; any other term the story lacks is still term_added.
export const answerAllows = (requirement: string | null, vocab: Set<string>) =>
  requirement ? [requirement, ...terms(requirement, vocab)] : [];

const toMonths = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

function storyLooksGenerated(story: string): boolean {
  const tells = aiTellsIn(story).filter((x) => x !== "dash");
  const words = tells.filter((x) => !x.startsWith("rider: ") && x !== "not only" && !x.includes(" "));
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const commaRider = words.some((w) => new RegExp(`,\\s*${esc(w)}\\b`, "i").test(story));
  return tells.length > words.length || commaRider || words.length >= 2;
}

export function gateBullet(bank: Bank, entryId: string, text: string, evidence: string | undefined, selfId?: string): string[] {
  const codes: string[] = [];
  // A bullet from the original resume has no story but itself.
  const hasStory = !!evidence?.trim();
  // The answer prefix (date, and the requirement it answers) is not part of the story.
  const answer = hasStory ? readAnswer(evidence!) : { story: text, answers: null };
  const story = answer.story;

  const storyNums = new Set(numbers(story, true).map((n) => n.value));
  const textNums = numbers(text, false);
  if (textNums.some((n) => !storyNums.has(n.value))) codes.push("number_unsupported");
  if (textNums.some((n) => n.value >= 1000 && !n.year) && !SCALE_LABEL.test(text)) codes.push("scale_unlabeled");

  const entry = [...bank.roles, ...bank.projects].find((e) => e.id === entryId);
  let end = entry ? span(entry.dates)?.end : undefined;
  // A bare year as the end ("2019 - 2021") means any month of it: use December.
  if (end !== undefined && /^\d{4}$/.test(entry!.dates.split(/\s*(?:-|–|—|\bto\b)\s*/i).pop()!.trim())) end += 11;
  if (end !== undefined && RELEASES.some(([re, ym]) => re.test(text) && end < toMonths(ym))) codes.push("tech_before_release");

  // The bullet: any tell is model wording. The story is the user's own words: dashes and one
  // listed word used normally ("writing and suggesting code") are how people talk; it reads as
  // model text with a phrase, a rider, a listed word as a comma rider (", indicating ..."), or
  // two or more listed words (user, 2026-11-08: one "suggesting" blocked every draft).
  if (aiTellsIn(text).length || storyLooksGenerated(story)) codes.push("model_wording");

  const others = [...bank.roles, ...bank.projects].flatMap((e) => e.bullets).filter((b) => b.id !== selfId);
  const storyNorm = ` ${normWords(story).join(" ")} `;
  if (others.some((b) => {
    const head = normWords(b.text).slice(0, 8);
    return head.length === 8 && storyNorm.includes(` ${head.join(" ")} `);
  })) codes.push("evidence_copied");
  const mine = wordSet(text);
  if (others.some((b) => jaccard(mine, wordSet(b.text)) >= 0.6)) codes.push("near_duplicate");

  // The rewrite guard, story -> bullet: terms or scope the story does not have. Numbers,
  // length, lead and wording are checked above or are not a bank question.
  if (hasStory) {
    const keep = new Set(["term_added", "scope_raised", "scope_phrase_added"]);
    const vocab = vocabulary(bank, loadSkillsExtra());
    const guard = checkRewrite(story, text, { vocab, allowed: answerAllows(answer.answers, vocab), maxWords: 40 });
    codes.push(...guard.filter((c) => keep.has(c)));
  }
  return codes;
}

// Codes a review waves through: older bullets' short evidence trips these, so a bullet the
// user has read against its evidence (reviewed) is not blocked by them. Unreviewed: they block.
export const REVIEWED_IGNORES = new Set(["term_added", "scope_raised"]);

// The render gate's rule for one bank bullet (render.ts bankGate). The tailor uses it too, so it
// never picks a bullet the render would refuse. Empty: the bullet may be shown.
export const bulletBlocked = (bank: Bank, entryId: string, b: Bullet): string[] =>
  gateBullet(bank, entryId, b.text, b.evidence, b.id).filter((c) => !(b.reviewed && REVIEWED_IGNORES.has(c)));

// Every bank bullet the gate refuses (id -> codes). Scoring and tailoring ask this many times
// per job, so the answer is kept per bank object while the bank and skills-extra are unchanged.
const blockedCache = new WeakMap<Bank, { key: string; map: Map<string, string[]> }>();
export function blockedBullets(bank: Bank): Map<string, string[]> {
  const key = JSON.stringify(bank) + "\0" + JSON.stringify(loadSkillsExtra());
  const hit = blockedCache.get(bank);
  if (hit && hit.key === key) return hit.map;
  const map = new Map<string, string[]>();
  for (const e of [...bank.roles, ...bank.projects]) {
    for (const b of e.bullets) {
      const codes = bulletBlocked(bank, e.id, b);
      if (codes.length) map.set(b.id, codes);
    }
  }
  blockedCache.set(bank, { key, map });
  return map;
}

// Confirmed skills-extra skills that may be listed: not one whose only evidence is a blocked
// bullet. Gaps saves that link as "(used at: <one role>; bullet <id>)"; a skill with more roles
// or its own story stands on the story.
export function listableExtras(bank: Bank, extra: SkillsExtra): SkillsExtra["skills"] {
  const blocked = blockedBullets(bank);
  return extra.skills.filter((s) => {
    const m = s.evidence?.match(/\(used at: [^;()]*; bullet ([^)\s]+)\)\s*$/);
    return !(m && blocked.has(m[1]));
  });
}
