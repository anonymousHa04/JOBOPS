// The report loop (POST /x/fix), one step per chat report, and your choice at the end:
// 1. The chat's report is reviewed; JobOps fixes what it can through the guard and re-scores.
// 2. The chat always sees the version this round made, with what really changed, and the next
//    round builds on it, even when it scores lower: the chat can react to the edit. (Showing it
//    the best version again sent an identical resume every round, so the chat repeated itself
//    and the loop went nowhere, 2026-11-07.) The best version (ties go to the newer one) is
//    tracked apart; only it can be offered at the end.
// 3. It stops when nothing the loop can fix is left (the rest needs your facts), when a round
//    changes nothing, when it makes a version this check already had (it goes in circles), on
//    an error, or after MAX_ROUNDS fix rounds.
// 4. At the end your resume from before the check is current again: if the best version scores
//    the same or higher, it waits as the candidate until you choose (decideCheck). Only the
//    version you choose gets its PDF, so a check never changes your resume behind your back.
import type { Db } from "../db.ts";
import { render as renderPdf, tailor } from "../tools.ts";
import { fixRound } from "./loop.ts";
import type { FixResult } from "./loop.ts";
import { followUpPrompt, latestRecord } from "./reports.ts";
import type { Report } from "./reports.ts";
import { engineScore, loadLoop, makeCurrent, saveLoop, setChatScore, startLoop, summary } from "./rounds.ts";
import type { Loop } from "./rounds.ts";

export const MAX_ROUNDS = 5;

export type StepDeps = { retailor?: typeof tailor; render?: (resumeId: string) => Promise<unknown> };
export type StepResult = { fix: FixResult | null; prompt: string | null; loop?: ReturnType<typeof summary> };

// Points of this round's report the loop can act on: valid ones that do not need your facts.
const actionable = (fix: FixResult) => fix.review.valid - (fix.review.causes.needs_facts ?? 0);

// Fix steps running now, by "<job>:<source>" (one API process): Restart check waits for them.
const running = new Set<string>();
export const checkRunning = (jobId: string, source: string) => running.has(`${jobId}:${source}`);

export async function fixStep(db: Db, jobId: string, round: number, source: string, report: Report, deps: StepDeps = {}): Promise<StepResult> {
  const key = `${jobId}:${source}`;
  running.add(key);
  try {
    return await fixStepRun(db, jobId, round, source, report, deps);
  } finally {
    running.delete(key);
  }
}

async function fixStepRun(db: Db, jobId: string, round: number, source: string, report: Report, deps: StepDeps): Promise<StepResult> {
  const saved = loadLoop(jobId, source);
  const loop: Loop = round === 1 || !saved ? startLoop(db, jobId, source) : saved;
  const shown = latestRecord(db, jobId);
  if (shown) setChatScore(loop, shown.resume_id, report.fit_score);
  const finish = (stopped: NonNullable<Loop["stopped"]>): StepResult => {
    loop.stopped = stopped;
    const start = loop.versions[0];
    loop.candidate = loop.best && loop.best.version > 0 && loop.best.engine_score >= start.engine_score ? loop.best : null;
    loop.decision = null;
    makeCurrent(db, start.resume_id); // unchanged until you choose
    saveLoop(loop);
    return { fix: null, prompt: null, loop: summary(loop) };
  };
  if (round > MAX_ROUNDS) return finish("round_limit");
  try {
    const fix = await fixRound(db, jobId, round, report, deps.retailor);
    const after = fix.error ? null : latestRecord(db, jobId);
    if (!after) return { ...finish("error"), fix };
    if (!fix.changed) return { ...finish(actionable(fix) > 0 ? "no_change" : "covered"), fix };
    if (loop.versions.some((v) => v.resume_id === after.resume_id)) return { ...finish("repeat"), fix };
    const entry = { version: round, resume_id: after.resume_id, engine_score: engineScore(db, jobId, after), chat_score: null, needs_facts: fix.needs_facts };
    loop.versions.push(entry);
    if (!loop.best || entry.engine_score >= loop.best.engine_score) {
      loop.best = { version: entry.version, resume_id: entry.resume_id, engine_score: entry.engine_score };
    }
    if (actionable(fix) === 0) return { ...finish("covered"), fix };
    if (round >= MAX_ROUNDS) return { ...finish("round_limit"), fix };
    saveLoop(loop);
    // The new version is current (fixRound made it so): the prompt carries it and its changes.
    return { fix, prompt: followUpPrompt(db, jobId, round + 1, fix, MAX_ROUNDS), loop: summary(loop) };
  } catch (err) {
    finish("error"); // your resume is current again, whatever was written
    throw err;
  }
}

