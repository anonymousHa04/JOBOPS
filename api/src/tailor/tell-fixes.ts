// Plain replacements for AI-tell wording (config/ai-tells.yaml), offered next to a rejected
// draft so the user can fix it in one click. A fixed list, not a model: it works where the
// model failed twice. Each fix returns the whole new text; the guard checks it again on save.

// Words: plain alternatives. "" means drop the word (an empty intensifier).
const WORDS: Record<string, string[]> = {
  leverage: ["use"], leveraged: ["used"], leveraging: ["using"],
  utilize: ["use"], utilized: ["used"], utilizing: ["using"],
  spearheaded: ["led", "started"], orchestrated: ["coordinated", "ran"],
  enhance: ["improve"], enhanced: ["improved"],
  foster: ["build"], fostered: ["built"], fostering: ["building"],
  showcase: ["show"], showcased: ["showed"], showcasing: ["showing"],
  underscore: ["show"], underscored: ["showed"],
  garnered: ["got", "earned"], bolstered: ["strengthened"],
  delve: ["look into"], delved: ["looked into"],
  demonstrated: ["showed"], demonstrating: ["showing"],
  seamless: [""], seamlessly: [""], robust: [""], meticulous: ["careful"], meticulously: ["carefully"],
  crucial: ["key"], pivotal: ["key"], innovative: [""], dynamic: [""], holistic: [""],
  transformative: [""], groundbreaking: [""], "cutting-edge": [""], "state-of-the-art": [""],
  "world-class": [""], "best-in-class": [""], intricate: ["complex"], profound: [""],
};

// Phrases: plain alternatives ("" drops it).
const PHRASES: Record<string, string[]> = {
  "in order to": ["to"], "a wide range of": ["many"], "a diverse array": ["many"],
  "played a key role": ["helped"], "plays a key role": ["helps"],
  "proven track record": ["record"], "associated with": ["for"], "in connection with": ["for"],
  "drive innovation": ["build new features"], "at the forefront of": ["leading"],
};

// Riders (", ensuring X"): a plain join that stays grammatical ("to keep X"), or drop the clause.
const RIDERS: Record<string, string[]> = {
  ensuring: ["to keep"], enabling: ["for"], "resulting in": ["for"], driving: ["for"],
  highlighting: [], showcasing: [], underscoring: [], reflecting: [], fostering: [], empowering: ["helping"],
  "contributing to": ["for"],
};

export type TellFix = { word: string; label: string; text: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[- ]");
const tidy = (s: string) => s.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^\s*([a-z])/, (_, c: string) => c.toUpperCase()).trim();
const keepCase = (orig: string, rep: string) => (/^[A-Z]/.test(orig) && rep ? rep[0].toUpperCase() + rep.slice(1) : rep);

// words: the flagged words of a draft (draftBullet's `words`, riders without "rider: ").
// One entry per replacement that changes the text; unknown words get none.
export function tellFixes(text: string, words: string[]): TellFix[] {
  const out: TellFix[] = [];
  const push = (word: string, label: string, next: string) => {
    const t = tidy(next);
    if (t && t !== text && !out.some((f) => f.text === t)) out.push({ word, label, text: t });
  };
  for (const raw of words) {
    const w = raw.toLowerCase().replace(/^rider: /, "");
    // A rider after a comma: ", ensuring X" -> " to keep X", or drop ", ensuring X".
    if (RIDERS[w]) {
      const re = new RegExp(`,\\s*${esc(w)}\\b([^.;]*)`, "i");
      const m = text.match(re);
      if (m) {
        for (const r of RIDERS[w]) {
          if (r) push(raw, `${w} → ${r}`, text.replace(re, ` ${r}$1`));
        }
        push(raw, `drop ", ${w} …"`, text.replace(re, ""));
        continue;
      }
    }
    const opts = WORDS[w] ?? PHRASES[w];
    if (!opts) continue;
    const re = new RegExp(`\\b${esc(w)}\\b`, "gi");
    for (const r of opts) {
      push(raw, r ? `${w} → ${r}` : `drop "${w}"`, text.replace(re, (m) => keepCase(m, r)));
    }
  }
  return out;
}

// The AI-tell words a text adds over the user's own story (the story's own words are theirs),
// and their fixes: what the draft box shows again after each applied fix.
export function draftTellFixes(text: string, story: string, tellsIn: (s: string) => string[]): { words: string[]; fixes: TellFix[] } {
  const own = new Set(tellsIn(story));
  const words = tellsIn(text).filter((w) => !own.has(w) && w !== "dash" && w !== "not only").map((w) => w.replace(/^rider: /, ""));
  return { words, fixes: tellFixes(text, words) };
}
