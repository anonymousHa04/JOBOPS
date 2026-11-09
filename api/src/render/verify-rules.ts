// Pure rules for the verifier: the model only supplies claims and quotes,
// and code decides from them whether a line or skill is supported.
import type { Issue } from "./parseback.ts";
import { terms } from "../scoring/terms.ts";
import { names } from "../profile/gate.ts";

export type Claim = { claim: string; quote: string };

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function quoteFound(quote: string, source: string): boolean {
  const normalizedQuote = normalizeText(quote);
  return (
    normalizedQuote.length > 0 &&
    normalizedQuote.split(" ").length >= 3 &&
    normalizeText(source).includes(normalizedQuote)
  );
}

function numbers(s: string): string[] {
  return (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map(n => n.replace(/,/g, ""));
}

// Every quote must be in the source. Numbers of the text must be in some quote (the summary
// source has unrelated numbers); vocabulary terms of the text must be in a quote or the source.
export function claimIssues(id: string, text: string, source: string, claims: Claim[], vocab: Set<string>): Issue[] {
  const unsupported = [{ code: "claim_unsupported", extractor: "verifier", detail: id }];
  if (claims.length === 0) return unsupported;

  const quoteNumbers = new Set<string>();
  const knownTerms = new Set<string>(terms(source, vocab));
  for (const claim of claims) {
    if (!quoteFound(claim.quote, source)) return unsupported;
    for (const n of numbers(claim.quote)) quoteNumbers.add(n);
    for (const t of terms(claim.quote, vocab)) knownTerms.add(t);
  }

  if (numbers(text).some(n => !quoteNumbers.has(n))) return unsupported;
  if (terms(text, vocab).some(t => !knownTerms.has(t))) return unsupported;
  return [];
}

// Supported only when the quote is real AND the evidence names the skill: "same as X" quoted
// word for word does not show the skill.
export function skillIssue(index: number, supported: boolean, quote: string, evidence: string, name: string): Issue[] {
  if (supported && quoteFound(quote, evidence) && names(evidence, name.replace(/^experience with /i, ""))) {
    return [];
  }
  return [{ code: "skill_unsupported_model", extractor: "verifier", detail: "skill#" + (index + 1) }];
}

export function linkedBulletIds(evidence: string): string[] {
  const ids = [...evidence.matchAll(/bullet ([a-z0-9-]+)/g)].map(m => m[1]);
  return [...new Set(ids)];
}
