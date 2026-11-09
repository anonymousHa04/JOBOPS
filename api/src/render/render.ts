import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bank, ResumeRecord, SkillsExtra } from "../profile/schema.ts";
import { bulletBlocked } from "../profile/gate.ts";
export { REVIEWED_IGNORES } from "../profile/gate.ts";
import { parseBack, pdftotext, requiredReaders } from "./parseback.ts";
import type { Issue } from "./parseback.ts";
import { exitIssues } from "./exit-gate.ts";
import { openFactFlags } from "../extension/reports.ts";
import { loadSkillsExtra } from "../profile/bank.ts";
import { reviewRefs } from "./verify-approvals.ts";
import type { VerifyKind } from "./verify-approvals.ts";

// Record -> PDF (decisions.md: PDF only when applying directly). The record gives the
// content; titles, employers, locations, and dates come from the bank as written (fixed
// fields). The PDF is kept only if the parse-back test passes.

const TEMPLATE = join(import.meta.dirname, "..", "..", "templates", "resume.typ");
export const pdfDir = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "pdf");

// client: the "(Client: Y)" part of a bank company, printed on its own line (splitClient).
type Entry = { id: string; title: string; company: string; location: string; dates: string; bullets: string[]; client?: string };
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

// "X (Client: Y)" -> company X, client Y; any other company is unchanged. iCIMS took a client
// in the company line as the employer; on its own line every employer was read right.
export function splitClient(company: string): { company: string; client?: string } {
  const m = company.match(/^(.*?)\s*\(\s*client:\s*(.+?)\s*\)\s*$/i);
  return m ? { company: m[1], client: m[2] } : { company };
}

