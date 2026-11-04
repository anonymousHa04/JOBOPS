// Read models for the web UI (ui/): the board, one job's detail, and how its score was made.
// Queue tables (queue_tasks, job_filter) belong to the Go queue server and may be missing
// (fresh or test databases): every read of them checks first.
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { loadBank, loadSkillsExtra } from "../profile/bank.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { allBullets, scoreRequirements } from "../scoring/score.ts";
import {
  BANDS,
  CAP_ONE_MISSING,
  CAP_TWO_MISSING,
  CREDIT,
  MUST_KEYWORD_WEIGHT,
  MUST_MISSING_BELOW,
  PARTS,
  TAILORED_BANDS
} from "../scoring/config.ts";
import { tailorAll } from "../tools.ts";

export const APP_STATUSES = ["interested", "applied", "interview", "offer", "rejected", "withdrawn"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

// Pipeline state of a job, from its newest queue tasks and stored data.
export type Pipeline = "new" | "parsing" | "scoring" | "tailoring" | "parsed" | "to_tailor" | "not_tailored" | "tailored" | "failed" | "skipped";

type TaskRow = {
  job_id: string; batch_id: number; stage: string; state: string; attempts: number; worker: string | null;
  error_code: string | null; error_detail: string | null; result: string | null; final: number; updated_at: string;
};

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function json(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tasksByJob(db: Db, jobId?: string): Map<string, TaskRow[]> {
  const out = new Map<string, TaskRow[]>();
  if (!hasTable(db, "queue_tasks")) return out;
  const sql = `SELECT job_id, batch_id, stage, state, attempts, worker, error_code, error_detail, result, final, updated_at
    FROM queue_tasks WHERE job_id NOT LIKE 'batch:%'`;
  const rows = (jobId
    ? db.prepare(`${sql} AND job_id = ? ORDER BY updated_at`).all(jobId)
    : db.prepare(`${sql} ORDER BY updated_at`).all()) as TaskRow[];
  for (const r of rows) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r]);
  return out;
}

function filters(db: Db, jobId?: string): Map<string, { ok: boolean; reason: string; checked_at: string }> {
  const out = new Map<string, { ok: boolean; reason: string; checked_at: string }>();
  if (!hasTable(db, "job_filter")) return out;
  const rows = (jobId
    ? db.prepare("SELECT job_id, ok, reason, checked_at FROM job_filter WHERE job_id = ?").all(jobId)
    : db.prepare("SELECT job_id, ok, reason, checked_at FROM job_filter").all()) as
    { job_id: string; ok: number; reason: string; checked_at: string }[];
  for (const r of rows) out.set(r.job_id, { ok: r.ok === 1, reason: r.reason, checked_at: r.checked_at });
  return out;
}

// Newest task per stage decides the state; a failure only counts when it is final.
function pipelineOf(tasks: TaskRow[], parsed: boolean, tailoredRecord: boolean, skipped: boolean) {
  const last = new Map<string, TaskRow>();
  for (const t of tasks) last.set(t.stage, t);
  const scoreRes = json(last.get("score")?.result ?? null);
  const tailorRes = json(last.get("tailor")?.result ?? null);
  const failed = [...last.values()].find((t) => t.state === "failed" && t.final === 1);
  const base = {
    score: typeof scoreRes?.score === "number" ? scoreRes.score : null,
    band: typeof scoreRes?.band === "string" ? scoreRes.band : null,
    decision: (typeof tailorRes?.decision === "string" ? tailorRes.decision : null) ??
      (typeof scoreRes?.decision === "string" ? scoreRes.decision : null),
    error_code: failed?.error_code ?? null,
    failed_stage: failed?.stage ?? null
  };
  let state: Pipeline;
  const open = ["parse", "score", "tailor"].find((s) => last.get(s)?.state === "queued" || last.get(s)?.state === "leased");
  if (open) state = open === "parse" ? "parsing" : open === "score" ? "scoring" : "tailoring";
  else if (failed) state = "failed";
  else if (tailoredRecord || (last.get("tailor")?.state === "done" && base.decision !== "not_tailored")) state = "tailored";
  else if (base.decision === "not_tailored") state = "not_tailored";
  else if (base.decision === "reuse" || base.decision === "adapt") state = "to_tailor";
  else if (skipped) state = "skipped";
  else if (parsed || last.get("parse")?.state === "done") state = "parsed";
  else state = "new";
  return { state, ...base };
}

