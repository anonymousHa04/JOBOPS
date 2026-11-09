// Chat reports for a job: the prompt the browser extension drops into Claude or ChatGPT,
// and the report it brings back. The prompt carries the job description, its parsed
// requirements, the gaps the scoring found, and the job's tailored resume (user decision
// 2026-10-29); never contact details. Reports are stored in
// profile/reports/ (git-ignored); a report that is not valid YAML in the expected shape
// is tidied by the local model (task report_normalize). The raw answer is always kept.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadBank, loadSkillsExtra } from "../profile/bank.ts";
import { ResumeRecordSchema } from "../profile/schema.ts";
import type { Bank, ResumeRecord } from "../profile/schema.ts";
import { splitClient } from "../render/render.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { bankHasTerm, scoreRequirements, yearsAsked } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { askable } from "../lists.ts";
import type { FixResult } from "./loop.ts";

export const SOURCES = ["claude", "chatgpt"] as const;
export type Source = (typeof SOURCES)[number];

const line = z.string().trim().min(1).max(300);
// A bullet whose facts look wrong to the chat. For the user to check; never reworded.
export const FACT_PROBLEMS = ["number", "date", "role", "wording", "copied", "other"] as const;
const FactFlag = z.object({ bullet_id: z.string().trim().min(1).max(80), problem: z.enum(FACT_PROBLEMS).catch("other"), why: line });
export type FactFlag = z.infer<typeof FactFlag>;
// Lenient: a malformed item is dropped instead of failing the whole report.
const factFlags = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => FactFlag.safeParse(x).success).slice(0, 10) : v),
  z.array(FactFlag).max(10));
