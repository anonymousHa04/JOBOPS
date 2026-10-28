// Operations shared by the CLI (cli.ts) and the MCP server (mcp/server.ts).
// Results are ids, counts, scores, and questions: never resume or bullet text.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import type { Db } from "./db.ts";
import {
  addBullet,
  removeBullet,
  addSkill,
  removeSkill,
  buildBank,
  checkBank,
  dismissRisk,
  bankDedupe,
  loadBank,
  loadPreferences,
  addRole,
  excludeTitleWords,
  markBreak,
  setEducation,
  setLinks,
  setCompany,
  setMaxPages,
  retagBank,
  loadSkillsExtra,
  recordLearnable,
  resumeTextPath,
  saveBank
} from "./profile/bank.ts";
import type { Ats } from "./profile/bank.ts";
import { loadRequirements, parseJob } from "./requirements/parse.ts";
import { riskCheck } from "./scoring/risk.ts";
import { judgeRequirements, judgeSettled, loadVerdicts, needsJudgeCount, openRequirements } from "./scoring/judge.ts";
import { allBullets, scoreJob } from "./scoring/score.ts";
import { loadRecords } from "./tailor/records.ts";
import { dryRunAll, tailorJob } from "./tailor/tailor.ts";
import { renderRecord } from "./render/render.ts";
import { atsCheck } from "./render/ats.ts";
import { compareReport } from "./render/ats-report.ts";
import type { Reported } from "./render/ats-report.ts";
import { lintRecord } from "./tailor/lint.ts";
import { fetchJob } from "./jobs/from-url.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { ensureModel, modelLogPath, modelUp, TASKS } from "./model/registry.ts";
import type { CallRecord } from "./model/llm.ts";

export function db(): Db {
  const path = process.env.DB_PATH ?? "data/jobops.db";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return openDb(path);
}

function requireBank() {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run: bank build");
  return bank;
}

export function bankStatus() {
  const bank = loadBank();
  if (!bank) return { exists: false };
  const extra = loadSkillsExtra();
  const bullets = allBullets(bank);
  return {
    exists: true,
    approved: bank.approved,
    roles: bank.roles.length,
    projects: bank.projects.length,
    bullets: bullets.length,
    user_bullets: bullets.filter((b) => b.source === "user").length,
    extra_skills: extra.skills.length,
    issues: checkBank(bank, readFileSync(resumeTextPath(), "utf8")).length,
    meta: bank.meta ?? null
  };
}

export async function bankBuild() {
  await ensureModel("bank_build");
  const r = await buildBank();
  return { ...bankStatus(), ok: r.ok, issues: r.issues };
}

// Add tags to bullets with fewer than 5, only tags the bullet's text names (local model).
export async function bankRetag() {
  await ensureModel("retag");
  const r = await retagBank();
  return { ...r, issues: checkBank(requireBank(), readFileSync(resumeTextPath(), "utf8")).length };
}

export function bankDedupeSkills() {
  return { ...bankDedupe(), ...bankStatus() };
}

export function bankCheck() {
  return { issues: checkBank(requireBank(), readFileSync(resumeTextPath(), "utf8")) };
}

export function bankApprove() {
  const bank = requireBank();
  bank.approved = true;
  saveBank(bank);
  return { approved: true };
}

export function skillRemove(name: string) {
  return { skill: name.trim().toLowerCase(), removed: removeSkill(name) };
}

export function skillAdd(name: string, have: boolean, evidence: string) {
  // A placeholder copied from instructions ("<skill>") is not a skill name.
  if (/[<>]/.test(name) || /[<>]/.test(evidence)) throw new Error(`"${/[<>]/.test(name) ? name : evidence}" looks like a placeholder; use the real skill name and evidence`);
  addSkill(name, have ? "have" : "dont_have", evidence);
  return { skill: name.toLowerCase(), status: have ? "have" : "dont_have" };
}

