// What a site's resume autofill should show for the fake resume, and the comparison with
// what it did show (filled in by hand after an upload test; ats compare <file>).
// Fake data only: this module never sees the real bank.
//
// Saved reports live in data/ats/ (git-ignored), so their shapes are written down here:
// - Workday: data/ats/autofill-<host>-<ms>.json, written by `ats compare` from a Reported
//   file: { reported: Reported, expected: Expected, mismatches: Mismatch[] }.
// - iCIMS: data/ats/icims-<YYYY-MM-DD>.json, a copy of data/ats/icims-TEMPLATE.json filled in
//   by hand from the iCIMS form after uploading the FAKE resume (agents never submit):
//   {
//     "site": "icims",
//     "site_url": "<host and path of the apply page>",          (optional)
//     "uploaded": "YYYY-MM-DD",
//     "entries": [                                              (in the form's order; iCIMS keeps at most 5)
//       { "employer": "Acme Software", "title": "Senior Software Engineer",
//         "start": "01/2018", "end": "",                        (empty when current; MM/YYYY or "Jan 2018")
//         "description": "<the first words of the description box>" }
//     ],
//     "education": [ { "school": "", "degree": "" } ],          (iCIMS never fills it: "fill by hand")
//     "linkedin": ""                                            (same)
//   }
// `ats references` re-runs every saved report against today's fake resume (read-only).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBank, fakeRecord } from "./fake-resume.ts";
import { resumeData, splitClient } from "./render.ts";
import type { ResumeData } from "./render.ts";

export type Expected = {
  name: string; email: string; phone: string; phone_country: string;
  experience: { job_title: string; company: string; location: string; current: boolean; from: string; to: string; description: string[] }[];
  education: { school: string; degree: string; field: string; from: string; to: string }[];
  skills: string[];
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "Jan 2018" -> "01/2018"; "01/2018" -> "01/2018"; "2014" -> "2014"; "Present" -> "".
function mmYyyy(s: string): string {
  const t = s.trim().toLowerCase();
  const m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m) return `${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}/${m[2]}`;
  const n = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (n) return `${n[1].padStart(2, "0")}/${n[2]}`;
  return /^\d{4}$/.test(t) ? t : "";
}
const sides = (dates: string) => dates.split(/\s*(?:-|–|—|\bto\b)\s*/i);

// The fake resume's render data; `data` lets a caller (ats references, tests) pass other data.
const fakeData = () => resumeData(fakeRecord(), fakeBank);

export function expected(data: ResumeData = fakeData()): Expected {
  // "BTech in Mechanical Engineering" or "Bachelor of Technology, Computer Science".
  const [degree, field = ""] = (data.education[0]?.degree ?? "").split(/\s+in\s+|\s*,\s*/);
  return {
    name: data.name, email: data.email, phone: data.phone, phone_country: "India (+91)",
    experience: data.experience.map((e) => {
      const [from, to = ""] = sides(e.dates);
      return { job_title: e.title, company: e.company, location: e.location, current: /present|current/i.test(to),
        from: mmYyyy(from), to: mmYyyy(to), description: e.bullets };
    }),
    education: data.education.map((e) => {
      const [from, to = ""] = sides(e.dates);
      return { school: e.school, degree, field, from: mmYyyy(from), to: mmYyyy(to) };
    }),
    skills: data.skills
  };
}

export type Reported = {
  site_url: string;
  information: { given_name?: string; family_name?: string; email?: string; phone?: string; phone_country?: string; errors?: string[] };
  experience: { job_title?: string; company?: string; location?: string; current?: boolean; from?: string; to?: string; description?: string }[];
  education: { school?: string; degree?: string; field?: string; from?: string; to?: string }[];
  skills: string[];
};

// iCIMS (findings 2026-11-08, m3-notes gaps-and-rejection-risks.md): per dated entry the
// employer, title, dates and the start of the description; Education and LinkedIn never fill.
export type IcimsReported = {
  site: "icims";
  site_url?: string;
  uploaded?: string;
  entries: { employer?: string; title?: string; start?: string; end?: string; description?: string }[];
  education?: { school?: string; degree?: string }[];
  linkedin?: string;
};
export type IcimsExpected = { entries: { employer: string; title: string; start: string; end: string; current: boolean; description: string }[] };
export const ICIMS_MAX_ENTRIES = 5;

// Dated entries in resume order: jobs, then projects with dates. The employer is the company
// without "(Client: ...)" (resumeData already splits it; splitClient again in case).
export function icimsExpected(data: ResumeData = fakeData()): IcimsExpected {
  return {
    entries: [...data.experience, ...data.projects].filter((e) => e.dates.trim()).map((e) => {
      const [from, to = ""] = sides(e.dates);
      return { employer: splitClient(e.company).company, title: e.title, start: mmYyyy(from), end: mmYyyy(to),
        current: /present|current/i.test(to), description: e.bullets.join(" ") };
    })
  };
}

