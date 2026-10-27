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

const cache = new Map<string, { stamp: string; value: unknown }>();
function cached<T>(files: string[], build: () => T): T {
  const key = files.join("|");
  const stamp = files.map((f) => (existsSync(f) ? `${statSync(f).mtimeMs}:${statSync(f).size}` : "-")).join(",");
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = build();
  cache.set(key, { stamp, value });
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
