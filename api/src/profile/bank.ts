import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { generate } from "../model/llm.ts";
import { hasTerm } from "../scoring/terms.ts";
import { SKILL_GROUPS, skillGroups, skillKey } from "../lists.ts";
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

// Files each skill in the group api/config/skill-groups.yaml (or your
// profile/skill-groups.yaml, which wins) gives it; unlisted skills stay where they are.
// Returns how many moved.
export function regroupSkills(b: Bank): number {
  const groups = skillGroups();
  const next: Bank["skills"] = { languages: [], frameworks: [], tools: [], domains: [] };
  let moved = 0;
  for (const g of SKILL_GROUPS) {
    for (const s of b.skills[g]) {
      const want = groups.get(skillKey(s)) ?? g;
      if (want !== g) moved++;
      next[want].push(s);
    }
  }
  b.skills = next;
  return moved;
}

// Removes repeated skills: exact and case-only repeats in a group, and a skill already
// listed in an earlier group (languages, frameworks, tools, domains). The first
// spelling is kept. Returns how many were removed.
export function dedupeSkills(b: Bank): number {
  const seen = new Set<string>();
  let removed = 0;
  for (const group of ["languages", "frameworks", "tools", "domains"] as const) {
    b.skills[group] = b.skills[group].filter((s) => {
      const k = s.trim().toLowerCase();
      if (!k || seen.has(k)) { removed++; return false; }
      seen.add(k);
      return true;
    });
  }
  return removed;
}

// A role titled like a career break is one (the model that builds the bank files it as
// a job). Returns the ids it marked.
const BREAK_TITLE = /\b(career break|sabbatical)\b/i;
export function markBreaks(b: Bank): string[] {
  const marked = b.roles.filter((r) => r.kind !== "break" && BREAK_TITLE.test(r.title));
  for (const r of marked) r.kind = "break";
  return marked.map((r) => r.id);
}

// Marks one role as a career break: no company or location, no bullets, an optional
// title the user gives ("Career break (family reasons)"). Dates stay as they are.
export function markBreak(entryId: string, title?: string): { id: string; dates: string } {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const role = bank.roles.find((r) => r.id === entryId);
  if (!role) throw new Error(`unknown role ${entryId}`);
  if (role.bullets.length) throw new Error(`${entryId} has ${role.bullets.length} bullets; a career break has none`);
  role.kind = "break";
  if (title?.trim()) role.title = title.trim();
  delete role.company;
  delete role.location;
  saveBank(bank);
  return { id: role.id, dates: role.dates };
}

// Every save marks career breaks, files skills in the right group, then removes repeats
// (the model can misfile and repeat list items).
export function saveBank(b: Bank): void {
  markBreaks(b);
  regroupSkills(b);
  dedupeSkills(b);
  writeYaml(bankPath(), BankSchema.parse(b));
}

export function bankDedupe(): { moved: number; removed: number } {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const moved = regroupSkills(bank);
  const removed = dedupeSkills(bank);
  if (moved || removed) writeYaml(bankPath(), BankSchema.parse(bank));
  return { moved, removed };
}

export function loadSkillsExtra(): SkillsExtra {
  if (!existsSync(skillsExtraPath())) return { skills: [], dismissed: [], learnable: [] };
  return SkillsExtraSchema.parse(parse(readFileSync(skillsExtraPath(), "utf8")));
}

export function loadPreferences(): Preferences {
  if (!existsSync(preferencesPath())) throw new Error(`no preferences: ${preferencesPath()}`);
  return PreferencesSchema.parse(parse(readFileSync(preferencesPath(), "utf8")));
}

// Edits preferences.yaml in place, keeping its comments, and returns only what it added
// (never the file's content). The result must still match the schema.
function editPreferences(edit: (p: Preferences) => string[]): string[] {
  if (!existsSync(preferencesPath())) throw new Error(`no preferences: ${preferencesPath()}`);
  const doc = parseDocument(readFileSync(preferencesPath(), "utf8"));
  const prefs = PreferencesSchema.parse(doc.toJS());
  const added = edit(prefs);
  if (added.length) {
    doc.set("roles", prefs.roles);
    doc.setIn(["seniority", "exclude"], prefs.seniority.exclude);
    writeFileSync(preferencesPath(), doc.toString());
  }
  return added;
}

