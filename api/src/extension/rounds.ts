// The score record of one job's report loop (ids, scores, requirement names; never text) and
// the engine score of a resume record.
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Db } from "../db.ts";
import { hasMarker, setMarker, takeMarker } from "../db.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadBank } from "../profile/bank.ts";
import { loadSkillsExtra } from "../profile/bank.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { scoreRequirements } from "../scoring/score.ts";
import { latestRecord, reportsDir } from "./reports.ts";
import type { ResumeRecord } from "../profile/schema.ts";

export type RoundEntry = { version: number; resume_id: string; engine_score: number; chat_score: number | null; needs_facts: string[] };
type Version = { version: number; resume_id: string; engine_score: number };
// stopped: covered (nothing left the loop can fix), no_change (a round changed nothing),
// repeat (a round made a version the check already had), round_limit, error; no_gain is from loops before 2026-11-07. candidate: the best version when
// it scores the same or higher than the resume the check started from, waiting for your choice
// (decision).
export type Loop = { job_id: string; source: string; versions: RoundEntry[]; best: Version | null;
  stopped: null | "covered" | "no_change" | "repeat" | "no_gain" | "round_limit" | "error";
  candidate?: Version | null; decision?: null | "new" | "previous" | "chosen"; chosen?: string };

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
    stopped: z.union([z.literal(null), z.literal("covered"), z.literal("no_change"), z.literal("repeat"), z.literal("no_gain"), z.literal("round_limit"), z.literal("error")]),
    candidate: z.object({ version: z.number(), resume_id: z.string(), engine_score: z.number() }).nullable().optional(),
    decision: z.union([z.literal(null), z.literal("new"), z.literal("previous"), z.literal("chosen")]).optional(),
    chosen: z.string().optional()
  }).safeParse(JSON.parse(content));
  return result.success ? result.data : null;
}

export function saveLoop(loop: Loop): void {
  const path = loopPath(loop.job_id, loop.source);
  mkdirSync(reportsDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(loop, null, 1));
}

// Restart the chat check for one site (UI): the loop file is kept under a timestamped name, and
// the next prompt the extension fetches for this site says fresh_chat once (a new chat, round 1).
// Its per-round reports (<job>.<source>.r<n>.yaml) get the same timestamp. The latest report
// <job>.<source>.yaml stays (bank audit reads its fact flags). Returns the archived loop's name.
export function restartLoop(db: Db, jobId: string, source: string): string | null {
  const path = loopPath(jobId, source);
  let archived: string | null = null;
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/:/g, "-");
    archived = `${jobId}.${source}.loop.${stamp}.json`;
    renameSync(path, join(reportsDir(), archived));
    const prefix = `${jobId}.${source}.`;
    for (const f of readdirSync(reportsDir())) {
      const round = f.startsWith(prefix) ? f.slice(prefix.length).match(/^(r\d+)\.yaml$/)?.[1] : undefined;
      if (round) renameSync(join(reportsDir(), f), join(reportsDir(), `${prefix}${round}.${stamp}.yaml`));
    }
  }
  setMarker(db, freshChatKey(jobId, source));
  return archived;
}

const freshChatKey = (jobId: string, source: string) => `fresh_chat:${jobId}:${source}`;
export const hasFreshChat = (db: Db, jobId: string, source: string) => hasMarker(db, freshChatKey(jobId, source));
// True once after restartLoop, then false.
export const takeFreshChat = (db: Db, jobId: string, source: string) => takeMarker(db, freshChatKey(jobId, source));

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
    stopped: loop.stopped,
    candidate: loop.candidate ?? null,
    decision: loop.decision ?? null
  };
}
