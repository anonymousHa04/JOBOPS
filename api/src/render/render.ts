import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bank, ResumeRecord } from "../profile/schema.ts";
import { parseBack, pdftotext } from "./parseback.ts";
import type { Issue } from "./parseback.ts";

// Record -> PDF (decisions.md: PDF only when applying directly). The record gives the
// content; titles, employers, locations, and dates come from the bank as written (fixed
// fields). The PDF is kept only if the parse-back test passes.

const TEMPLATE = join(import.meta.dirname, "..", "..", "templates", "resume.typ");
export const pdfDir = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "pdf");

// kind: a career break (render data only; the template ignores it, the readers' checks use it).
type Entry = { id: string; title: string; company: string; location: string; dates: string; bullets: string[]; kind?: "break" };
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
  // has the same two lines as a job: "Career break" where the company goes, the reason
  // with the dates where the title goes. Workday reads every entry as a company line then
  // a title line, and drops the words "Career break": with them on the dated line it took
  // the next job's company line instead (tested 2026-10-28; this order keeps every job's
  // fields, and Workday leaves only the break's title for the candidate to fill).
  const entries = (list: Bank["roles"]) => list.filter((e) => byEntry.has(e.id) || e.kind === "break").map((e) => {
    const reason = e.kind === "break" ? e.title.match(/^(.*?)\s*\((.+)\)\s*$/) : null;
    const company = reason ? reason[1] : e.company ?? "";
    const title = reason ? reason[2].charAt(0).toUpperCase() + reason[2].slice(1) : e.title;
    return { id: e.id, title, company, location: e.location ?? "", dates: e.dates, bullets: byEntry.get(e.id) ?? [], ...(reason ? { kind: "break" as const } : {}) };
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
// outDir: where the PDF goes (default profile/pdf); the ATS check's fake resume uses data/ats.
export async function renderRecord(record: ResumeRecord, bank: Bank, opts: { maxPages?: number; paper?: string; outDir?: string } = {}): Promise<RenderResult> {
  const work = mkdtempSync(join(tmpdir(), "jobops-render-"));
  try {
    const data = resumeData(record, bank, opts.paper);
    copyFileSync(TEMPLATE, join(work, "resume.typ"));
    const out = join(work, "resume.pdf");
    const compile = (d: ResumeData): string | null => {
      writeFileSync(join(work, "data.json"), JSON.stringify(d));
      const r = spawnSync("typst", ["compile", "--root", work, join(work, "resume.typ"), out], { encoding: "utf8" });
      if (r.error) return "typst not found (brew install typst)";
      return r.status !== 0 ? `typst failed: ${r.stderr.split("\n")[0]}` : null;
    };
    // A hyphenated word that lands at a line break loses its hyphen in text extraction
    // ("robots.txtaware") or gains a space ("robots.txt- aware"), in some ATS too. Only
    // those words are rendered again with a non-breaking hyphen (U+2011), so they stay
    // whole on one line; every other hyphen stays a plain one.
    let shown = data;
    const kept = new Set<string>();
    let error = compile(shown);
    for (let pass = 0; pass < 3 && !error; pass++) {
      const broken = brokenHyphenWords(pdftotext(out), data).filter((w) => !kept.has(w));
      if (!broken.length) break;
      broken.forEach((w) => kept.add(w));
      shown = noBreak(data, kept);
      error = compile(shown);
    }
    if (error) return { ok: false, path: null, issues: [], error };
    const check = await parseBack(out, data, opts.maxPages ?? 2);
    if (!check.ok) return { ok: false, path: null, issues: check.issues, error: null };
    const dir = opts.outDir ?? pdfDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${record.resume_id}.pdf`);
    copyFileSync(out, path);
    return { ok: true, path, issues: [], error: null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Hyphenated words of the resume that do not come back from the PDF as written: a line
// break at the hyphen made the extractor drop it ("robots.txtaware") or add a space.
export function brokenHyphenWords(extracted: string, data: ResumeData): string[] {
  const texts = [data.summary, ...[...data.experience, ...data.projects].flatMap((e) => e.bullets)];
  const words = [...new Set(texts.flatMap((t) => t.split(/\s+/)).filter((w) => /\w-\w/.test(w)))];
  const flat = extracted.replace(/\s+/g, " ");
  return words.filter((w) => !flat.includes(w.replace(/[.,;:)]+$/, "")));
}

function noBreak(data: ResumeData, words: Set<string>): ResumeData {
  const fix = (t: string) => t.split(" ").map((w) => (words.has(w) ? w.replace(/-/g, "\u2011") : w)).join(" ");
  const entries = (es: ResumeData["experience"]) => es.map((e) => ({ ...e, bullets: e.bullets.map(fix) }));
  return { ...data, summary: fix(data.summary), experience: entries(data.experience), projects: entries(data.projects) };
}

// Pages the record would render to (typst only, no parse-back), or null without typst.
export function pageCount(record: ResumeRecord, bank: Bank, paper = "a4"): number | null {
  const work = mkdtempSync(join(tmpdir(), "jobops-pages-"));
  try {
    copyFileSync(TEMPLATE, join(work, "resume.typ"));
    writeFileSync(join(work, "data.json"), JSON.stringify(resumeData(record, bank, paper)));
    const out = join(work, "resume.pdf");
    const r = spawnSync("typst", ["compile", "--root", work, join(work, "resume.typ"), out], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const info = spawnSync("pdfinfo", [out], { encoding: "utf8" });
    const n = Number(info.stdout?.match(/Pages:\s+(\d+)/)?.[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
