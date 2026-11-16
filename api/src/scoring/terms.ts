// Term normalization for deterministic matching of JD wording against the bank.
import { looseSynonyms, skillKey, synonyms } from "../lists.ts";

// Synonyms live in api/config/synonyms.yaml (defaults) and profile/synonyms.yaml (yours).
export { synonyms } from "../lists.ts";

export function norm(s: string): string {
  const t = s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
  return synonyms()[t] ?? looseSynonyms().get(skillKey(t)) ?? t;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matching runs thousands of times per job: the synonym-normalized text and each term's
// pattern are computed once per synonym list (a new list, after an edit, starts over).
let memoFor: Record<string, string> | null = null;
let textMemo = new Map<string, string>();
let termMemo = new Map<string, RegExp | null>();
let synPatterns: [RegExp, string][] = [];
function memo(): void {
  const syn = synonyms();
  if (syn === memoFor) return;
  memoFor = syn;
  textMemo = new Map();
  termMemo = new Map();
  synPatterns = Object.entries(syn).map(([from, to]) => [new RegExp(`(^|[^a-z0-9])${escape(from)}(?=$|[^a-z0-9])`, "g"), to]);
}

// Normalizes synonyms inside a longer phrase, whole words only.
function normText(s: string): string {
  memo();
  let t = textMemo.get(s);
  if (t === undefined) {
    t = norm(s);
    for (const [re, to] of synPatterns) t = t.replace(re, `$1${to}`);
    if (textMemo.size > 50_000) textMemo.clear(); // a long-running server stays bounded
    textMemo.set(s, t);
  }
  return t;
}

export function hasTerm(text: string, term: string): boolean {
  memo();
  let re = termMemo.get(term);
  if (re === undefined) {
    const t = norm(term);
    re = t === "" ? null : new RegExp(`(^|[^a-z0-9])${escape(t)}($|[^a-z0-9])`);
    termMemo.set(term, re);
  }
  return re !== null && re.test(normText(text));
}

// Every vocabulary term that appears in s as a whole word or phrase.
export function terms(s: string, vocab: Set<string>): string[] {
  const found = new Set<string>();
  for (const v of vocab) {
    if (hasTerm(s, v)) found.add(norm(v));
  }
  return [...found];
}
