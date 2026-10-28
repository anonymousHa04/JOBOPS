// Hidden characters and AI-sounding wording (config/ai-tells.yaml). Models often emit
// invisible characters (zero-width spaces, joiners, direction marks, tag characters) and
// stock wording; both get resumes flagged. Checks are deterministic and return labels
// only, never the text.
import { aiTells } from "../lists.ts";

// Invisible or formatting-only characters: soft hyphen, Mongolian vowel separator,
// zero-width space/joiners, direction marks and overrides, word joiner and invisible
// operators, BOM, variation selectors, and Unicode tag characters.
const HIDDEN = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿︀-️\u{E0000}-\u{E007F}]/gu;
// Spaces that look like a space but are not one (no-break, thin, em space, ...).
const ODD_SPACE = /[  -   　]/g;

// The hidden characters in a text, as code points ("U+200B"), each once.
export function hiddenChars(text: string): string[] {
  const found = [...(text.match(HIDDEN) ?? []), ...(text.match(ODD_SPACE) ?? [])];
  return [...new Set(found.map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")))];
}

// Removes hidden characters and turns look-alike spaces and curly quotes into plain ones.
export function cleanText(text: string): string {
  return text.replace(HIDDEN, "").replace(ODD_SPACE, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

// AI tells in a text, as short labels ("leveraged", "dash", "rider: ensuring", "not only").
export function aiTellsIn(text: string): string[] {
  const t = aiTells();
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(t.words)) out.add(m[2]);
  for (const m of lower.matchAll(t.phrases)) out.add(m[2]);
  for (const m of lower.matchAll(t.riders)) out.add(`rider: ${m[1]}`);
  // A dash used to join clauses (not a hyphen inside a word, not a date range "2019 – 2021").
  if (/[a-z)]\s*[—]\s*[a-z(]|[a-z)]\s+[–]\s+[a-z(]|\s--\s/i.test(text)) out.add("dash");
  if (/\bnot (only|just)\b[^.]*\bbut\b/i.test(text)) out.add("not only");
  return [...out];
}

// The words and phrases to avoid, for the rewording prompt.
export const tellWords = (): string[] => aiTells().list;
