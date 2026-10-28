import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// Editable lists: defaults in api/config/*.yaml (committed, generic), the user's additions
// and overrides in profile/*.yaml (git-ignored), which win. A file that does not parse
// is an error naming the file, never silently skipped. Re-read when a file changes, so a
// long-running server (MCP) sees edits without a restart.

const CONFIG = join(import.meta.dirname, "..", "config");
const profileDir = () => process.env.JOBOPS_PROFILE_DIR ?? "profile";

function read<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  try {
    return schema.parse(parse(readFileSync(path, "utf8")) ?? {});
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

// Files are checked for changes at most once a second: matching calls these thousands of
// times per job, and a stat per call made scoring slow. Tests that edit a list set
// JOBOPS_LIST_RECHECK_MS=0 to see the edit on the next call.
const recheckMs = () => Number(process.env.JOBOPS_LIST_RECHECK_MS ?? 1000);
const cache = new Map<string, { stamp: string; value: unknown; checked: number }>();
function cached<T>(files: string[], build: () => T): T {
  const key = files.join("|");
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.checked < recheckMs()) return hit.value as T;
  const stamp = files.map((f) => (existsSync(f) ? `${statSync(f).mtimeMs}:${statSync(f).size}` : "-")).join(",");
  if (hit && hit.stamp === stamp) {
    hit.checked = now;
    return hit.value as T;
  }
  const value = build();
  cache.set(key, { stamp, value, checked: now });
  return value;
}

// alias -> the term it means, lowercase.
export function synonyms(): Record<string, string> {
  const files = [join(CONFIG, "synonyms.yaml"), join(profileDir(), "synonyms.yaml")];
  return cached(files, () => {
    const out: Record<string, string> = {};
    for (const f of files) {
      for (const [k, v] of Object.entries(read(f, z.record(z.string(), z.coerce.string())) ?? {})) {
        out[k.trim().toLowerCase()] = v.trim().toLowerCase();
      }
    }
    return out;
  });
}

export const SKILL_GROUPS = ["languages", "frameworks", "tools", "domains"] as const;
export type SkillGroup = (typeof SKILL_GROUPS)[number];
// "Node.js", "node js", and "nodejs" are one skill.
export const skillKey = (s: string) => s.trim().toLowerCase().replace(/[\s.]/g, "");

const GroupsSchema = z.object({
  languages: z.array(z.coerce.string()).optional(),
  frameworks: z.array(z.coerce.string()).optional(),
  tools: z.array(z.coerce.string()).optional(),
  domains: z.array(z.coerce.string()).optional()
}).strict();

// skill key -> the group it belongs to; the user's file wins over the defaults.
export function skillGroups(): Map<string, SkillGroup> {
  const files = [join(CONFIG, "skill-groups.yaml"), join(profileDir(), "skill-groups.yaml")];
  return cached(files, () => {
    const out = new Map<string, SkillGroup>();
    for (const f of files) {
      const groups = read(f, GroupsSchema) ?? {};
      for (const g of SKILL_GROUPS) for (const s of groups[g] ?? []) out.set(skillKey(s), g);
    }
    return out;
  });
}

const SoftSchema = z.record(z.string(), z.object({
  phrases: z.array(z.coerce.string()),
  shown_by: z.array(z.coerce.string()).default([])
}).strict());

// Whole words, case-insensitive; a hyphen and a space match each other.
function wordsPattern(words: string[]): RegExp {
  const alt = words
    .map((p) => p.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-\s]+/g, "[-\\s]"))
    .filter(Boolean);
  return alt.length ? new RegExp(`(^|[^a-z0-9])(${alt.join("|")})($|[^a-z0-9])`, "i") : /$^/;
}

export type SoftSkills = {
  // Matches JD wording that asks for a soft skill.
  pattern: RegExp;
  // For a requirement, the pattern of bullet words that show it (null if none do).
  shownBy: (requirement: string) => RegExp | null;
};

// Soft-skill groups (soft-skills.yaml); a group in the user's file replaces the default.
export function softSkills(): SoftSkills {
  const files = [join(CONFIG, "soft-skills.yaml"), join(profileDir(), "soft-skills.yaml")];
  return cached(files, () => {
    const groups = Object.values(Object.assign({}, ...files.map((f) => read(f, SoftSchema) ?? {})) as z.infer<typeof SoftSchema>);
    const compiled = groups.map((g) => ({ asks: wordsPattern(g.phrases), shows: g.shown_by }));
    return {
      pattern: wordsPattern(groups.flatMap((g) => g.phrases)),
      shownBy: (r: string) => {
        const words = compiled.filter((g) => g.asks.test(r)).flatMap((g) => g.shows);
        return words.length ? wordsPattern(words) : null;
      }
    };
  });
}

// Terms that are not skills (generic-terms.yaml), normalized like skill keys' words.
export function genericTerms(): Set<string> {
  const files = [join(CONFIG, "generic-terms.yaml"), join(profileDir(), "generic-terms.yaml")];
  return cached(files, () => new Set(files.flatMap((f) => read(f, z.object({ terms: z.array(z.coerce.string()) }).strict())?.terms ?? [])
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, " "))));
}

// A JD term to ask about as a skill: not generic, not a soft skill.
export function askable(term: string): boolean {
  const t = term.trim().toLowerCase().replace(/\s+/g, " ");
  return !genericTerms().has(t) && !softSkills().pattern.test(t);
}

const TellsSchema = z.object({
  words: z.array(z.coerce.string()).default([]),
  phrases: z.array(z.coerce.string()).default([]),
  riders: z.array(z.coerce.string()).default([])
}).strict();

// AI-sounding wording (ai-tells.yaml); the user's lists are added to the defaults.
export function aiTells(): { words: RegExp; phrases: RegExp; riders: RegExp; list: string[] } {
  const files = [join(CONFIG, "ai-tells.yaml"), join(profileDir(), "ai-tells.yaml")];
  return cached(files, () => {
    const lists = files.map((f) => read(f, TellsSchema) ?? { words: [], phrases: [], riders: [] });
    const all = (k: "words" | "phrases" | "riders") => lists.flatMap((l) => l[k]);
    const alt = (xs: string[]) => xs.map((p) => p.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|") || "$^";
    return {
      words: new RegExp(`(^|[^a-z0-9-])(${alt(all("words"))})(?=$|[^a-z0-9-])`, "g"),
      phrases: new RegExp(`(^|[^a-z0-9])(${alt(all("phrases"))})(?=$|[^a-z0-9])`, "g"),
      riders: new RegExp(`,\\s*(${alt(all("riders"))})\\b`, "g"),
      list: [...all("words"), ...all("phrases")]
    };
  });
}

// Senior signals (senior-signals.yaml): signal -> pattern of the bullet words that show it.
export function seniorSignals(): Map<string, RegExp> {
  const files = [join(CONFIG, "senior-signals.yaml"), join(profileDir(), "senior-signals.yaml")];
  return cached(files, () => {
    const merged = Object.assign({}, ...files.map((f) => read(f, z.record(z.string(), z.array(z.coerce.string()))) ?? {})) as Record<string, string[]>;
    const out = new Map<string, RegExp>();
    for (const [signal, words] of Object.entries(merged)) {
      const alt = words.map((w) => w.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/#/g, "\\d[\\d,.]*\\+?").replace(/[-\s]+/g, "[-\\s]")).filter(Boolean);
      out.set(signal.toLowerCase(), alt.length ? new RegExp(`(^|[^a-z0-9])(${alt.join("|")})($|[^a-z0-9])`, "i") : /$^/);
    }
    return out;
  });
}
