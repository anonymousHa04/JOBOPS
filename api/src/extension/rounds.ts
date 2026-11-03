// The score record of one job's report loop (ids, scores, requirement names; never text) and
// the engine score of a resume record.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Db } from "../db.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadBank } from "../profile/bank.ts";
import { loadSkillsExtra } from "../profile/bank.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { scoreRequirements } from "../scoring/score.ts";
import { latestRecord, reportsDir } from "./reports.ts";
import type { ResumeRecord } from "../profile/schema.ts";

export type RoundEntry = { version: number; resume_id: string; engine_score: number; chat_score: number | null; needs_facts: string[] };
export type Loop = { job_id: string; source: string; versions: RoundEntry[]; best: { version: number; resume_id: string; engine_score: number } | null; stopped: null | "no_gain" | "round_limit" | "error" };

export function engineScore(db: Db, jobId: string, record: ResumeRecord): number {
  const req = loadRequirements(db, jobId);
  if (!req) throw new Error("parse the JD first: jd parse <job_id>");
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");
  const extra = loadSkillsExtra();
  const verdicts = loadVerdicts(db, req, bank, extra);
  const recordBulletIds = record.content.bullets.map((b) => b.id);
  return scoreRequirements(req, bank, extra, recordBulletIds, jobId, verdicts).score;
}

export function loopPath(jobId: string, source: string): string {
  return join(reportsDir(), `${jobId}.${source}.loop.json`);
}

export function loadLoop(jobId: string, source: string): Loop | null {
  const path = loopPath(jobId, source);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const result = z.object({
    job_id: z.string(),
    source: z.string(),
    versions: z.array(z.object({
      version: z.number(),
      resume_id: z.string(),
      engine_score: z.number(),
      chat_score: z.number().nullable(),
      needs_facts: z.array(z.string())
    })),
    best: z.object({
      version: z.number(),
      resume_id: z.string(),
      engine_score: z.number()
    }).nullable(),
    stopped: z.union([z.literal(null), z.literal("no_gain"), z.literal("round_limit"), z.literal("error")])
  }).safeParse(JSON.parse(content));
  return result.success ? result.data : null;
}

export function saveLoop(loop: Loop): void {
  const path = loopPath(loop.job_id, loop.source);
  writeFileSync(path, JSON.stringify(loop, null, 1));
}

export function startLoop(db: Db, jobId: string, source: string): Loop {
  const record = latestRecord(db, jobId);
  if (!record) throw new Error("no tailored resume for this job");
  const engineScoreValue = engineScore(db, jobId, record);
  const initialEntry: RoundEntry = {
    version: 0,
    resume_id: record.resume_id,
    engine_score: engineScoreValue,
    chat_score: null,
    needs_facts: []
  };
  return {
    job_id: jobId,
    source,
    versions: [initialEntry],
    best: { version: 0, resume_id: record.resume_id, engine_score: engineScoreValue },
    stopped: null
  };
}

// The chat scored the resume it was shown; a report without fit_score changes nothing.
export function setChatScore(loop: Loop, resumeId: string, score: number | null | undefined): void {
  const entry = loop.versions.find(e => e.resume_id === resumeId);
  if (entry && typeof score === "number") entry.chat_score = score;
}

// The best version becomes the job's current resume again: latestRecord picks the newest
// created_at. The YAML record is the truth (loadRecords rebuilds the index from it), so the
// date changes there as well as in the index; the content hash does not cover created_at.
export function makeCurrent(db: Db, resumeId: string): void {
  const row = db.prepare("SELECT path, jd_id FROM resume_records WHERE resume_id = ?").get(resumeId) as { path: string; jd_id: string } | undefined;
  // Strictly after the job's newest record: a tie on created_at would go to the newer row.
  const newest = row ? (db.prepare("SELECT MAX(created_at) AS t FROM resume_records WHERE jd_id = ?").get(row.jd_id) as { t: string | null }).t : null;
  const now = new Date(Math.max(Date.now(), newest ? Date.parse(newest) + 1 : 0)).toISOString();
  if (row && existsSync(row.path)) {
    const record = parse(readFileSync(row.path, "utf8")) as Record<string, unknown>;
    writeFileSync(row.path, stringify({ ...record, created_at: now }));
  }
  db.prepare("UPDATE resume_records SET created_at = ? WHERE resume_id = ?").run(now, resumeId);
}

export function summary(loop: Loop) {
  return {
    rounds: loop.versions,
    best: loop.best,
    stopped: loop.stopped
  };
}