export function bulletAdd(entryId: string, text: string, tags: string[], impact: "high" | "medium" | "low", opts: { topic?: string; evidence?: string } = {}) {
  return { id: addBullet(entryId, text, tags, impact, opts) };
}

export function bankMarkBreak(entryId: string, title?: string) {
  return markBreak(entryId, title);
}

export function bulletRemove(id: string) {
  return removeBullet(id);
}

export function bankLinks(urls: string[]) {
  return setLinks(urls);
}

export function bankEducation(fields: { school?: string; degree?: string; dates?: string }, id?: string) {
  return setEducation(fields, id);
}

export function prefsRoleAdd(title: string, aliases: string[]) {
  return { added: addRole(title, aliases) };
}

export function prefsCompany(name: string, slug: string, ats: Ats) {
  return { changed: setCompany(name, slug, ats) };
}

export function prefsPages(pages: number) {
  return { changed: setMaxPages(pages) };
}

export function prefsExclude(words: string[]) {
  return { added: excludeTitleWords(words) };
}

export function learnableSet(skill: string, learnable: boolean, jobId: string) {
  recordLearnable(skill, learnable, jobId);
  return { skill: skill.toLowerCase(), learnable, job_id: jobId };
}

export function riskSkip(id: string) {
  dismissRisk(id);
  return { dismissed: id };
}

export function listJobs(d: Db, opts: { q?: string; limit?: number; unparsed?: boolean }) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.q) {
    where.push("(title LIKE ? OR company LIKE ?)");
    args.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.unparsed) where.push("id NOT IN (SELECT job_id FROM job_requirements)");
  const sql =
    "SELECT id, company, title, location FROM jobs" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY last_seen_at DESC LIMIT ?";
  args.push(opts.limit ?? 50);
  return d.prepare(sql).all(...args) as { id: string; company: string; title: string; location: string | null }[];
}

export async function jdParse(d: Db, jobId: string) {
  if (!loadRequirements(d, jobId)) await ensureModel("jd_parse");
  return parseJob(d, jobId);
}

// Parses every job that has no requirements yet, one model call at a time. Stops at the
// first "server down" (the rest would fail the same way) and says how far it got.
export async function jdParseAll(d: Db, limit: number) {
  const jobs = listJobs(d, { unparsed: true, limit });
  if (jobs.length) await ensureModel("jd_parse", `${jobs.length} jobs to parse`);
  const done: string[] = [];
  const failed: { job_id: string; error: string }[] = [];
  let stopped: string | null = null;
  for (const j of jobs) {
    try {
      await parseJob(d, j.id);
      done.push(j.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ job_id: j.id, error: message });
      if (/model unavailable/.test(message)) {
        stopped = `the model server went down after ${done.length} of ${jobs.length}; start it and run the same command again`;
        break;
      }
    }
  }
  return { parsed: done.length, failed, stopped };
}

// Requirements still waiting for the judge, and whether its answers can change anything.
function judgeNeed(d: Db, req: NonNullable<ReturnType<typeof loadRequirements>>, bank: ReturnType<typeof requireBank>, extra: ReturnType<typeof loadSkillsExtra>) {
  const open = openRequirements(d, req, bank, extra);
  const settled = open.length ? judgeSettled(req, bank, extra, loadVerdicts(d, req, bank, extra), open) : null;
  return { open: open.length, needed: open.length > 0 && !settled, settled };
}