export function resumeData(record: ResumeRecord, bank: Bank, paper = "a4"): ResumeData {
  const byEntry = new Map<string, string[]>();
  for (const b of record.content.bullets) byEntry.set(b.entry_id, [...(byEntry.get(b.entry_id) ?? []), b.text]);
  // Entries in bank order; an entry appears only with at least one bullet in the record.
  // Career breaks stay in the bank but are left off: iCIMS keeps at most 5 dated entries, so
  // a break pushed a real job out (2026-11-08); the gap shows on the timeline. A client goes
  // on its own line (splitClient), so the company line holds only the employer.
  const entries = (list: Bank["roles"]) => list.filter((e) => byEntry.has(e.id) && e.kind !== "break").map((e) => {
    const { company, client } = splitClient(e.company ?? "");
    return { id: e.id, title: e.title, company, location: e.location ?? "", dates: e.dates, bullets: byEntry.get(e.id) ?? [], ...(client ? { client } : {}) };
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

// The bank gate on a record's bullets, checked on the BANK bullet (its text and evidence):
// one bank_gate issue per failing bullet, "<id>: <codes>" (an id not in the bank: not_in_bank),
// and "role_dropped: <entry id>" per job with bank bullets but none in the record.
export function bankGate(record: ResumeRecord, bank: Bank): Issue[] {
  const gate: Issue[] = [];
  for (const rb of record.content.bullets) {
    const e = [...bank.roles, ...bank.projects].find((x) => x.bullets.some((b) => b.id === rb.id));
    const b = e?.bullets.find((x) => x.id === rb.id);
    const codes = e && b ? bulletBlocked(bank, e.id, b) : ["not_in_bank"];
    if (codes.length) gate.push({ code: "bank_gate", extractor: "gate", detail: `${rb.id}: ${codes.join(",")}` });
  }
  // A job with bullets in the bank but none on the resume would leave a hole in the timeline:
  // blocked, not left off. Career breaks and projects may be left off.
  const shown = new Set(record.content.bullets.map((b) => b.entry_id));
  for (const role of bank.roles) {
    if (role.kind !== "break" && role.bullets.length > 0 && !shown.has(role.id)) {
      gate.push({ code: "bank_gate", extractor: "gate", detail: `role_dropped: ${role.id}` });
    }
  }
  return gate;
}

// review: the verifier items the user can approve (send to review, A3); the PDF waits for them.
export type RenderResult = { ok: boolean; path: string | null; issues: Issue[]; error: string | null; checks: { name: string; ran: boolean; ok: boolean; codes: string[] }[];
  review?: { kind: VerifyKind; id: string; code: string }[] };

// Compile in a temp folder (template + data.json only), parse it back, and move the PDF
// into profile/pdf/<resume_id>.pdf only when every check passes.
// outDir: where the PDF goes (default profile/pdf); the ATS check's fake resume uses data/ats.
export async function renderRecord(record: ResumeRecord, bank: Bank, opts: { maxPages?: number; paper?: string; outDir?: string; extra?: SkillsExtra; verifyIssues?: Issue[] } = {}): Promise<RenderResult> {
  const dir = opts.outDir ?? pdfDir();
  const verifyOn = process.env.JOBOPS_VERIFY === "on";
  // The verifier's last result (codes and ids) is kept with the checks, so the review list
  // (Tailor box, verify approve) is read without calling the model again.
  const verifierIssues = verifyOn && opts.verifyIssues ? { verifier_issues: opts.verifyIssues } : {};
  const writeChecks = (checks: RenderResult["checks"]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${record.resume_id}.checks.json`), JSON.stringify({ resume_id: record.resume_id, at: new Date().toISOString(), checks, ...verifierIssues }, null, 2));
    return checks;
  };
  // Output gate (bank gate + exit gate): a failing record gets no PDF, and an older PDF of it is removed.
  const extra = opts.extra ?? loadSkillsExtra();
  const flags = record.jd_id ? openFactFlags(record.jd_id, record.content.bullets.map((b) => b.id)) : [];
  const bankIssues = bankGate(record, bank);
  const exit = exitIssues(record, bank, extra, flags);
  // The verifier (K1) is part of the gate only with JOBOPS_VERIFY=on; a render without a
  // verifier result then has its "verifier" check not run, so its PDF is not served.
  const verify = verifyOn ? opts.verifyIssues ?? [] : [];
  const gate = [...bankIssues, ...exit, ...verify];
  // Which checks ran and what each found; parse-back issues grouped by extractor.
  // back null: parse-back did not run, so its five checks did not run.
  const checkList = (back: Issue[] | null): RenderResult["checks"] => {
  const readers = requiredReaders();
    const c = (name: string, ran: boolean, codes: string[]) => ({ name, ran, ok: ran && codes.length === 0, codes });
    const by = (...ex: string[]) => (back ?? []).filter((i) => ex.includes(i.extractor)).map((i) => i.code);
    const or = by("openresume");
    return [
      c("bank_gate", true, bankIssues.map((i) => i.code)),
      c("exit_gate", true, exit.map((i) => i.code)),
      ...(verifyOn ? [c("verifier", opts.verifyIssues !== undefined, verify.map((i) => i.code))] : []),
      c("layout", back !== null, by("layout")),
      c("pages_fonts", back !== null, by("pdfinfo", "pdffonts")),
      c("pdftotext", back !== null && readers.includes("pdftotext"), by("pdftotext")),
      c("pdfjs", back !== null && readers.includes("pdfjs"), by("pdfjs")),
      c("openresume", back !== null && readers.includes("openresume") && !or.includes("reader_missing"), or)
    ];
  };
  if (gate.length) {
    rmSync(join(dir, `${record.resume_id}.pdf`), { force: true });
    const review = reviewRefs(verify, record);
    return { ok: false, path: null, issues: gate, error: null, checks: writeChecks(checkList(null)), ...(review.length ? { review } : {}) };
  }
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
    // A typst error writes no checks file: nothing was checked.
    if (error) return { ok: false, path: null, issues: [], error, checks: checkList(null) };
    const check = await parseBack(out, data, opts.maxPages ?? 2);
    const checks = writeChecks(checkList(check.issues));
    if (!check.ok) return { ok: false, path: null, issues: check.issues, error: null, checks };
    const path = join(dir, `${record.resume_id}.pdf`);
    copyFileSync(out, path);
    return { ok: true, path, issues: [], error: null, checks };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The PDF route serves a PDF only when every check ran and passed: a missing or unreadable
// checks file, or an empty list, counts as not passed.
export function pdfChecksPassed(resumeId: string, dir: string = pdfDir()): boolean {
  const file = join(dir, `${resumeId}.checks.json`);
  if (!existsSync(file)) return false;
  try {
    const { checks } = JSON.parse(readFileSync(file, "utf8")) as { checks?: { ran?: unknown; ok?: unknown }[] };
    return Array.isArray(checks) && checks.length > 0 && checks.every((c) => c?.ran === true && c?.ok === true);
  } catch {
    return false;
  }
}

// The verifier issues the last render of a resume kept in its checks file; null when that render
// had no verifier result (JOBOPS_VERIFY off, no checks file, or an older file).
export function lastVerifierIssues(resumeId: string, dir: string = pdfDir()): Issue[] | null {
  const file = join(dir, `${resumeId}.checks.json`);
  if (!existsSync(file)) return null;
  try {
    const { verifier_issues } = JSON.parse(readFileSync(file, "utf8")) as { verifier_issues?: Issue[] };
    return Array.isArray(verifier_issues) ? verifier_issues : null;
  } catch {
    return null;
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
