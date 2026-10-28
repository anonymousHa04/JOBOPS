// Chat reports for a job: the prompt the browser extension drops into Claude or ChatGPT,
// and the report it brings back. The prompt carries the job description, its parsed
// requirements, and the gaps the scoring found; never resume text, bullets, or contact
// details (user decision 2026-10-28: JD + gaps only). Reports are stored in
// profile/reports/ (git-ignored); a report that is not valid YAML in the expected shape
// is tidied by the local model (task report_normalize). The raw answer is always kept.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadBank, loadSkillsExtra } from "../profile/bank.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { bankHasTerm, scoreRequirements, yearsAsked } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { askable } from "../lists.ts";

export const SOURCES = ["claude", "chatgpt"] as const;
export type Source = (typeof SOURCES)[number];

const line = z.string().trim().min(1).max(300);
export const ReportSchema = z.object({
  role_summary: z.string().trim().min(1).max(600),
  must_haves_ranked: z.array(z.object({ requirement: line, why_it_matters: line })).max(10),
  gaps: z.array(z.object({ gap: line, advice: z.enum(["frame", "learn", "skip"]), how: line })).max(10),
  keywords_priority: z.array(z.string().trim().min(1).max(60)).max(15),
  interview_topics: z.array(line).max(10),
  company_notes: z.array(line).max(8),
  questions_to_ask: z.array(line).max(6)
}).strict();
export type Report = z.infer<typeof ReportSchema>;

export const reportsDir = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "reports");

const MAX_JD = 12_000; // characters of the description sent; long postings are cut

type JobRow = { id: string; title: string; company: string; location: string | null; description: string; source_url: string };

function job(db: Db, jobId: string): JobRow {
  const j = db.prepare("SELECT id, title, company, location, description, source_url FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!j) throw new Error(`no job ${jobId}`);
  return j;
}

// What the bank lacks for this JD, as JD wording only: must-haves without evidence,
// nice-to-haves not shown, literal keywords missing. Never bullet text.
export function gaps(db: Db, jobId: string): { must: string[]; nice: string[]; keywords: string[]; years: string | null } {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const extra = loadSkillsExtra();
  const r = scoreRequirements(req, bank, extra, undefined, jobId, loadVerdicts(db, req, bank, extra));
  const weak = (kind: string) => r.items.filter((i) => i.kind === kind && i.credit < 0.5 && yearsAsked(i.requirement) === 0).map((i) => i.requirement);
  return {
    must: weak("must"),
    nice: weak("nice"),
    // Not the job's own title words, generic terms, or skills the bank has by another name.
    keywords: r.items.filter((i) => i.kind === "keyword" && i.label !== "supported")
      .map((i) => i.requirement)
      .filter((k) => askable(k) && !bankHasTerm(bank, extra, k) && !norm(`${job(db, jobId).title} ${req.role} ${req.seniority}`).includes(norm(k))),
    years: r.hard.pass ? null : `asks ${r.hard.years_asked}+ years; the candidate has ${r.hard.years_have}`
  };
}

const SHAPE = `\`\`\`yaml
role_summary: <2-3 sentences: what this role really does and what it optimizes for>
must_haves_ranked:            # most important first, at most 6
  - requirement: <as worded in the JD>
    why_it_matters: <one sentence>
gaps:                         # one per gap listed below, at most 6
  - gap: <the gap>
    advice: frame | learn | skip
    how: <one sentence: how to frame adjacent experience honestly, or what to learn>
keywords_priority: [<ATS keywords in priority order, at most 12>]
interview_topics: [<likely technical or behavioral topics, at most 6>]
company_notes: [<what is publicly known about the team, product, or engineering culture, at most 5>]
questions_to_ask: [<good questions for the candidate to ask, at most 4>]
\`\`\``;

// The prompt for the chat. JD + requirements + gaps; no resume content.
export function chatPrompt(db: Db, jobId: string): { job_id: string; company: string; title: string; prompt: string } {
  const j = job(db, jobId);
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const g = gaps(db, jobId);
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const prompt = `You are helping a software engineer prepare an application. Be concise and specific.
Use only public knowledge about the company and the job description below. Do not invent
facts about the candidate.

Job: ${j.title} at ${j.company}${j.location ? ` (${j.location})` : ""}
Link: ${j.source_url}

Job description:
"""
${j.description.slice(0, MAX_JD)}${j.description.length > MAX_JD ? "\n[...cut]" : ""}
"""

Must-haves (parsed):
${list(req.must_have)}

Where the candidate's experience is thin for this job:
Must-haves without evidence:
${list(g.must)}
Nice-to-haves not shown:
${list(g.nice)}
Keywords missing from the resume:
${list(g.keywords)}${g.years ? `\nYears: ${g.years}` : ""}

Reply with ONLY one YAML block in exactly this shape, no other text:
${SHAPE}`;
  return { job_id: j.id, company: j.company, title: j.title, prompt };
}

// The YAML inside a chat answer: the first fenced block, else the whole answer.
function yamlOf(text: string): string {
  return text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/)?.[1] ?? text;
}

export type SaveResult = {
  ok: boolean;
  job_id: string;
  source: Source;
  path: string | null; // the report, when it validated
  raw: string; // the answer as received, always kept
  normalized_by: string | null; // the local model, when the answer needed tidying
  error: string | null;
};

// Saves a chat's answer as a report: as is when valid, tidied by the local model when
// not. Returns paths and codes, never report text.
export async function saveReport(db: Db, jobId: string, source: Source, text: string, opts: { baseUrl?: string } = {}): Promise<SaveResult> {
  const j = job(db, jobId);
  const dir = reportsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const raw = join(dir, `${jobId}.${source}.${stamp}.raw.txt`);
  writeFileSync(raw, text);
  const base = { ok: false, job_id: jobId, source, path: null, raw, normalized_by: null, error: null } as SaveResult;

  let report: Report | null = null;
  try {
    const parsed = ReportSchema.safeParse(parse(yamlOf(text)));
    if (parsed.success) report = parsed.data;
  } catch {
    // Not YAML at all: the local model tidies it below.
  }
  if (!report) {
    const res = await generate({
      task: "report_normalize",
      baseUrl: opts.baseUrl,
      schema: ReportSchema,
      prompt: `Rewrite this job-application report into the JSON fields of the schema. Keep its content; ` +
        `shorten long items; do not add facts.\n\nReport:\n"""\n${text.slice(0, 16_000)}\n"""`
    });
    if (!res.ok) return { ...base, error: `the answer was not a valid report and the local model could not tidy it (${res.error}: ${res.detail})` };
    report = res.value;
    base.normalized_by = forTask("report_normalize").model;
  }
  const path = join(dir, `${jobId}.${source}.yaml`);
  writeFileSync(path, stringify({
    meta: { job_id: jobId, company: j.company, title: j.title, link: j.source_url, source, saved_at: new Date().toISOString(), normalized_by: base.normalized_by, raw },
    report
  }));
  return { ...base, ok: true, path };
}

// Saved reports for a job (or all): metadata only.
export function listReports(jobId?: string): { file: string; job_id: string; source: string; saved_at: string }[] {
  const dir = reportsDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") && (!jobId || f.startsWith(`${jobId}.`)));
  } catch {
    return [];
  }
  return files.map((f) => {
    const meta = (parse(readFileSync(join(dir, f), "utf8")) as { meta?: Record<string, string> }).meta ?? {};
    return { file: join(dir, f), job_id: meta.job_id ?? "", source: meta.source ?? "", saved_at: meta.saved_at ?? "" };
  });
}