export const ReportSchema = z.object({
  role_summary: z.string().trim().min(1).max(600),
  must_haves_ranked: z.array(z.object({ requirement: line, why_it_matters: line })).max(10),
  gaps: z.array(z.object({ gap: line, advice: z.enum(["frame", "learn", "skip"]), how: line })).max(10),
  keywords_priority: z.array(z.string().trim().min(1).max(60)).max(15),
  interview_topics: z.array(line).max(10),
  company_notes: z.array(line).max(8),
  questions_to_ask: z.array(line).max(6),
  // Only when the prompt carried the tailored resume.
  fit_score: z.number().min(0).max(100).optional(),
  missed_gaps: z.array(z.object({ requirement: line, why: line })).max(8).optional(),
  already_covered: z.array(z.object({ gap: line, bullet_ids: z.array(z.string().trim().min(1).max(80)).max(6) })).max(8).optional(),
  bullet_notes: z.array(z.object({ bullet_id: z.string().trim().min(1).max(80), note: line })).max(10).optional(),
  // What the chat knows about the candidate from its own memory: unverified, for the user to confirm.
  from_memory: z.array(z.object({ fact: line, fills_gap: line })).max(8).optional(),
  fact_flags: factFlags.optional()
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

// The resume that would be sent for this job: its latest tailoring record, or null.
export function latestRecord(db: Db, jobId: string): ResumeRecord | null {
  const row = db.prepare("SELECT path FROM resume_records WHERE jd_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as
    { path: string } | undefined;
  if (!row || !existsSync(row.path)) return null;
  const r = ResumeRecordSchema.safeParse(parse(readFileSync(row.path, "utf8")));
  return r.success ? r.data : null;
}

// The bank cut down to what a record shows: its bullets and its skills line.
function recordBank(bank: Bank, r: ResumeRecord): Bank {
  const ids = new Set(r.content.bullets.map((b) => b.id));
  const keep = (es: Bank["roles"]) => es.map((e) => ({ ...e, bullets: e.bullets.filter((b) => ids.has(b.id)) })).filter((e) => e.bullets.length);
  return { ...bank, roles: keep(bank.roles), projects: keep(bank.projects),
    skills: { languages: r.content.skills, frameworks: [], tools: [], domains: [] } };
}

export type Gaps = {
  basis: string; // "record <resume_id>" when scored against the tailored resume, else "bank"
  must: string[];
  nice: string[];
  keywords: string[];
  years: string | null;
  bank_only: string[]; // requirements the bank supports that the tailored resume leaves out
};

// What the resume lacks for this JD, as JD wording only: must-haves without evidence,
// nice-to-haves not shown, literal keywords missing. Scored against the job's tailored
// resume when there is one (what the recruiter sees), else the whole bank. Never bullet text.
export function gaps(db: Db, jobId: string, record: ResumeRecord | null = latestRecord(db, jobId)): Gaps {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const extra = loadSkillsExtra();
  const verdicts = loadVerdicts(db, req, bank, extra);
  const full = scoreRequirements(req, bank, extra, undefined, jobId, verdicts);
  const r = record ? scoreRequirements(req, bank, extra, record.content.bullets.map((b) => b.id), jobId, verdicts) : full;
  const counted = (i: { kind: string; requirement: string }) => (i.kind === "must" || i.kind === "nice") && yearsAsked(i.requirement) === 0;
  const weak = (kind: string) => r.items.filter((i) => i.kind === kind && i.credit < 0.5 && counted(i)).map((i) => i.requirement);
  const inBank = new Set(full.items.filter((i) => counted(i) && i.credit >= 0.5).map((i) => `${i.kind}|${i.requirement}`));
  const shown = record ? recordBank(bank, record) : bank;
  return {
    basis: record ? `record ${record.resume_id}` : "bank",
    must: weak("must"),
    nice: weak("nice"),
    // Not the job's own title words, generic terms, or skills the resume has by another name.
    keywords: r.items.filter((i) => i.kind === "keyword" && i.label !== "supported")
      .map((i) => i.requirement)
      .filter((k) => askable(k) && !bankHasTerm(shown, extra, k) && !norm(`${job(db, jobId).title} ${req.role} ${req.seniority}`).includes(norm(k))),
    years: r.hard.pass ? null : `asks ${r.hard.years_asked}+ years; I have ${r.hard.years_have}`,
    bank_only: record ? r.items.filter((i) => counted(i) && i.credit < 0.5 && inBank.has(`${i.kind}|${i.requirement}`)).map((i) => i.requirement) : []
  };
}

// The tailored resume as sent to the chat: summary, skills, roles with their selected
// bullets, education. No contact details (name, email, phone, links).
export function resumeForChat(bank: Bank, r: ResumeRecord): string {
  const byEntry = new Map<string, string[]>();
  for (const b of r.content.bullets) byEntry.set(b.entry_id, [...(byEntry.get(b.entry_id) ?? []), `[${b.id}] ${b.text}`]);
  const entries = [...bank.roles, ...bank.projects];
  const experience = [
    // Same entries as the PDF (resumeData): no career break, the client split off the company.
    ...entries.filter((e) => byEntry.has(e.id) && e.kind !== "break").map((e) => {
      const { company, client } = splitClient(e.company ?? "");
      return { role: e.title, ...(company ? { company } : {}), ...(client ? { client } : {}), dates: e.dates, bullets: byEntry.get(e.id) ?? [] };
    }),
    ...[...byEntry].filter(([id]) => !entries.some((e) => e.id === id)).map(([, bullets]) => ({ bullets }))
  ];
  return stringify({
    summary: r.content.summary_text,
    skills: r.content.skills,
    experience,
    education: bank.education.map((e) => ({ degree: e.degree, school: e.school, dates: e.dates }))
  }).trim();
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
questions_to_ask: [<good questions for me to ask, at most 4>]
from_memory:                  # from your memory of me, NOT in the text above, at most 6; [] if none
  - fact: <what you know about their work or skills>
    fills_gap: <the gap or requirement it speaks to>
\`\`\``;

// Extra fields asked for when the prompt carries the tailored resume.
const SHAPE_RESUME = `fit_score: <0-100: how well the resume above fits this job, as a recruiter would judge it>
missed_gaps:                  # JD requirements the gap list missed and the resume does not show, at most 6
  - requirement: <as worded in the JD>
    why: <one sentence>
already_covered:              # listed gaps the resume does cover, at most 6
  - gap: <the gap>
    bullet_ids: [<ids in square brackets from the resume, e.g. cur-1>]
bullet_notes:                 # bullets to sharpen for this job, at most 8
  - bullet_id: <id>
    note: <one sentence of advice; no new facts, numbers, or tools the bullet does not state>
fact_flags:                   # bullets whose facts look wrong or impossible: a number that conflicts with another bullet, a technology used before it existed, work that fits a different job, model wording, or text copied from another bullet; at most 8; [] if none
  - bullet_id: <id>           # use the bullet ids shown; do not rewrite them
    problem: number | date | role | wording | copied | other
    why: <one sentence>`;

// The prompt for the chat: JD, requirements, the local gap list, and the tailored resume
// when the job has one (user decision 2026-10-29), so the chat can catch what the local
// scorer missed. Never contact details.
export function chatPrompt(db: Db, jobId: string): { job_id: string; company: string; title: string; basis: string; prompt: string } {
  const j = job(db, jobId);
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const record = latestRecord(db, jobId);
  const g = gaps(db, jobId, record);
  const bank = record ? loadBank() : null;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const resume = record && bank
    ? `\n\nMy tailored resume for this job (bullet ids in square brackets):\n"""\n${resumeForChat(bank, record)}\n"""\n\n` +
      `Compare my resume with the job description. The gap list above came from my local keyword and ` +
      `evidence scorer and can be wrong both ways: name requirements it missed (missed_gaps), gaps my resume ` +
      `in fact covers (already_covered, with bullet ids), and bullets I should sharpen (bullet_notes). Advice only: ` +
      `never invent experience, numbers, or tools my resume does not state.`
    : `\n\n(I have no tailored resume for this job yet; the gaps are against my full experience.)`;
  const shape = record ? SHAPE.replace(/\n```$/, `\n${SHAPE_RESUME}\n\`\`\``) : SHAPE;
  const prompt = `I'm applying for ${j.title} at ${j.company}, and I want your help preparing
my application. Use everything you know about my work and skills from our earlier conversations, along
with the job description, my resume below, and public knowledge about ${j.company}. Anything you know
about me that is not in the text below goes under from_memory only, for me to confirm. Use your memory
of me as well. Don't invent facts about me. Be concise and specific to me and this job. Also, don't
save anything from this chat to your memory.

Job: ${j.title} at ${j.company}${j.location ? ` (${j.location})` : ""}
Link: ${j.source_url}

Job description:
"""
${j.description.slice(0, MAX_JD)}${j.description.length > MAX_JD ? "\n[...cut]" : ""}
"""

Must-haves (parsed):
${list(req.must_have)}

Where my ${record ? "tailored resume" : "experience"} is thin for this job:
Must-haves without evidence:
${list(g.must)}
Nice-to-haves not shown:
${list(g.nice)}
Keywords missing from my ${record ? "resume" : "experience"}:
${list(g.keywords)}${g.years ? `\nYears: ${g.years}` : ""}${resume}

Reply with ONLY one YAML block in exactly this shape, no other text:
${shape}`;
  return { job_id: j.id, company: j.company, title: j.title, basis: g.basis, prompt };
}

// What a follow-up message reports: bullet ids changed since the last answer, and gaps
// that still need my facts. FixResult (report loop) has this shape too.
export type Changes = Pick<FixResult, "added" | "removed" | "reworded" | "needs_facts">;

// A follow-up in the same chat as the job's earlier report(s): "Attempt N: based on your input
// I made changes; please have a look", what changed, and the updated resume. `of` is the
// report loop's limit (5) when the loop sends it.
export function followUpPrompt(db: Db, jobId: string, attempt: number, changes: Changes, of?: number): string {
  const record = latestRecord(db, jobId);
  const bank = record ? loadBank() : null;
  const ids = (label: string, xs: string[]) => (xs.length ? `${label}: ${xs.join(", ")}\n` : "");
  const changed = changes.added.length + changes.removed.length + changes.reworded.length > 0;
  const resume = record && bank
    ? `\nMy updated resume (bullet ids in square brackets):\n"""\n${resumeForChat(bank, record)}\n"""\n`
    : "";
  return `Attempt ${attempt}${of ? ` of ${of}` : ""}: Based on your input, I made changes to my resume. Please have a look.
${changed ? "" : "(No bullets changed since your last answer; the gaps below still need my facts.)\n"}${ids("Added bullets", changes.added)}${ids("Removed bullets", changes.removed)}${ids("Reworded bullets", changes.reworded)}${ids("Still needs my facts", changes.needs_facts)}${resume}
Check it again against the job description. Only list what is still missing or new; [] where nothing is left.

Reply with ONLY one YAML block in exactly this shape, no other text:
${SHAPE.replace(/\n```$/, `\n${SHAPE_RESUME}\n\`\`\``)}`;
}

// The follow-up for the next report in a job's existing chat: the attempt after the last
// saved one, and what changed between the resume that report saw and the latest one.
export function chatFollowUp(db: Db, jobId: string, source: Source): { prompt: string; attempt: number } | null {
  const path = join(reportsDir(), `${jobId}.${source}.yaml`);
  if (!existsSync(path)) return null;
  const saved = parse(readFileSync(path, "utf8")) as { meta?: { attempt?: number }; local?: { basis?: string } | null };
  const attempt = (saved.meta?.attempt ?? 1) + 1;
  const prevId = saved.local?.basis?.startsWith("record ") ? saved.local.basis.slice(7) : null;
  const row = prevId ? db.prepare("SELECT path FROM resume_records WHERE resume_id = ?").get(prevId) as { path: string } | undefined : undefined;
  const prev = row && existsSync(row.path) ? ResumeRecordSchema.safeParse(parse(readFileSync(row.path, "utf8"))) : null;
  const now = latestRecord(db, jobId);
  const was = new Map((prev?.success ? prev.data.content.bullets : []).map((b) => [b.id, b.text]));
  const is = new Map((now?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const g = gaps(db, jobId, now);
  const changes: Changes = {
    added: prev?.success ? [...is.keys()].filter((id) => !was.has(id)) : [],
    removed: prev?.success ? [...was.keys()].filter((id) => !is.has(id)) : [],
    reworded: [...is].filter(([id, t]) => was.has(id) && was.get(id) !== t).map(([id]) => id),
    needs_facts: [...g.must, ...g.nice]
  };
  return { prompt: followUpPrompt(db, jobId, attempt, changes), attempt };
}

// The report part of a saved report file, or null.
export function loadReport(jobId: string, source: Source): Report | null {
  const path = join(reportsDir(), `${jobId}.${source}.yaml`);
  if (!existsSync(path)) return null;
  const r = ReportSchema.safeParse((parse(readFileSync(path, "utf8")) as { report?: unknown }).report);
  return r.success ? r.data : null;
}

export type FlagResolution = { bullet_id: string; flag_why: string; reason: string; at: string };

export function loadFlagResolutions(): FlagResolution[] {
  const path = join(reportsDir(), "flag-resolutions.yaml");
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf8");
    const parsed = parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        bullet_id: item.bullet_id,
        flag_why: item.flag_why,
        reason: item.reason,
        at: item.at
      }));
    }
  } catch {
    // File is not a valid list, return empty array
  }
  return [];
}

export function openFactFlags(jobId: string, bulletIds: string[]): string[] {
  const resolutions = loadFlagResolutions();
  const resolutionsSet = new Set(resolutions.map((r) => `${r.bullet_id}-${r.flag_why}`));
  const openFlags: string[] = [];

  for (const source of SOURCES) {
    const report = loadReport(jobId, source);
    if (report && report.fact_flags) {
      for (const flag of report.fact_flags) {
        if (bulletIds.includes(flag.bullet_id) && !resolutionsSet.has(`${flag.bullet_id}-${flag.why}`)) {
          openFlags.push(flag.bullet_id);
        }
      }
    }
  }

  return Array.from(new Set(openFlags)).sort();
}

export function resolveFactFlags(bulletId: string, reason: string): { resolved: number } {
  const why = reason.trim();
  if (!why) throw new Error("reason is required");
  const resolutions = loadFlagResolutions();
  const seen = new Set(resolutions.map((r) => `${r.bullet_id}\n${r.flag_why}`));
  let resolved = 0;

  // Only the latest report per job and source; per-round copies would repeat its flags.
  for (const r of listReports()) {
    if (!SOURCES.includes(r.source as Source) || !r.file.endsWith(`${r.job_id}.${r.source}.yaml`)) continue;
    const report = loadReport(r.job_id, r.source as Source);
    for (const f of report?.fact_flags ?? []) {
      const key = `${f.bullet_id}\n${f.why}`;
      if (f.bullet_id !== bulletId || seen.has(key)) continue;
      seen.add(key);
      resolutions.push({ bullet_id: f.bullet_id, flag_why: f.why, reason: why, at: new Date().toISOString() });
      resolved++;
    }
  }

  if (resolved > 0) {
    mkdirSync(reportsDir(), { recursive: true });
    writeFileSync(join(reportsDir(), "flag-resolutions.yaml"), stringify(resolutions));
  }
  return { resolved };
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
export async function saveReport(db: Db, jobId: string, source: Source, text: string, opts: { baseUrl?: string; round?: number } = {}): Promise<SaveResult> {
  const j = job(db, jobId);
  const dir = reportsDir();
  // Attempt number in this job's chat: one more than the last saved report's; 1 again for a
  // loop's first round or when there is no loop file (a new check, or after Restart check).
  const latest = join(dir, `${jobId}.${source}.yaml`);
  const fresh = opts.round === 1 || !existsSync(join(dir, `${jobId}.${source}.loop.json`));
  const attempt = !fresh && existsSync(latest)
    ? (((parse(readFileSync(latest, "utf8")) as { meta?: { attempt?: number } }).meta?.attempt ?? 1) + 1)
    : 1;
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
  const saved = stringify({
    meta: { job_id: jobId, company: j.company, title: j.title, link: j.source_url, source, saved_at: new Date().toISOString(), normalized_by: base.normalized_by, raw, round: opts.round ?? null, attempt },
    report,
    local: localFindings(db, jobId)
  });
  writeFileSync(path, saved);
  // The report loop keeps every round: <job>.<source>.r<n>.yaml next to the latest.
  if (opts.round) writeFileSync(join(dir, `${jobId}.${source}.r${opts.round}.yaml`), saved);
  return { ...base, ok: true, path };
}

// What the local scorer found, saved beside the chat's report. Requirement names only.
function localFindings(db: Db, jobId: string): Omit<Gaps, "years"> | null {
  try {
    const { years: _years, ...g } = gaps(db, jobId);
    return g;
  } catch {
    return null; // no requirements or no bank: the chat's report still saves
  }
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
