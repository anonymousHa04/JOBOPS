import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { generate } from "../model/llm.ts";
import { fill, JSON_NOTE, loadPrompt } from "../model/prompts.ts";
import { z } from "zod";
import { BankSchema, BulletSchema, EntrySchema, PreferencesSchema, SkillsExtraSchema } from "./schema.ts";
import type { Bank, Preferences, SkillsExtra } from "./schema.ts";

const profileDir = () => process.env.JOBOPS_PROFILE_DIR ?? "profile";
export const bankPath = () => join(profileDir(), "bank.yaml");
export const skillsExtraPath = () => join(profileDir(), "skills-extra.yaml");
export const resumeTextPath = () => join(profileDir(), "original", "resume.txt");
export const preferencesPath = () => join(profileDir(), "preferences.yaml");

const NUMBER = /\d+(?:[.,]\d+)?%?/g;

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(value));
}

export function loadBank(): Bank | null {
  if (!existsSync(bankPath())) return null;
  return BankSchema.parse(parse(readFileSync(bankPath(), "utf8")));
}

export function saveBank(b: Bank): void {
  writeYaml(bankPath(), BankSchema.parse(b));
}

export function loadSkillsExtra(): SkillsExtra {
  if (!existsSync(skillsExtraPath())) return { skills: [], dismissed: [], learnable: [] };
  return SkillsExtraSchema.parse(parse(readFileSync(skillsExtraPath(), "utf8")));
}

export function loadPreferences(): Preferences {
  if (!existsSync(preferencesPath())) throw new Error(`no preferences: ${preferencesPath()}`);
  return PreferencesSchema.parse(parse(readFileSync(preferencesPath(), "utf8")));
}

export function saveSkillsExtra(s: SkillsExtra): void {
  writeYaml(skillsExtraPath(), SkillsExtraSchema.parse(s));
}

// What the model may produce in a bank build: the bank shape with every list capped.
// The caps are generous for any real resume; the server enforces them while generating,
// so the model cannot loop on a list. They apply to the build only, not to later edits.
const capped = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max);
const BuildEntrySchema = EntrySchema.extend({ bullets: capped(BulletSchema, 15) });
const BuildSchema = BankSchema.omit({ approved: true, meta: true }).extend({
  basics: BankSchema.shape.basics.extend({ links: capped(z.string(), 8) }),
  summaries: capped(BankSchema.shape.summaries.element, 6),
  roles: capped(BuildEntrySchema, 15),
  projects: capped(BuildEntrySchema, 15),
  education: capped(BankSchema.shape.education.element.extend({ details: capped(z.string(), 8) }), 6),
  skills: z.object({
    languages: capped(z.string(), 40), frameworks: capped(z.string(), 40),
    tools: capped(z.string(), 40), domains: capped(z.string(), 40)
  })
});

// One-time parse of the resume text into a bank (local model). Never logs content.
export async function buildBank(): Promise<{ ok: boolean; issues: string[] }> {
  if (loadBank()?.approved) throw new Error("bank is approved; refusing to rebuild it");
  const text = readFileSync(resumeTextPath(), "utf8");
  const { template, version } = loadPrompt("one-time-parser");
  const model = process.env.JOBOPS_PARSE_MODEL ?? "qwen2.5:14b";
  const result = await generate({
    model,
    prompt: fill(template, { "paste text": text }) + "\n" + JSON_NOTE,
    schema: BuildSchema,
    timeoutMs: 900000,
    maxTokens: 8000
  });
  if (!result.ok) return { ok: false, issues: [`model: ${result.error} (${result.detail})`] };
  const bank: Bank = {
    ...result.value,
    approved: false,
    meta: { model, prompt_version: version, created_at: new Date().toISOString() }
  };
  saveBank(bank);
  return { ok: true, issues: checkBank(bank, text) };
}

// Issues are "<bullet-id>: <problem>" and never include bullet text.
export function checkBank(b: Bank, resumeText: string): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...b.roles, ...b.projects]) {
    for (const bullet of entry.bullets) {
      if (seen.has(bullet.id)) issues.push(`${bullet.id}: duplicate id`);
      seen.add(bullet.id);
      if (!bullet.id.startsWith(`${entry.id}-`)) issues.push(`${bullet.id}: id not prefixed by ${entry.id}`);
      // User-added bullets are not in the resume text; the user vouches for them.
      for (const n of bullet.source === "user" ? [] : bullet.text.match(NUMBER) ?? []) {
        if (!resumeText.includes(n)) issues.push(`${bullet.id}: number ${n} not in resume`);
      }
      if (bullet.short.split(/\s+/).filter(Boolean).length > 15) issues.push(`${bullet.id}: short over 15 words`);
      if (bullet.tags.length < 5 || bullet.tags.length > 8) issues.push(`${bullet.id}: ${bullet.tags.length} tags (want 5-8)`);
    }
  }
  return issues;
}

export function addSkill(name: string, status: "have" | "dont_have", evidence: string): void {
  const extra = loadSkillsExtra();
  const key = name.trim().toLowerCase();
  extra.skills = extra.skills.filter((s) => s.name !== key);
  extra.skills.push({ name: key, status, evidence, added_at: new Date().toISOString() });
  saveSkillsExtra(extra);
}

// Adds a user-written bullet to a role or project; returns its new id.
export function addBullet(entryId: string, text: string, tags: string[], impact: "high" | "medium" | "low"): string {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const entry = [...bank.roles, ...bank.projects].find((e) => e.id === entryId);
  if (!entry) throw new Error(`unknown entry ${entryId}`);
  const used = entry.bullets.map((b) => Number(b.id.slice(entryId.length + 1)) || 0);
  const id = `${entryId}-${Math.max(0, ...used) + 1}`;
  const clean = text.trim().replace(/\s+/g, " ");
  entry.bullets.push({
    id,
    text: clean,
    short: clean.split(" ").slice(0, 15).join(" "),
    tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    impact,
    source: "user"
  });
  saveBank(bank);
  return id;
}

// Stops a risk question from being asked again.
export function dismissRisk(id: string): void {
  const extra = loadSkillsExtra();
  if (!extra.dismissed.includes(id)) extra.dismissed.push(id);
  saveSkillsExtra(extra);
}

// Records the user's answer to "is <skill> learnable for this JD?". Answers are
// per JD: the same skill is asked again for another JD, with earlier answers shown.
export function recordLearnable(skill: string, learnable: boolean, jobId: string): void {
  const extra = loadSkillsExtra();
  const key = skill.trim().toLowerCase();
  extra.learnable = extra.learnable.filter((a) => !(a.skill === key && a.job_id === jobId));
  extra.learnable.push({ skill: key, learnable, job_id: jobId, answered_at: new Date().toISOString() });
  saveSkillsExtra(extra);
}

export function vocabulary(b: Bank, extra: SkillsExtra): Set<string> {
  const terms = new Set<string>();
  const add = (t: string) => terms.add(t.trim().toLowerCase());
  for (const list of Object.values(b.skills)) list.forEach(add);
  for (const entry of [...b.roles, ...b.projects]) entry.bullets.forEach((bl) => bl.tags.forEach(add));
  extra.skills.filter((s) => s.status === "have").forEach((s) => add(s.name));
  return terms;
}
