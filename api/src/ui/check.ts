// The drawer's Check tab: is the tailored resume as strong as the job's score says, and what did
// a Claude/ChatGPT check (the extension's report loop) change?
// - resume: the current resume's engine score against the job's (the whole bank's), and each
//   requirement the bank shows but the resume does not (points lost when bullets were picked).
// - loops: per chat, each round's resume, engine and chat score, whether it was kept, and the
//   bullets it added, removed or reworded against the version before.
// - reports: what the chat said that a person should look at (missed gaps, notes, facts from its
//   memory to confirm).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Db } from "../db.ts";
import { loadBank, loadSkillsExtra } from "../profile/bank.ts";
import { ResumeRecordSchema } from "../profile/schema.ts";
import type { ResumeRecord } from "../profile/schema.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { scoreRequirements } from "../scoring/score.ts";
import { pdfDir } from "../render/render.ts";
import { latestRecord, loadReport, SOURCES } from "../extension/reports.ts";
import { loadLoop } from "../extension/rounds.ts";

type Line = { id: string; text: string };
export type CheckRound = {
  version: number; resume_id: string; engine_score: number; chat_score: number | null; kept: boolean; current: boolean;
  added: Line[]; removed: Line[]; reworded: { id: string; before: string; after: string }[];
};
export type ResumeRow = {
  resume_id: string; made_by: string; engine_score: number; chat_score: number | null;
  created_at: string; pdf: boolean; current: boolean;
};
export type CheckView = {
  // Every tailored resume of the job (tailor, re-tailor, each check round), best engine score first.
  resumes: ResumeRow[];
  job_score: number | null; // the whole bank's score: the most a resume for this job can score
  resume: null | {
    resume_id: string; decision: string; engine_score: number; job_score: number; pdf: boolean;
    lost: { requirement: string; kind: string; job_credit: number; resume_credit: number }[];
  };
  loops: {
    source: string; stopped: string | null; rounds: CheckRound[];
    // The best version waiting for your choice (same or higher score than where the check
    // started), what it changes against that start, and your choice once made.
    candidate: null | { resume_id: string; engine_score: number; start_score: number; added: Line[]; removed: Line[]; reworded: { id: string; before: string; after: string }[] };
    decision: null | "new" | "previous" | "chosen"; chosen: string | null;
  }[];
  reports: { source: string; fit_score: number | null; missed_gaps: { requirement: string; why: string }[];
    bullet_notes: { bullet_id: string; note: string }[]; from_memory: { fact: string; fills_gap: string }[] }[];
};

export function recordById(db: Db, resumeId: string): ResumeRecord | null {
  const row = db.prepare("SELECT path FROM resume_records WHERE resume_id = ?").get(resumeId) as { path: string } | undefined;
  if (!row || !existsSync(row.path)) return null;
  const r = ResumeRecordSchema.safeParse(parse(readFileSync(row.path, "utf8")));
  return r.success ? r.data : null;
}

export const hasPdf = (resumeId: string) => existsSync(join(pdfDir(), `${resumeId}.pdf`));

function diff(before: ResumeRecord | null, after: ResumeRecord | null) {
  const was = new Map((before?.content.bullets ?? []).map((b) => [b.id, b.text]));
  const now = new Map((after?.content.bullets ?? []).map((b) => [b.id, b.text]));
  return {
    added: [...now].filter(([id]) => !was.has(id)).map(([id, text]) => ({ id, text })),
    removed: [...was].filter(([id]) => !now.has(id)).map(([id, text]) => ({ id, text })),
    reworded: [...now].filter(([id, text]) => was.has(id) && was.get(id) !== text).map(([id, after]) => ({ id, before: was.get(id)!, after }))
  };
}

