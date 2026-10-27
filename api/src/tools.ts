// Operations shared by the CLI (cli.ts) and the MCP server (mcp/server.ts).
// Results are ids, counts, scores, and questions: never resume or bullet text.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import type { Db } from "./db.ts";
import {
  addBullet,
  addSkill,
  buildBank,
  checkBank,
  dismissRisk,
  bankDedupe,
  loadBank,
  loadPreferences,
  retagBank,
  loadSkillsExtra,
  recordLearnable,
  resumeTextPath,
  saveBank
} from "./profile/bank.ts";
import { loadRequirements, parseJob } from "./requirements/parse.ts";
import { riskCheck } from "./scoring/risk.ts";
import { judgeRequirements, loadVerdicts } from "./scoring/judge.ts";
import { allBullets, scoreJob } from "./scoring/score.ts";
import { loadRecords } from "./tailor/records.ts";
import { dryRunAll, tailorJob } from "./tailor/tailor.ts";
import { renderRecord } from "./render/render.ts";
import { lintRecord } from "./tailor/lint.ts";

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
  const r = await buildBank();
  return { ...bankStatus(), ok: r.ok, issues: r.issues };
}

// Add tags to bullets with fewer than 5, only tags the bullet's text names (local model).
export async function bankRetag() {
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

export function skillAdd(name: string, have: boolean, evidence: string) {
  addSkill(name, have ? "have" : "dont_have", evidence);
  return { skill: name.toLowerCase(), status: have ? "have" : "dont_have" };
}

export function bulletAdd(entryId: string, text: string, tags: string[], impact: "high" | "medium" | "low", opts: { topic?: string; evidence?: string } = {}) {
  return { id: addBullet(entryId, text, tags, impact, opts) };
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

export function jdParse(d: Db, jobId: string) {
  return parseJob(d, jobId);
}

// Parses every job that has no requirements yet, one model call at a time.
export async function jdParseAll(d: Db, limit: number) {
  const jobs = listJobs(d, { unparsed: true, limit });
  const done: string[] = [];
  const failed: { job_id: string; error: string }[] = [];
  for (const j of jobs) {
    try {
      await parseJob(d, j.id);
      done.push(j.id);
    } catch (err) {
      failed.push({ job_id: j.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { parsed: done.length, failed };
}

// Score with the LLM judge for requirements the index cannot settle (cached verdicts
// first). judge=false scores with cached verdicts only (no model calls).
export async function score(d: Db, jobId: string, judge = true) {
  const req = loadRequirements(d, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = requireBank();
  const extra = loadSkillsExtra();
  if (!judge) return { ...scoreJob(d, jobId, loadVerdicts(d, req, bank, extra)), judge: "off (cached verdicts only)" };
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
  const { verdicts, stats } = await judgeRequirements(d, req, bank, extra);
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
