// Third parse-back reader: OpenResume's resume parser (AGPL-3.0), run from its local copy
// (.scout/openresume-runner, or JOBOPS_OPENRESUME_DIR), never part of JobOps. It splits
// a resume into entries the way many ATS do, by lines and text gaps, so it catches layout
// problems the plain extractors miss (a career break merged into the next job). Its phone
// and location patterns are US-only, so those two fields are not compared.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ResumeData } from "./render.ts";
import type { Issue } from "./parseback.ts";

export type OpenResumeParsed = {
  profile: Record<string, string>;
  workExperiences: { company: string; jobTitle: string; date: string; descriptions: string[] }[];
  educations: { school: string; degree: string; date: string; descriptions: string[] }[];
  skills: { descriptions: string[] };
};

const runnerDir = () => process.env.JOBOPS_OPENRESUME_DIR ?? join(import.meta.dirname, "..", "..", "..", ".scout", "openresume-runner");

export function openResumeAvailable(): boolean {
  return existsSync(join(runnerDir(), "node_modules", ".bin", "tsx"));
}

export function runOpenResume(pdf: string): OpenResumeParsed {
  const dir = runnerDir();
  const r = spawnSync(join(dir, "node_modules", ".bin", "tsx"), ["parse.ts", pdf], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  const json = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).at(-1); // pdf.js prints warnings first
  if (!json) throw new Error(`openresume: ${(r.stderr ?? "").split("\n").filter(Boolean).at(-1) ?? "no output"}`);
  return JSON.parse(json) as OpenResumeParsed;
}

const clean = (s: string) => s.normalize("NFKC").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

// Each entry must come back whole and in order: title, company (with location), dates,
// and every bullet. Details are entry ids and field names, never the text.
export function checkOpenResume(parsed: OpenResumeParsed, data: ResumeData): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, detail: string) => issues.push({ code, extractor: "openresume", detail });
  for (const [k, v] of [["name", data.name], ["email", data.email]] as const) {
    if (v && clean(parsed.profile[k] ?? "") !== clean(v)) add("contact_missing", k);
  }
  const got = parsed.workExperiences;
  if (got.length !== data.experience.length) add("entry_count", `experience: ${got.length} read, ${data.experience.length} written`);
  data.experience.forEach((e, i) => {
    const g = got[i];
    if (!g) return;
    const company = [e.company, e.location].filter(Boolean).join(", ");
    // An entry without a company (a project) is read with its title as the company.
    const [wantTitle, wantCompany] = company ? [e.title, company] : ["", e.title];
    // OpenResume finds titles by job words (engineer, manager): a career break's reason
    // ("Family relocation") is not one, so its title is not compared.
    // It also marks down any title with a digit (to tell titles from dates), so "Engineer 2"
    // reads as no title; lint suggests "II" (title_has_number), the check skips it.
    if (e.kind !== "break" && !/\d/.test(e.title) && clean(g.jobTitle) !== clean(wantTitle)) add("entry_field", `${e.id}.title`);
    if (clean(g.company) !== clean(wantCompany)) add("entry_field", `${e.id}.company`);
    if (clean(g.date) !== clean(e.dates)) add("entry_field", `${e.id}.dates`);
    if (g.descriptions.map(clean).join("\n") !== e.bullets.map(clean).join("\n")) add("entry_field", `${e.id}.bullets`);
  });
  if (parsed.educations.length !== data.education.length) add("entry_count", `education: ${parsed.educations.length} read, ${data.education.length} written`);
  data.education.forEach((e, i) => {
    const g = parsed.educations[i];
    if (!g) return;
    if (clean(g.school) !== clean(e.school)) add("entry_field", `${e.id}.school`);
    if (clean(g.degree) !== clean(e.degree)) add("entry_field", `${e.id}.degree`);
    if (clean(g.date) !== clean(e.dates)) add("entry_field", `${e.id}.dates`);
  });
  const skills = clean(parsed.skills.descriptions.join(", "));
  data.skills.forEach((s, i) => { if (!skills.includes(clean(s))) add("skill_missing", `skill#${i + 1}`); });
  return issues;
}
