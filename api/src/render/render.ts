import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bank, ResumeRecord } from "../profile/schema.ts";
import { parseBack } from "./parseback.ts";
import type { Issue } from "./parseback.ts";

// Record -> PDF (decisions.md: PDF only when applying directly). The record gives the
// content; titles, employers, locations, and dates come from the bank as written (fixed
// fields). The PDF is kept only if the parse-back test passes.

const TEMPLATE = join(import.meta.dirname, "..", "..", "templates", "resume.typ");
export const pdfDir = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "pdf");

type Entry = { id: string; title: string; company: string; location: string; dates: string; bullets: string[] };
export type ResumeData = {
  name: string;
  phone: string;
  email: string;
  location: string;
  links: { url: string; text: string }[];
  paper: string;
  summary: string;
  experience: Entry[];
  projects: Entry[];
  education: { id: string; school: string; degree: string; dates: string; details: string[] }[];
  skills: string[];
};

// Shown without the scheme, linked with it: "linkedin.com/in/x" -> https://linkedin.com/in/x.
function link(raw: string): { url: string; text: string } {
  const text = raw.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { url: /^https?:\/\//.test(raw.trim()) ? raw.trim() : `https://${text}`, text };
}

export function resumeData(record: ResumeRecord, bank: Bank, paper = "a4"): ResumeData {
  const byEntry = new Map<string, string[]>();
  for (const b of record.content.bullets) byEntry.set(b.entry_id, [...(byEntry.get(b.entry_id) ?? []), b.text]);
  // Entries in bank order; an entry appears only with at least one bullet in the record.
  // A career break has no bullets and always appears, so the timeline shows no hole. It
  // keeps two lines like every entry ("Career break" + dates, then the reason): a parser
  // that splits entries by their lines (OpenResume) merged a one-line break into the next job.
  const entries = (list: Bank["roles"]) => list.filter((e) => byEntry.has(e.id) || e.kind === "break").map((e) => {
    const reason = e.kind === "break" ? e.title.match(/^(.*?)\s*\((.+)\)\s*$/) : null;
    const title = reason ? reason[1] : e.title;
    const company = reason ? reason[2].charAt(0).toUpperCase() + reason[2].slice(1) : e.company ?? "";
    return { id: e.id, title, company, location: e.location ?? "", dates: e.dates, bullets: byEntry.get(e.id) ?? [] };
  });
  return {
    name: bank.basics.name, phone: bank.basics.phone, email: bank.basics.email, location: bank.basics.location,
    links: bank.basics.links.map(link), paper,
    summary: record.content.summary_text,
    experience: entries(bank.roles),
    projects: entries(bank.projects),
    education: bank.education.map((e) => ({ id: e.id, school: e.school, degree: e.degree, dates: e.dates, details: e.details })),
    skills: record.content.skills
  };
}

export type RenderResult = { ok: boolean; path: string | null; issues: Issue[]; error: string | null };

// Compile in a temp folder (template + data.json only), parse it back, and move the PDF
// into profile/pdf/<resume_id>.pdf only when every check passes.
export async function renderRecord(record: ResumeRecord, bank: Bank, opts: { maxPages?: number; paper?: string } = {}): Promise<RenderResult> {
  const work = mkdtempSync(join(tmpdir(), "jobops-render-"));
  try {
    const data = resumeData(record, bank, opts.paper);
    copyFileSync(TEMPLATE, join(work, "resume.typ"));
    writeFileSync(join(work, "data.json"), JSON.stringify(data));
    const out = join(work, "resume.pdf");
    const r = spawnSync("typst", ["compile", "--root", work, join(work, "resume.typ"), out], { encoding: "utf8" });
    if (r.error) return { ok: false, path: null, issues: [], error: "typst not found (brew install typst)" };
    if (r.status !== 0) return { ok: false, path: null, issues: [], error: `typst failed: ${r.stderr.split("\n")[0]}` };
    const check = await parseBack(out, data, opts.maxPages ?? 2);
    if (!check.ok) return { ok: false, path: null, issues: check.issues, error: null };
    mkdirSync(pdfDir(), { recursive: true });
    const path = join(pdfDir(), `${record.resume_id}.pdf`);
    copyFileSync(out, path);
    return { ok: true, path, issues: [], error: null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