export type Card = {
  id: string; title: string; company: string; location: string | null; source_name: string | null;
  first_seen_at: string; state: Pipeline; score: number | null; band: string | null; decision: string | null;
  error_code: string | null; failed_stage: string | null; skip_reason: string | null;
  application: AppStatus | null; open_tasks: number;
};

export function board(db: Db): Card[] {
  const jobs = db.prepare(
    "SELECT id, title, company, location, source_name, first_seen_at FROM jobs ORDER BY first_seen_at DESC"
  ).all() as { id: string; title: string; company: string; location: string | null; source_name: string | null; first_seen_at: string }[];
  const parsed = new Set((db.prepare("SELECT DISTINCT job_id FROM job_requirements").all() as { job_id: string }[]).map((r) => r.job_id));
  const tailored = new Set((db.prepare("SELECT DISTINCT jd_id FROM resume_records WHERE decision != 'not_tailored'").all() as { jd_id: string }[]).map((r) => r.jd_id));
  const apps = new Map((db.prepare("SELECT job_id, status FROM applications").all() as { job_id: string; status: AppStatus }[]).map((r) => [r.job_id, r.status]));
  const open = new Map((db.prepare("SELECT job_id, COUNT(*) AS n FROM application_tasks WHERE done = 0 GROUP BY job_id").all() as { job_id: string; n: number }[]).map((r) => [r.job_id, r.n]));
  const tasks = tasksByJob(db);
  const filter = filters(db);
  return jobs.map((j) => {
    const f = filter.get(j.id);
    const skipped = !!f && !f.ok;
    const p = pipelineOf(tasks.get(j.id) ?? [], parsed.has(j.id), tailored.has(j.id), skipped);
    return { ...j, ...p, skip_reason: skipped ? f.reason : null, application: apps.get(j.id) ?? null, open_tasks: open.get(j.id) ?? 0 };
  });
}

