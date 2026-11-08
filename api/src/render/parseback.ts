import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ResumeData } from "./render.ts";
import { hiddenChars } from "../tailor/writing.ts";
import { checkOpenResume, openResumeAvailable, runOpenResume } from "./openresume.ts";

// Parse-back test (engine-algorithm.md §7, gaps-and-rejection-risks.md "ATS parsing"):
// read the PDF's text the way an ATS does, with two independent extractors (poppler's
// pdftotext and Mozilla's pdf.js), and check it against the data the PDF was made from.
// Issues are codes with ids, never resume text.

export type Issue = { code: string; extractor: string; detail: string };

const norm = (s: string) =>
  s.normalize("NFKC").replace(/­/g, "").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

export function pdftotext(pdf: string): string {
  const r = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error("pdftotext failed (brew install poppler)");
  return r.stdout;
}

export async function pdfjsText(pdf: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 });
  const doc = await task.promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const item of content.items) if ("str" in item) out += item.str + (item.hasEOL ? "\n" : "");
    out += "\n";
  }
  await task.destroy();
  return out;
}

export function pdfInfo(pdf: string): { pages: number; fontsEmbedded: boolean } {
  const info = spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout;
  const fonts = spawnSync("pdffonts", [pdf], { encoding: "utf8" }).stdout.split("\n").slice(2).filter((l) => l.trim());
  // pdffonts columns: name type encoding emb sub uni object-id; "emb" is 5th from the end.
  const fontsEmbedded = fonts.every((l) => l.trim().split(/\s+/).at(-5) === "yes");
  return { pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0), fontsEmbedded };
}

// Everything the extracted text must hold, in reading order where order matters.
export function checkText(text: string, data: ResumeData, extractor: string): Issue[] {
  const issues: Issue[] = [];
  const t = norm(text);
  const flat = t.replace(/ /g, ""); // a URL split across lines still reads whole here
  const add = (code: string, detail: string) => issues.push({ code, extractor, detail });

  // Bullets: each one whole, all of them in resume order.
  const entries = [...data.experience, ...data.projects];
  let last = -1;
  for (const e of entries) {
    for (const [i, b] of e.bullets.entries()) {
      const at = t.indexOf(norm(b), last + 1);
      if (at < 0) add(t.includes(norm(b)) ? "bullet_order" : "bullet_broken", `${e.id}#${i + 1}`);
      else last = at;
    }
  }
  // Fixed fields byte-for-byte (after whitespace and dash normalization).
  for (const e of entries) {
    for (const field of ["title", "company", "dates", "location"] as const) {
      if (e[field] && !t.includes(norm(e[field]))) add("field_missing", `${e.id}.${field}`);
    }
  }
  for (const e of data.education) {
    for (const field of ["school", "degree", "dates"] as const) {
      if (!t.includes(norm(e[field]))) add("field_missing", `${e.id}.${field}`);
    }
  }
  // Contact: name, email, phone as written, every link as its full URL.
  for (const [k, v] of [["name", data.name], ["email", data.email], ["phone", data.phone]] as const) {
    if (v && !t.includes(norm(v))) add("contact_missing", k);
  }
  for (const [i, l] of data.links.entries()) if (!flat.includes(norm(l.text).replace(/ /g, ""))) add("contact_missing", `link#${i + 1}`);
  if (data.links.some((l) => !t.includes(norm(l.text)))) add("link_wrapped", "a link is split across lines");
  // Sections in order, skills listed.
  const titles = ["summary", "experience", "projects", "education", "skills"].filter((s) =>
    s === "summary" ? data.summary : s === "skills" ? data.skills.length : (data as unknown as Record<string, unknown[]>)[s].length);
  // A heading is a line of its own; the word alone ("skills" in a bullet, "experience" in the
  // summary) is not one, and finding it first failed good resumes.
  const lines = text.split(/\r?\n/).map(norm);
  const pos = titles.map((s) => lines.indexOf(s));
  if (pos.some((p) => p < 0) || pos.some((p, i) => i > 0 && p < pos[i - 1])) add("section_order", titles.join(","));
  for (const [i, s] of data.skills.entries()) if (!t.includes(norm(s))) add("skill_missing", `skill#${i + 1}`);
  // Icon fonts show up as private-use characters: noise for an ATS.
  const icons = [...text].filter((c) => c.codePointAt(0)! >= 0xe000 && c.codePointAt(0)! <= 0xf8ff).length;
  if (icons) add("icon_glyphs", String(icons));
  // Hidden characters, and words the record does not have: hidden or white text (keyword
  // stuffing) is read by an ATS and caught by recruiters. A word split across lines
  // still matches, because expected text is compared with its spaces removed.
  const hidden = hiddenChars(text.replace(/\u00AD/g, "")); // soft hyphens from line breaks are layout
  if (hidden.length) add("hidden_chars", hidden.join(","));
  const expected = norm([data.name, data.phone, data.location, data.email, ...data.links.map((l) => l.text), "summary experience projects education skills",
    data.summary, ...entries.flatMap((e) => [e.title, e.company, e.location, e.dates, ...e.bullets]),
    ...data.education.flatMap((e) => [e.school, e.degree, e.dates, ...e.details]), ...data.skills].join(" ")).replace(/[^a-z0-9]/g, "");
  const extra = [...new Set(t.match(/[a-z0-9]+/g) ?? [])].filter((w) => !expected.includes(w));
  if (extra.length) add("extra_text", `${extra.length} words not in the record`);
  return issues;
}

// The readers a render must pass, from JOBOPS_PARSE_READERS (comma list). Unset means all
// three; tests set "pdftotext,pdfjs" because CI has no OpenResume copy.
export function requiredReaders(): string[] {
  return (process.env.JOBOPS_PARSE_READERS ?? "pdftotext,pdfjs,openresume").split(",").map((r) => r.trim()).filter(Boolean);
}

export async function parseBack(pdf: string, data: ResumeData, maxPages: number): Promise<{ ok: boolean; issues: Issue[] }> {
  const issues: Issue[] = [];
  const readers = requiredReaders();
  const info = pdfInfo(pdf);
  if (info.pages > maxPages) issues.push({ code: "too_many_pages", extractor: "pdfinfo", detail: `${info.pages} > ${maxPages}` });
  if (!info.fontsEmbedded) issues.push({ code: "fonts_not_embedded", extractor: "pdffonts", detail: "" });
  if (readers.includes("pdftotext")) issues.push(...checkText(pdftotext(pdf), data, "pdftotext"));
  if (readers.includes("pdfjs")) issues.push(...checkText(await pdfjsText(pdf), data, "pdfjs"));
  // A required reader that is not installed fails the check: a skipped reader once let a
  // resume through that an ATS read wrong (plan-parser-icims.md).
  if (readers.includes("openresume")) {
    if (!openResumeAvailable()) issues.push({ code: "reader_missing", extractor: "openresume", detail: "runner not found" });
    else {
      try {
        issues.push(...checkOpenResume(runOpenResume(pdf), data));
      } catch (err) {
        issues.push({ code: "reader_failed", extractor: "openresume", detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
