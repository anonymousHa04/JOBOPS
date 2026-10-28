// What a site's resume autofill should show for the fake resume, and the comparison with
// what it did show (filled in by hand after an upload test; ats compare <file>).
// Fake data only: this module never sees the real bank.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBank, fakeRecord } from "./fake-resume.ts";
import { resumeData } from "./render.ts";

export type Expected = {
  name: string; email: string; phone: string; phone_country: string;
  experience: { job_title: string; company: string; location: string; current: boolean; from: string; to: string; description: string[] }[];
  education: { school: string; degree: string; field: string; from: string; to: string }[];
  skills: string[];
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "Jan 2018" -> "01/2018"; "2014" -> "2014"; "Present" -> "".
function mmYyyy(s: string): string {
  const m = s.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m) return `${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}/${m[2]}`;
  return /^\d{4}$/.test(s.trim()) ? s.trim() : "";
}
const sides = (dates: string) => dates.split(/\s*(?:-|–|—|\bto\b)\s*/i);

export function expected(): Expected {
  const data = resumeData(fakeRecord(), fakeBank);
  // "BTech in Mechanical Engineering" or "Bachelor of Technology, Computer Science".
  const [degree, field = ""] = fakeBank.education[0].degree.split(/\s+in\s+|\s*,\s*/);
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

const clean = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[•·]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const sameDate = (a: string | undefined, b: string) => clean(a).replace(/^0/, "") === clean(b).replace(/^0/, "");

export type Mismatch = { field: string; filled: string; expected: string };

// Field-by-field comparison; saved to data/ats/ with both sides (fake data only).
export function compareReport(r: Reported): { site: string; mismatches: Mismatch[]; errors: string[]; report: string } {
  const want = expected();
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

  mkdirSync(join("data", "ats"), { recursive: true });
  const report = join("data", "ats", `autofill-${new URL(r.site_url).hostname}-${Date.now()}.json`);
  writeFileSync(report, JSON.stringify({ reported: r, expected: want, mismatches: out }, null, 1));
  return { site: new URL(r.site_url).hostname, mismatches: out, errors: r.information.errors ?? [], report };
}
