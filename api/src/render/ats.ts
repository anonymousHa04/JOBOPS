// ATS check with the local readers: render a resume and read it back with pdftotext,
// pdf.js, and OpenResume (all in parse-back). Without a record it checks the fake resume
// (render/fake-resume.ts), the one used for upload tests on real sites (ats compare).
import { join } from "node:path";
import type { Bank, ResumeRecord } from "../profile/schema.ts";
import { fakeBank, fakeRecord } from "./fake-resume.ts";
import { openResumeAvailable } from "./openresume.ts";
import { renderRecord } from "./render.ts";

export type AtsResult = {
  resume: string;
  ok: boolean;
  readers: string[];
  pdf: string | null;
  issues: { code: string; extractor: string; detail: string }[];
  error: string | null;
};

export async function atsCheck(opts: { record?: ResumeRecord; bank?: Bank } = {}): Promise<AtsResult> {
  const fake = !opts.record;
  const record = opts.record ?? fakeRecord();
  const bank = opts.bank ?? fakeBank;
  const readers = ["pdftotext", "pdfjs", ...(openResumeAvailable() ? ["openresume"] : [])];
  const r = await renderRecord(record, bank, fake ? { outDir: join("data", "ats") } : {});
  return { resume: fake ? "fake (Rohan Mehta)" : record.resume_id, ok: r.ok, readers, pdf: r.path, issues: r.issues, error: r.error };
}