const clean = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[•·]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const sameDate = (a: string | undefined, b: string) => clean(a).replace(/^0/, "") === clean(b).replace(/^0/, "");

export type Mismatch = { field: string; filled: string; expected: string };
export type Warning = { field: string; detail: string };
export type Comparison = { site: string; mismatches: Mismatch[]; warnings: Warning[]; fill_by_hand: string[]; errors: string[] };

// Workday: field-by-field comparison (pure).
export function compareWorkday(r: Reported, want: Expected = expected()): Mismatch[] {
  const out: Mismatch[] = [];
  const check = (field: string, filled: string | undefined, exp: string, ok = clean(filled) === clean(exp)) => {
    if (!ok) out.push({ field, filled: filled ?? "", expected: exp });
  };
  const [given, ...family] = want.name.split(" ");
  check("given_name", r.information.given_name, given);
  check("family_name", r.information.family_name, family.join(" "));
  check("email", r.information.email, want.email);
  check("phone", r.information.phone, want.phone, clean(r.information.phone).replace(/\D/g, "").endsWith(want.phone.replace(/\D/g, "").slice(-10)));
  check("phone_country", r.information.phone_country, want.phone_country, /india|\+91/i.test(r.information.phone_country ?? ""));

  if (r.experience.length !== want.experience.length) out.push({ field: "experience_count", filled: String(r.experience.length), expected: String(want.experience.length) });
  want.experience.forEach((e, i) => {
    const g = r.experience[i] ?? {};
    const at = `experience#${i + 1}`;
    check(`${at}.job_title`, g.job_title, e.job_title);
    check(`${at}.company`, g.company, e.company);
    if (e.location) check(`${at}.location`, g.location, e.location, clean(g.location).includes(clean(e.location)));
    check(`${at}.current`, String(Boolean(g.current)), String(e.current));
    check(`${at}.from`, g.from, e.from, sameDate(g.from, e.from));
    if (!e.current) check(`${at}.to`, g.to, e.to, sameDate(g.to, e.to));
    const desc = clean(g.description);
    e.description.forEach((b, j) => check(`${at}.description#${j + 1}`, g.description, b, desc.includes(clean(b))));
    if (!e.description.length && desc) out.push({ field: `${at}.description`, filled: g.description ?? "", expected: "" });
  });
  want.education.forEach((e, i) => {
    const g = r.education[i] ?? {};
    const at = `education#${i + 1}`;
    check(`${at}.school`, g.school, e.school);
    // A site's degree list rarely has the exact wording: any bachelor's in technology or
    // engineering is right (B.Tech, BTech, B.E., Bachelor of Technology/Engineering).
    check(`${at}.degree`, g.degree, e.degree, /\b(b\.?\s?tech|b\.?\s?e\b|bachelor of (technology|engineering))/i.test(g.degree ?? ""));
    check(`${at}.field`, g.field, e.field);
    check(`${at}.from`, g.from, e.from, sameDate(g.from, e.from));
    check(`${at}.to`, g.to, e.to, sameDate(g.to, e.to));
  });
  const got = new Set(r.skills.map(clean));
  const missing = want.skills.filter((s) => !got.has(clean(s)));
  if (missing.length) out.push({ field: "skills", filled: r.skills.join(", "), expected: want.skills.join(", ") });
  return out;
}