// Your choice at the end of a check: "new" takes the candidate, "previous" keeps the resume the
// check started from, or resume_id picks any version of the check (the rounds table's Choose
// this). The chosen version becomes your resume; a version other than the one you started
// with gets its PDF. Returns the resume that is current now.
export type Choice = { use?: "new" | "previous"; resume_id?: string };

// Render a resume; null when the PDF was made, else why not (the issue codes, bank_gate also
// with its "<id>: <codes>" detail, never resume text).
async function renderError(render: (resumeId: string) => Promise<unknown>, resumeId: string): Promise<string | null> {
  try {
    const r = await render(resumeId) as { ok?: boolean; error?: string | null; issues?: { code: string; extractor: string; detail: string }[] } | undefined;
    if (!r || r.ok !== false) return null;
    const codes = [...new Set((r.issues ?? []).map((i) => i.code === "bank_gate" ? `bank_gate: ${i.detail}` : `${i.code} (${i.extractor})`))].join(", ");
    return r.error ?? (codes || "the PDF did not pass the checks");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function decideCheck(db: Db, jobId: string, source: string, choice: Choice,
  render: (resumeId: string) => Promise<unknown> = (id) => renderPdf(db, id)): Promise<{ resume_id: string; version: number; pdf_error: string | null }> {
  const loop = loadLoop(jobId, source);
  if (!loop || !loop.stopped) throw new Error("no finished check for this job");
  const start = loop.versions[0];
  const chosen = choice.resume_id ?? (choice.use === "new" ? loop.candidate?.resume_id : choice.use === "previous" ? start.resume_id : undefined);
  if (!chosen) throw new Error("this check has no new version to use");
  const v = loop.versions.find((x) => x.resume_id === chosen);
  if (!v) throw new Error("not a version of this check");
  makeCurrent(db, chosen);
  const pdf_error = chosen !== start.resume_id ? await renderError(render, chosen) : null;
  loop.decision = chosen === start.resume_id ? "previous" : choice.use === "new" ? "new" : "chosen";
  loop.chosen = chosen;
  saveLoop(loop);
  return { resume_id: chosen, version: v.version, pdf_error };
}

// Choose any tailored resume of the job (the Check tab's list): it becomes the resume, its PDF
// is made again (so one made before the bank gate is checked now), and every check of the job is marked chosen, so the next one starts a new
// chat. Refused for a resume of another job.
export async function chooseResume(db: Db, jobId: string, resumeId: string,
  render: (resumeId: string) => Promise<unknown> = (id) => renderPdf(db, id)): Promise<{ pdf_error: string | null }> {
  const row = db.prepare("SELECT 1 FROM resume_records WHERE resume_id = ? AND jd_id = ? AND decision NOT IN ('original', 'not_tailored')").get(resumeId, jobId);
  if (!row) throw new Error("not a resume of this job");
  makeCurrent(db, resumeId);
  const pdf_error = await renderError(render, resumeId);
  for (const source of ["claude", "chatgpt"]) {
    const loop = loadLoop(jobId, source);
    if (loop) { loop.decision = "chosen"; loop.chosen = resumeId; saveLoop(loop); }
  }
  return { pdf_error };
}