export function jobDetail(db: Db, id: string) {
  const job = db.prepare(
    "SELECT id, title, company, location, source_url, source_name, employment_type, seniority, posted_at, first_seen_at, last_seen_at, description FROM jobs WHERE id = ?"
  ).get(id) as Record<string, unknown> | undefined;
  if (!job) return null;
  const tasks = tasksByJob(db, id).get(id) ?? [];
  const f = filters(db, id).get(id) ?? null;
  const req = db.prepare("SELECT prompt_version, created_at FROM job_requirements WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as
    { prompt_version: string; created_at: string } | undefined;
  const resumes = db.prepare(
    "SELECT resume_id, decision, band, score, path, created_at FROM resume_records WHERE jd_id = ? ORDER BY created_at DESC"
  ).all(id);
  const p = pipelineOf(tasks, !!req, resumes.some((r) => (r as { decision: string }).decision !== "not_tailored"), !!f && !f.ok);
  return {
    job,
    ...p,
    filter: f,
    parsed: req ?? null,
    tasks: tasks.map((t) => ({ ...t, result: json(t.result), final: t.final === 1 })),
    resumes,
    application: application(db, id)
  };
}

// The score as the engine computes it now (cached judge verdicts only, never a model call),
// with every weight it used, so the UI can show the arithmetic.
export function scoreDetail(db: Db, id: string) {
  const req = loadRequirements(db, id);
  if (!req) return { error: "not_parsed", message: "This job has not been parsed yet." };
  const bank = loadBank();
  if (!bank) return { error: "no_bank", message: "No experience bank: run bank build." };
  const extra = loadSkillsExtra();
  const verdicts = loadVerdicts(db, req, bank, extra);
  const r = scoreRequirements(req, bank, extra, undefined, id, verdicts);
  // The decision needs preferences.yaml (budget); without it the score still shows.
  let plan: ReturnType<typeof tailorAll>["rows"][number] | null = null;
  let planError: string | null = null;
  try {
    plan = tailorAll(db, { jobId: id }).rows[0] ?? null;
  } catch (err) {
    planError = err instanceof Error ? err.message : String(err);
  }
  const text = new Map(allBullets(bank).map((b) => [b.id, b.text]));
  const items = r.items.map((i) => ({ ...i, evidence: i.bullet_ids.map((b) => ({ id: b, text: text.get(b) ?? "" })) }));

  const reasons: string[] = [];
  if (!r.hard.pass) reasons.push(`Asks for ${r.hard.years_asked}+ years; the bank shows ${r.hard.years_have}. Years are the one hard limit.`);
  if (r.cap !== null) reasons.push(`${r.missing_must} must-have(s) below ${MUST_MISSING_BELOW} credit: the score can be at most ${r.cap}.`);
  if (!TAILORED_BANDS.includes(r.band)) reasons.push(`Band "${r.band}" is below "moderate" (75): only moderate and above get a tailored resume.`);
  if (plan?.unjudged) reasons.push(`${plan.unjudged} requirement(s) still need the judge: they count as unknown (0 credit) until judged.`);
  if (plan?.blocked) reasons.push("The risk gate blocked tailoring: answer the open risk questions first.");
  if (plan?.unsupported_must_haves?.length) reasons.push(`Unsupported must-haves: ${plan.unsupported_must_haves.join("; ")}.`);
  if (planError) reasons.push(`Tailoring decision unavailable: ${planError}`);

  return {
    score: r.score, band: r.band, hard: r.hard, cap: r.cap, missing_must: r.missing_must, tailorable: r.tailorable,
    parts: r.parts, coverage: r.coverage, items, ask_user: r.ask_user.map((a) => a.skill),
    decision: plan ? { decision: plan.decision, equivalence: plan.equivalence, to_reword: plan.to_reword, blocked: plan.blocked, unjudged: plan.unjudged } : null,
    reasons,
    weights: {
      parts: PARTS, credit: CREDIT, must_missing_below: MUST_MISSING_BELOW, cap_one: CAP_ONE_MISSING, cap_two: CAP_TWO_MISSING,
      must_keyword_weight: MUST_KEYWORD_WEIGHT, bands: BANDS, tailored_bands: TAILORED_BANDS
    }
  };
}

export function application(db: Db, jobId: string) {
  const app = db.prepare("SELECT status, note, applied_at, updated_at FROM applications WHERE job_id = ?").get(jobId) as
    { status: AppStatus; note: string | null; applied_at: string | null; updated_at: string } | undefined;
  const tasks = db.prepare("SELECT id, text, done, created_at FROM application_tasks WHERE job_id = ? ORDER BY created_at").all(jobId) as
    { id: string; text: string; done: number; created_at: string }[];
  return { status: app?.status ?? null, note: app?.note ?? null, applied_at: app?.applied_at ?? null, updated_at: app?.updated_at ?? null,
    tasks: tasks.map((t) => ({ ...t, done: t.done === 1 })) };
}

export function jobExists(db: Db, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id);
}

// status null removes the job from the tracker.
export function setApplication(db: Db, jobId: string, status: AppStatus | null, note?: string | null) {
  const now = new Date().toISOString();
  if (status === null) {
    db.prepare("DELETE FROM applications WHERE job_id = ?").run(jobId);
    return application(db, jobId);
  }
  db.prepare(
    `INSERT INTO applications (job_id, status, note, applied_at, updated_at) VALUES (@job_id, @status, @note, @applied_at, @now)
     ON CONFLICT (job_id) DO UPDATE SET status = @status, note = COALESCE(@note, note),
       applied_at = COALESCE(applied_at, @applied_at), updated_at = @now`
  ).run({ job_id: jobId, status, note: note ?? null, applied_at: status === "interested" ? null : now, now });
  return application(db, jobId);
}

export function addPrepTask(db: Db, jobId: string, text: string) {
  db.prepare("INSERT INTO application_tasks (id, job_id, text, done, created_at) VALUES (?, ?, ?, 0, ?)").run(randomUUID(), jobId, text, new Date().toISOString());
  return application(db, jobId);
}

export function setPrepTask(db: Db, jobId: string, taskId: string, patch: { done?: boolean; remove?: boolean }) {
  if (patch.remove) db.prepare("DELETE FROM application_tasks WHERE id = ? AND job_id = ?").run(taskId, jobId);
  else if (patch.done !== undefined) db.prepare("UPDATE application_tasks SET done = ? WHERE id = ? AND job_id = ?").run(patch.done ? 1 : 0, taskId, jobId);
  return application(db, jobId);
}
