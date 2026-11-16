import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptName = "one-time-parser" | "parse-job-descripton" | "select-and-tailor";

export const JSON_NOTE = "Return the result as JSON with exactly this structure.";

// The user's prompt files (requierements/<name>.md) are the templates.
export function loadPrompt(name: PromptName): { template: string; version: string } {
  const dir = process.env.JOBOPS_PROMPTS_DIR ?? "requierements";
  const template = readFileSync(join(dir, `${name}.md`), "utf8");
  const version = createHash("sha256").update(template).digest("hex").slice(0, 8);
  return { template, version };
}

// Replaces each "[key]" literally. Other brackets (JSON examples) are left alone.
export function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const marker = `[${key}]`;
    if (!out.includes(marker)) throw new Error(`placeholder ${marker} not in template`);
    out = out.split(marker).join(value);
  }
  return out;
}