// iCIMS (pure). Its job order is its own, so a reported entry is matched to the expected one
// with the same start date (dates stay right); field names use the resume's order.
// A description that starts with a company line ("<Company>, -------") is a warning.
export function compareIcims(r: IcimsReported, want: IcimsExpected = icimsExpected()): Omit<Comparison, "errors"> {
  const out: Mismatch[] = [];
  const warnings: Warning[] = [];
  const entries = r.entries ?? [];
  if (entries.length > ICIMS_MAX_ENTRIES || entries.length !== want.entries.length) {
    out.push({ field: "entry_count", filled: String(entries.length), expected: `${want.entries.length} (at most ${ICIMS_MAX_ENTRIES})` });
  }
  const used = new Set<number>();
  want.entries.forEach((e, i) => {
    const at = `entry#${i + 1}`;
    const k = entries.findIndex((g, j) => !used.has(j) && mmYyyy(g.start ?? "") !== "" && sameDate(mmYyyy(g.start ?? ""), e.start));
    if (k < 0) { out.push({ field: at, filled: "(no entry with this start date)", expected: `${e.employer}, ${e.title}, ${e.start}` }); return; }
    used.add(k);
    const g = entries[k];
    if (clean(g.employer) !== clean(e.employer)) out.push({ field: `${at}.employer`, filled: g.employer ?? "", expected: e.employer });
    if (clean(g.title) !== clean(e.title)) out.push({ field: `${at}.title`, filled: g.title ?? "", expected: e.title });
    const end = clean(g.end);
    const endOk = e.current ? end === "" || /present|current/.test(end) : sameDate(mmYyyy(g.end ?? ""), e.end);
    if (!endOk) out.push({ field: `${at}.end`, filled: g.end ?? "", expected: e.current ? "(current)" : e.end });
    const desc = clean(g.description);
    if (!desc || !clean(e.description).startsWith(desc)) {
      out.push({ field: `${at}.description`, filled: g.description ?? "", expected: e.description.split(" ").slice(0, 8).join(" ") });
    }
  });
  entries.forEach((g, j) => {
    if (/^\s*[^,\n]{2,},\s*-{3,}/.test(g.description ?? "")) {
      warnings.push({ field: `reported_entry#${j + 1}.description`, detail: "starts with a company line (\"<Company>, -------\")" });
    }
  });
  // iCIMS never fills these from any resume: the candidate fills them, not a failure.
  const fill_by_hand: string[] = [];
  if (!(r.education ?? []).some((e) => clean(e.school) || clean(e.degree))) fill_by_hand.push("education");
  if (!clean(r.linkedin)) fill_by_hand.push("linkedin");
  return { site: "icims", mismatches: out, warnings, fill_by_hand };
}

const isIcims = (r: unknown): r is IcimsReported => (r as { site?: string }).site === "icims";

// Field-by-field comparison. Workday: saved to data/ats/ with both sides (fake data only).
// iCIMS: nothing is written; the filled file itself is the reference (data/ats/icims-<date>.json).
export function compareReport(r: Reported | IcimsReported, file?: string): Comparison & { report: string } {
  if (isIcims(r)) return { ...compareIcims(r), errors: [], report: file ?? "" };
  const want = expected();
  const out = compareWorkday(r, want);
  mkdirSync(join("data", "ats"), { recursive: true });
  const report = join("data", "ats", `autofill-${new URL(r.site_url).hostname}-${Date.now()}.json`);
  writeFileSync(report, JSON.stringify({ reported: r, expected: want, mismatches: out }, null, 1));
  return { site: new URL(r.site_url).hostname, mismatches: out, warnings: [], fill_by_hand: [], errors: r.information.errors ?? [], report };
}

// Contact fields may hold what the site's account added (not the fake resume): not printed.
const CONTACT = new Set(["given_name", "family_name", "email", "phone", "phone_country"]);

export type Reference = {
  file: string; site: string; date: string;
  differs: Mismatch[];          // fields that would now differ from what the site showed
  new_since_saved: string[];    // of those, fields the saved report did not list (Workday reports)
  warnings: Warning[]; fill_by_hand: string[];
};

// ats references (read-only): every saved report in `dir` against today's fake resume render
// data (or `data`). A reminder to re-upload after a template change, not a model of the ATS.
export function atsReferences(dir = join("data", "ats"), data: ResumeData = fakeData()): { references: Reference[]; note: string } {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^(autofill-.+|icims-.+)\.json$/.test(f) && f !== "icims-TEMPLATE.json").sort()
    : [];
  const references: Reference[] = [];
  for (const f of files) {
    const saved = JSON.parse(readFileSync(join(dir, f), "utf8")) as { reported?: Reported; mismatches?: Mismatch[] } & Partial<IcimsReported>;
    const r = (saved.reported ?? saved) as Reported | IcimsReported;
    let c: Omit<Comparison, "errors">;
    let date: string;
    if (isIcims(r)) {
      c = compareIcims(r, icimsExpected(data));
      date = r.uploaded ?? f.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    } else {
      c = { site: new URL(r.site_url).hostname, mismatches: compareWorkday(r, expected(data)), warnings: [], fill_by_hand: [] };
      const ms = f.match(/-(\d{12,})\.json$/)?.[1];
      date = ms ? new Date(Number(ms)).toISOString().slice(0, 10) : "";
    }
    const before = new Set((saved.mismatches ?? []).map((m) => m.field));
    const differs = c.mismatches.map((m) => CONTACT.has(m.field) ? { ...m, filled: "(contact field, not shown)" } : m);
    references.push({
      file: join(dir, f), site: c.site, date, differs,
      new_since_saved: saved.mismatches ? differs.map((m) => m.field).filter((x) => !before.has(x)) : [],
      warnings: c.warnings, fill_by_hand: c.fill_by_hand
    });
  }
  return { references, note: "Fields that differ from what each site showed for today's fake resume; re-upload when a template change moved them." };
}
