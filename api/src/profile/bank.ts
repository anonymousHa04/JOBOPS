import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { generate } from "../model/ollama.ts";
import { fill, JSON_NOTE, loadPrompt } from "../model/prompts.ts";
import { BankSchema, SkillsExtraSchema } from "./schema.ts";
import type { Bank, SkillsExtra } from "./schema.ts";

const profileDir = () => process.env.JOBOPS_PROFILE_DIR ?? "profile";
export const bankPath = () => join(profileDir(), "bank.yaml");
export const skillsExtraPath = () => join(profileDir(), "skills-extra.yaml");
export const resumeTextPath = () => join(profileDir(), "original", "resume.txt");

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
  if (!existsSync(skillsExtraPath())) return { skills: [] };
  return SkillsExtraSchema.parse(parse(readFileSync(skillsExtraPath(), "utf8")));
}

export function saveSkillsExtra(s: SkillsExtra): void {
  writeYaml(skillsExtraPath(), SkillsExtraSchema.parse(s));
}

// One-time parse of the resume text into a bank (local model). Never logs content.
export async function buildBank(): Promise<{ ok: boolean; issues: string[] }> {
  if (loadBank()?.approved) throw new Error("bank is approved; refusing to rebuild it");
  const text = readFileSync(resumeTextPath(), "utf8");
  const { template, version } = loadPrompt("one-time-parser");
  const model = process.env.JOBOPS_PARSE_MODEL ?? "qwen2.5:14b";
  const result = await generate({
    model,
    prompt: fill(template, { "paste text": text }) + "\n" + JSON_NOTE,
    schema: BankSchema.omit({ approved: true, meta: true }),
    timeoutMs: 900000
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
      for (const n of bullet.text.match(NUMBER) ?? []) {
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

export function vocabulary(b: Bank, extra: SkillsExtra): Set<string> {
  const terms = new Set<string>();
  const add = (t: string) => terms.add(t.trim().toLowerCase());
  for (const list of Object.values(b.skills)) list.forEach(add);
  for (const entry of [...b.roles, ...b.projects]) entry.bullets.forEach((bl) => bl.tags.forEach(add));
  extra.skills.filter((s) => s.status === "have").forEach((s) => add(s.name));
  return terms;
}