// A target role and its aliases ("SDE 3", "SDE III"); an alias already present is skipped.
export function addRole(title: string, aliases: string[]): string[] {
  return editPreferences((p) => {
    const lower = (x: string) => x.trim().toLowerCase();
    const known = new Set(p.roles.flatMap((r) => [r.title, ...r.aliases]).map(lower));
    const names = [title, ...aliases].map((x) => x.trim()).filter((x) => x && !known.has(lower(x)));
    if (!names.length) return [];
    const role = p.roles.find((r) => lower(r.title) === lower(title));
    if (role) role.aliases.push(...names);
    else p.roles.push({ title: names[0], aliases: names.slice(1) });
    return names;
  });
}

// Title words that drop a posting ("staff", "solutions architect").
export function excludeTitleWords(words: string[]): string[] {
  return editPreferences((p) => {
    const known = new Set(p.seniority.exclude.map((w) => w.trim().toLowerCase()));
    const add = [...new Set(words.map((w) => w.trim().toLowerCase()))].filter((w) => w && !known.has(w));
    p.seniority.exclude.push(...add);
    return add;
  });
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
      // Numbers must come from the source: the resume, or the user's answer (evidence).
      if (bullet.source === "user" && !bullet.evidence) issues.push(`${bullet.id}: user bullet without evidence`);
      const source = bullet.source === "user" ? bullet.evidence ?? "" : resumeText;
      for (const n of bullet.text.match(NUMBER) ?? []) {
        if (!source.includes(n)) issues.push(`${bullet.id}: number ${n} not in ${bullet.source === "user" ? "evidence" : "resume"}`);
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
export function addBullet(
  entryId: string,
  text: string,
  tags: string[],
  impact: "high" | "medium" | "low",
  opts: { topic?: string; evidence?: string } = {}
): string {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const entry = [...bank.roles, ...bank.projects].find((e) => e.id === entryId);
  if (!entry) throw new Error(`unknown entry ${entryId}`);
  const used = entry.bullets.map((b) => Number(b.id.slice(entryId.length + 1)) || 0);
  const id = opts.topic ? `${entryId}-${opts.topic}` : `${entryId}-${Math.max(0, ...used) + 1}`;
  if ([...bank.roles, ...bank.projects].some((e) => e.bullets.some((b) => b.id === id))) throw new Error(`bullet ${id} exists`);
  const clean = text.trim().replace(/\s+/g, " ");
  entry.bullets.push({
    id,
    text: clean,
    short: clean.split(" ").slice(0, 15).join(" "),
    tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    impact,
    source: "user",
    ...(opts.evidence ? { evidence: opts.evidence } : {})
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

const RETAG_PROMPT = `List the skills, tools, technologies, and domains this resume bullet names.

Bullet: [bullet]
Tags it already has: [tags]

Rules:
- Only things the bullet itself says, as short lowercase terms (e.g. "kubernetes", "event pipeline").
- Do not infer: no skill or tool the bullet does not mention.
- Up to 8 tags, existing ones included.

Return JSON: {"tags": [...]}`;

// Adds tags to bullets with fewer than 5 (local model, one bullet per call). A suggested
// tag is kept only if the bullet's own text names it (synonyms count): tags are evidence
// in scoring, so an unsupported tag would overstate the fit. Text is never changed.
// Returns bullet ids and counts only.
export async function retagBank(opts: { baseUrl?: string; model?: string } = {}): Promise<{
  retagged: { id: string; before: number; after: number }[]; still_short: string[]; error: string | null;
}> {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  if (bank.approved) throw new Error("bank is approved; edit tags by hand");
  const model = opts.model ?? process.env.JOBOPS_PARSE_MODEL ?? "qwen2.5:14b";
  const schema = z.object({ tags: z.array(z.string()).max(12) });
  const retagged: { id: string; before: number; after: number }[] = [];
  const still_short: string[] = [];
  let error: string | null = null;
  for (const b of [...bank.roles, ...bank.projects].flatMap((e) => e.bullets)) {
    if (b.tags.length >= 5) continue;
    if (!error) {
      const prompt = RETAG_PROMPT.replace("[bullet]", b.text).replace("[tags]", b.tags.join(", "));
      const res = await generate({ model, prompt, schema, timeoutMs: 120000, maxTokens: 200, baseUrl: opts.baseUrl });
      if (!res.ok) error = `${res.error}: ${res.detail}`;
      else {
        const before = b.tags.length;
        for (const t of res.value.tags.map((x) => x.trim().toLowerCase())) {
          if (b.tags.length >= 8) break;
          if (t && !b.tags.includes(t) && hasTerm(b.text, t)) b.tags.push(t);
        }
        if (b.tags.length > before) retagged.push({ id: b.id, before, after: b.tags.length });
      }
    }
    if (b.tags.length < 5) still_short.push(b.id);
  }
  saveBank(bank);
  return { retagged, still_short, error };
}
