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
  loadBank,
  loadSkillsExtra,
  recordLearnable,
  resumeTextPath,
  saveBank
} from "./profile/bank.ts";
import { loadRequirements, parseJob } from "./requirements/parse.ts";
import { riskCheck } from "./scoring/risk.ts";
import { allBullets, scoreJob } from "./scoring/score.ts";

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

export function bulletAdd(entryId: string, text: string, tags: string[], impact: "high" | "medium" | "low") {
  return { id: addBullet(entryId, text, tags, impact) };
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

export function score(d: Db, jobId: string) {
  return scoreJob(d, jobId);
}

// Risks over the whole bank until the engine's bullet selection exists.
export function risk(d: Db, jobId: string) {
  const req = loadRequirements(d, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = requireBank();
  const ids = allBullets(bank).map((b) => b.id);
  return { job_id: jobId, risks: riskCheck(req, bank, loadSkillsExtra(), ids, jobId) };
}