// Score with the LLM judge for requirements the index cannot settle (cached verdicts
// first). judge=false scores with cached verdicts only (no model calls).
export async function score(d: Db, jobId: string, judge = true) {
  const req = loadRequirements(d, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = requireBank();
  const extra = loadSkillsExtra();
  if (!judge) return { ...scoreJob(d, jobId, loadVerdicts(d, req, bank, extra)), judge: "off (cached verdicts only)" };
  const need = judgeNeed(d, req, bank, extra);
  if (need.needed) await ensureModel("judge", `${need.open} requirements need the judge`);
  const { verdicts, stats } = await judgeRequirements(d, req, bank, extra);
  return { ...scoreJob(d, jobId, verdicts), judge: stats };
}

// Risks over the whole bank until the engine's bullet selection exists.
export function risk(d: Db, jobId: string) {
  const req = loadRequirements(d, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = requireBank();
  const ids = allBullets(bank).map((b) => b.id);
  const extra = loadSkillsExtra();
  return { job_id: jobId, risks: riskCheck(req, bank, extra, ids, jobId, loadVerdicts(d, req, bank, extra)) };
}

// Tailor one JD (engine-algorithm.md §4): judge first (cached verdicts reused), then
// decide, ask, reword, and write the record. Needs an approved bank. With dryRun, the
// decision only: cached verdicts, no model calls, no files.
export async function tailor(d: Db, jobId: string, opts: { force?: boolean; dryRun?: boolean } = {}) {
  if (opts.dryRun) return tailorAll(d, { jobId });
  const req = loadRequirements(d, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = requireBank();
  if (!bank.approved) throw new Error("approve the bank first: bank approve (after reviewing it)");
  const extra = loadSkillsExtra();
  const { records, checks } = loadRecords(d, bank);
  // The judge (7B) and rewording (14B) need different servers, and only one fits in
  // memory: judge first (cached), then check rewording's server before any work.
  const need = judgeNeed(d, req, bank, extra);
  if (need.needed) await ensureModel("judge", `${need.open} requirements need the judge before tailoring`);
  const { verdicts, stats } = await judgeRequirements(d, req, bank, extra);
  const plan = tailorAll(d, { jobId }).rows[0];
  if (plan?.decision === "adapt" && plan.to_reword > 0 && (!plan.blocked || opts.force)) {
    await ensureModel("reword", `${plan.to_reword} bullets to reword (the judge's answers are saved; run tailor again after switching)`);
  }
  const companyOf = companies(d);
  const result = await tailorJob(d, req, jobId, records, bank, extra, loadPreferences().tailoring, verdicts,
    { force: opts.force, companies: { company: companyOf(jobId) ?? "", companyOf } });
  return { ...result, judge: stats, edited_records: checks.filter((c) => c.edited).map((c) => c.resume_id) };
}

// Job id -> company, for the same-company rule.
function companies(d: Db): (jdId: string) => string | undefined {
  const rows = d.prepare("SELECT id, company FROM jobs").all() as { id: string; company: string }[];
  const m = new Map(rows.map((r) => [r.id, r.company]));
  return (id) => m.get(id);
}

// Lint a stored record (gaps-and-rejection-risks.md §3): reports, never rewrites.
export function lint(d: Db, resumeId: string) {
  const bank = requireBank();
  const record = loadRecords(d, bank).records.find((r) => r.resume_id === resumeId);
  if (!record) throw new Error(`no record ${resumeId}`);
  return { resume_id: resumeId, findings: lintRecord(record, bank, loadSkillsExtra()) };
}

// `tailor --all --dry-run`: the decision table for every parsed JD (or one) and all
// open risk questions. Requirements still waiting for the judge are counted per row.
export function tailorAll(d: Db, opts: { jobId?: string } = {}) {
  const bank = requireBank();
  const extra = loadSkillsExtra();
  const { records, checks } = loadRecords(d, bank);
  const rows = d.prepare(
    `SELECT DISTINCT j.id, j.company, j.title FROM jobs j JOIN job_requirements r ON r.job_id = j.id
     ${opts.jobId ? "WHERE j.id = ?" : ""} ORDER BY j.id`
  ).all(...(opts.jobId ? [opts.jobId] : [])) as { id: string; company: string; title: string }[];
  if (opts.jobId && rows.length === 0) throw new Error("parse the JD first: jd parse <job_id>");
  const jobs = rows.flatMap((j) => {
    const req = loadRequirements(d, j.id);
    return req ? [{ job_id: j.id, company: j.company, title: j.title, req, verdicts: loadVerdicts(d, req, bank, extra) }] : [];
  });
  return {
    dry_run: true,
    bank_approved: bank.approved,
    records: records.length,
    edited_records: checks.filter((c) => c.edited).map((c) => c.resume_id),
    stale_records: checks.filter((c) => !c.edited && (c.stale_bank || c.stale_engine)).map((c) => c.resume_id),
    ...dryRunAll(jobs, records, bank, extra, loadPreferences().tailoring, companies(d))
  };
}

// Record -> PDF in profile/pdf/, kept only if the parse-back test passes (decisions.md:
// PDF only when applying directly). Issues are codes and ids, never text.
export async function render(d: Db, resumeId: string) {
  const bank = requireBank();
  const record = loadRecords(d, bank).records.find((r) => r.resume_id === resumeId);
  if (!record) throw new Error(`no record ${resumeId} (hand-edited records are skipped; see tailor --all --dry-run)`);
  if (record.decision === "not_tailored") throw new Error(`record ${resumeId} is not_tailored: ${record.reason}`);
  return { resume_id: resumeId, ...(await renderRecord(record, bank)) };
}

// `job add <url>`: fetch one job from its link, then parse, judge and score, decide,
// reword, write the record, and render the PDF. Steps already done are skipped, so the
// same command continues where it stopped. A step whose model is not running stops the
// pipeline with the commands to continue; models are never started or stopped here
// (only one heavy model fits in memory).
type Step = { step: string; status: "done" | "cached" | "skipped" | "stopped"; detail?: string };

export async function jobAdd(d: Db, url: string, opts: { company?: string; force?: boolean; render?: boolean } = {}) {
  const steps: Step[] = [];
  const out = (extra: Record<string, unknown> = {}) => ({ url, steps, ...extra });
  const stop = (step: string, role: string, why: string) => {
    steps.push({ step, status: "stopped", detail: why });
    return out({ next: [`.claude/bin/llm.sh stop all`, `.claude/bin/llm.sh start ${role}`, `node api/src/cli.ts job add "${url}"`] });
  };

  // 1. Fetch and store (the same link again finds the stored job).
  let known = new Map<string, string>();
  try {
    known = new Map(loadPreferences().companies.include.map((c) => [c.slug.toLowerCase(), c.name]));
  } catch {
    // No preferences yet: names come from the board or page.
  }
  const input = await fetchJob(url, { company: opts.company, known });
  const { job, created } = createJobRepository(d).upsert(input);
  steps.push({ step: "fetch", status: created ? "done" : "cached", detail: `${job.company}: ${job.title}` });
  const base = { job_id: job.id, company: job.company, title: job.title, location: job.location ?? null };

  // 2. Parse the JD.
  if (!loadRequirements(d, job.id)) {
    const m = await modelUp("jd_parse");
    if (!m.up) return stop("parse", m.spec.role, `${m.spec.model} is not running`);
    await parseJob(d, job.id);
    steps.push({ step: "parse", status: "done" });
  } else {
    steps.push({ step: "parse", status: "cached" });
  }

  // 3. Judge and score.
  const bank = requireBank();
  const extra = loadSkillsExtra();
  const req = loadRequirements(d, job.id)!;
  const open = needsJudgeCount(d, req, bank, extra);
  const settled = open > 0 ? judgeSettled(req, bank, extra, loadVerdicts(d, req, bank, extra), openRequirements(d, req, bank, extra)) : null;
  if (open > 0 && !settled) {
    const m = await modelUp("judge");
    if (!m.up) return stop("judge", m.spec.role, `${open} requirements need the judge; ${m.spec.model} is not running`);
  }
  const scored = await score(d, job.id, open > 0);
  steps.push({ step: "judge", status: settled ? "skipped" : open > 0 ? "done" : "cached",
    detail: `${scored.score} (${scored.band})${settled ? `; not needed: ${settled}` : ""}` });
  const scoreOut = { score: scored.score, band: scored.band, years: scored.hard, ask_user: scored.ask_user };

  // 4. Decide; reword only for adapt.
  const plan = tailorAll(d, { jobId: job.id }).rows[0];
  if (plan.decision === "adapt" && plan.to_reword > 0 && !plan.blocked) {
    const m = await modelUp("reword");
    if (!m.up) return { ...stop("tailor", m.spec.role, `${plan.to_reword} bullets to reword; ${m.spec.model} is not running`), ...base, ...scoreOut, decision: plan.decision };
  }
  const t = await tailor(d, job.id, { force: opts.force });
  if (!("created" in t)) throw new Error("tailor returned a dry run");
  steps.push({ step: "tailor", status: t.created ? "done" : "cached", detail: `${t.decision}: ${t.reason}` });
  const result = { ...base, ...scoreOut, decision: t.decision, reason: t.reason, resume_id: t.resume_id,
    record: t.path, questions: t.questions, lint: t.lint, error: t.error };
  if (t.decision === "blocked") return out({ ...result, next: ["answer the questions (or add --force), then run the same command again"] });

  // 5. PDF, for a tailored or reused resume.
  if (opts.render === false || !t.resume_id || t.decision === "not_tailored") {
    steps.push({ step: "render", status: "skipped" });
    return out(result);
  }
  const pdf = await render(d, t.resume_id);
  steps.push({ step: "render", status: pdf.ok ? "done" : "stopped", detail: pdf.ok ? undefined : `parse-back failed: ${pdf.issues.map((i) => i.code).join(", ")}` });
  return out({ ...result, pdf: pdf.path, pdf_issues: pdf.issues });
}

// ATS check (render/ats.ts): the local readers on the fake resume, or on a record. Issues
// are codes and ids, never resume text.
export async function ats(d: Db, opts: { resumeId?: string }) {
  if (!opts.resumeId) return atsCheck();
  const bank = requireBank();
  const record = loadRecords(d, bank).records.find((r) => r.resume_id === opts.resumeId);
  if (!record) throw new Error(`no record ${opts.resumeId}`);
  return atsCheck({ record, bank });
}

// Compares what a site's resume autofill showed for the fake resume (a JSON file filled in
// by hand after an upload test) with what it should show.
export function atsCompare(file: string) {
  return compareReport(JSON.parse(readFileSync(file, "utf8")) as Reported);
}

// Which model each task uses and whether its server is up (config/models.yaml).
export async function models() {
  return Promise.all(TASKS.map(async (task) => {
    const { up, spec } = await modelUp(task);
    return { task, model: spec.model, role: spec.role, timeout_s: spec.timeoutMs / 1000, max_tokens: spec.maxTokens ?? null, up };
  }));
}

// The model call log (data/model-calls.jsonl) per task: outcomes, timing, tokens.
export function modelStats(opts: { since?: string } = {}) {
  const path = modelLogPath();
  const rows = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRecord).filter((r) => !opts.since || r.at >= opts.since)
    : [];
  const by = new Map<string, CallRecord[]>();
  for (const r of rows) by.set(`${r.task} ${r.model}`, [...(by.get(`${r.task} ${r.model}`) ?? []), r]);
  const pct = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0;
  return {
    log: path,
    calls: rows.length,
    tasks: [...by].map(([key, rs]) => {
      const [task, model] = key.split(" ");
      const outcomes: Record<string, number> = {};
      for (const r of rs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      const ms = rs.map((r) => r.ms);
      return {
        task, model, calls: rs.length, outcomes,
        avg_s: Math.round(ms.reduce((a, b) => a + b, 0) / rs.length / 100) / 10,
        p95_s: Math.round(pct(ms, 95) / 100) / 10,
        prompt_tokens: rs.reduce((n, r) => n + (r.prompt_tokens ?? 0), 0),
        completion_tokens: rs.reduce((n, r) => n + (r.completion_tokens ?? 0), 0)
      };
    })
  };
}