export function checkView(db: Db, jobId: string): CheckView {
  const out: CheckView = { resumes: [], job_score: null, resume: null, loops: [], reports: [] };
  const rec = latestRecord(db, jobId);
  const req = loadRequirements(db, jobId);
  const bank = loadBank();
  if (rec && req && bank && rec.decision !== "not_tailored") {
    const extra = loadSkillsExtra();
    const verdicts = loadVerdicts(db, req, bank, extra);
    const job = scoreRequirements(req, bank, extra, undefined, jobId, verdicts);
    const res = scoreRequirements(req, bank, extra, rec.content.bullets.map((b) => b.id), jobId, verdicts);
    const had = new Map(job.items.map((i) => [`${i.kind}|${i.requirement}`, i.credit]));
    out.resume = {
      resume_id: rec.resume_id, decision: rec.decision, engine_score: res.score, job_score: job.score, pdf: hasPdf(rec.resume_id),
      lost: res.items
        .map((i) => ({ requirement: i.requirement, kind: i.kind, job_credit: had.get(`${i.kind}|${i.requirement}`) ?? 0, resume_credit: i.credit }))
        .filter((i) => i.job_credit - i.resume_credit > 1e-9)
    };
  }
  // The job's resumes. Where a check made one, say which round; its chat score if a chat saw it.
  if (req && bank) {
    const extra = loadSkillsExtra();
    const verdicts = loadVerdicts(db, req, bank, extra);
    const made = new Map<string, string>();
    const chat = new Map<string, number>();
    for (const source of SOURCES) {
      for (const v of loadLoop(jobId, source)?.versions ?? []) {
        if (v.version > 0 && !made.has(v.resume_id)) made.set(v.resume_id, `${source === "claude" ? "Claude" : "ChatGPT"} check, round ${v.version}`);
        if (v.chat_score != null) chat.set(v.resume_id, v.chat_score);
      }
    }
    out.job_score = scoreRequirements(req, bank, extra, undefined, jobId, verdicts).score;
    const rows = db.prepare("SELECT resume_id, created_at FROM resume_records WHERE jd_id = ? AND decision NOT IN ('original', 'not_tailored')")
      .all(jobId) as { resume_id: string; created_at: string }[];
    for (const row of rows) {
      const r = recordById(db, row.resume_id);
      if (!r) continue;
      out.resumes.push({
        resume_id: row.resume_id, made_by: made.get(row.resume_id) ?? (r.decision === "reuse" ? "tailor (reused)" : "tailor"),
        engine_score: scoreRequirements(req, bank, extra, r.content.bullets.map((b) => b.id), jobId, verdicts).score,
        chat_score: chat.get(row.resume_id) ?? null, created_at: row.created_at, pdf: hasPdf(row.resume_id),
        current: rec?.resume_id === row.resume_id
      });
    }
    out.resumes.sort((a, b) => b.engine_score - a.engine_score || b.created_at.localeCompare(a.created_at));
  }
  for (const source of SOURCES) {
    const loop = loadLoop(jobId, source);
    if (loop) {
      let prev: ResumeRecord | null = null;
      let bestSoFar = -Infinity;
      const rounds: CheckRound[] = loop.versions.map((v, i) => {
        const r = recordById(db, v.resume_id);
        const d = i === 0 ? { added: [], removed: [], reworded: [] } : diff(prev, r);
        // Kept: as good as the best so far when it was made (ties go to the newer one), as the
        // loop decides; round 0 is the resume the check started from. Changes are against the
        // version before, which is what the chat saw (each round builds on the last one).
        const kept = v.engine_score >= bestSoFar;
        if (kept) bestSoFar = v.engine_score;
        prev = r ?? prev;
        return { version: v.version, resume_id: v.resume_id, engine_score: v.engine_score, chat_score: v.chat_score,
          kept, current: rec?.resume_id === v.resume_id, ...d }; // the job's resume now
      });
      const cand = loop.candidate ?? null;
      const candidate = cand ? { resume_id: cand.resume_id, engine_score: cand.engine_score, start_score: loop.versions[0].engine_score,
        ...diff(recordById(db, loop.versions[0].resume_id), recordById(db, cand.resume_id)) } : null;
      out.loops.push({ source, stopped: loop.stopped, rounds, candidate, decision: loop.decision ?? null, chosen: loop.chosen ?? null });
    }
    const report = loadReport(jobId, source);
    if (report) {
      out.reports.push({ source, fit_score: report.fit_score ?? null, missed_gaps: report.missed_gaps ?? [],
        bullet_notes: report.bullet_notes ?? [], from_memory: report.from_memory ?? [] });
    }
  }
  return out;
}

// "Check with Claude after each tailor" (Check tab; user, 2026-11-08): one switch for all jobs and
// the chat to use. The open JobOps page starts the check when a tailor task made a resume.
export type CheckSettings = { auto_check: boolean; source: "claude" | "chatgpt" };
const SETTINGS_KEY = "check_settings";

export function checkSettings(db: Db): CheckSettings {
  const row = db.prepare("SELECT value FROM ui_state WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  try {
    const v = row ? JSON.parse(row.value) as Partial<CheckSettings> : {};
    return { auto_check: v.auto_check === true, source: v.source === "chatgpt" ? "chatgpt" : "claude" };
  } catch {
    return { auto_check: false, source: "claude" };
  }
}

export function setCheckSettings(db: Db, s: Partial<CheckSettings>): CheckSettings {
  const next = { ...checkSettings(db), ...s };
  db.prepare("INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(SETTINGS_KEY, JSON.stringify(next));
  return checkSettings(db);
}
