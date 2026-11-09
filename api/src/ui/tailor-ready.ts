// Tailor now and Rescore all (UI). A rescore only updates a job's score; tailoring starts when
// the user asks for it, once the job reaches a tailoring band (75+); open gap questions do not
// block it. Rescore all re-scores the jobs below the tailoring bands after the user's files
// (bank, added skills, spellings) changed since the last Rescore all.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { bankPath, loadBank, loadPreferences, loadSkillsExtra, skillsExtraPath } from "../profile/bank.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { TAILORED_BANDS } from "../scoring/config.ts";
import type { Band } from "../scoring/config.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { loadRecords } from "../tailor/records.ts";
import { planJob } from "../tailor/tailor.ts";
import { board, jobDetail, scoreDetail } from "./data.ts";
import { gapList } from "./gaps.ts";
import { latestRecord } from "../extension/reports.ts";
import { wordingApproved } from "../render/exit-gate.ts";
import { lastVerifierIssues } from "../render/render.ts";
import { reviewItems } from "../render/verify.ts";
import type { VerifyKind } from "../render/verify-approvals.ts";

// What Tailor now would do, worked out the way the tailor does it (cached judge verdicts, no
// model calls, no files). It decides on the job's score (one score, as on the Score tab), so
// besides the band it can only stop on the years check or open risk questions.
export type ResumePlan = {
  decision: string; reason: string;
  open_risks: string[];    // risk questions that stop an adapt (blocked)
};

// The last tailor run for this job, so the drawer can say why it did not make a resume.
// left_out: bank bullets the gate kept off the resume (ids and codes), when the run had any.
export type LastTailor = { at: string; state: string; ok: boolean; message: string; left_out?: { bullet_id: string; codes: string[] }[] };

export type TailorStatus = {
  score: number | null; band: string | null;
  open_questions: number; tailored: boolean; busy: boolean;
  ready: boolean;      // "Ready for tailor": score 75+, the tailor would make a resume, not tailored yet (open gap questions do not block)
  can_tailor: boolean; // the button is enabled (also Re-tailor for a tailored job)
  reasons: string[];   // why the button is disabled
  plan: ResumePlan | null;
  last: LastTailor | null;
  // The latest resume's reworded lines whose related keyword waits for approval (exit gate keyword_review).
  pending_review: { resume_id: string; bullet_id: string; keyword: string; text: string }[];
  // The latest resume's items the verifier did not confirm (send to review, A3), from its last
  // render's checks file (no model call): the checked text and, for a skill, its evidence.
  verify_review: { resume_id: string; kind: VerifyKind; id: string; code: string; text: string; evidence?: string }[];
};

function pendingLines(db: Db, jobId: string): TailorStatus["pending_review"] {
  const rec = latestRecord(db, jobId);
  const bank = rec?.pending_review?.length ? loadBank() : null;
  if (!rec || !bank) return [];
  return (rec.pending_review ?? []).filter((p) => !wordingApproved(rec, bank, p)).map((p) => ({
    resume_id: rec.resume_id, ...p, text: rec.content.bullets.find((b) => b.id === p.bullet_id)?.text ?? "" }));
}

function verifyLines(db: Db, jobId: string): TailorStatus["verify_review"] {
  const rec = latestRecord(db, jobId);
  const issues = rec ? lastVerifierIssues(rec.resume_id) : null;
  const bank = issues?.length ? loadBank() : null;
  if (!rec || !issues || !bank) return [];
  return reviewItems(rec, bank, loadSkillsExtra(), issues).map(({ kind, id, code, text, evidence }) => ({
    resume_id: rec.resume_id, kind, id, code, text, ...(evidence !== undefined ? { evidence } : {}) }));
}

export function resumePlan(db: Db, jobId: string): ResumePlan | null {
  const req = loadRequirements(db, jobId);
  const bank = loadBank();
  if (!req || !bank) return null;
  const extra = loadSkillsExtra();
  const verdicts = loadVerdicts(db, req, bank, extra);
  const budget = loadPreferences().tailoring;
  const rows = db.prepare("SELECT id, company FROM jobs").all() as { id: string; company: string }[];
  const byId = new Map(rows.map((r) => [r.id, r.company]));
  const companyOf = (id: string) => byId.get(id);
  const p = planJob(req, jobId, loadRecords(db, bank).records, bank, extra, budget, verdicts, false,
    { company: companyOf(jobId) ?? "", companyOf });
  const d = p.decision;
  return { decision: d.risk_gate.blocked ? "blocked" : d.decision, reason: d.reason, open_risks: d.risk_gate.blocked ? d.risk_gate.open : [] };
}

type Task = ReturnType<typeof jobDetail> extends infer D ? D extends { tasks: (infer T)[] } ? T : never : never;
function lastTailor(tasks: Task[]): LastTailor | null {
  const t = [...tasks].filter((x) => x.stage === "tailor").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!t) return null;
  const at = t.updated_at;
  if (t.state === "failed") return { at, state: t.state, ok: false, message: `failed (${t.error_code ?? "error"}): ${t.error_detail ?? "no detail"}` };
  if (t.state !== "done") return { at, state: t.state, ok: true, message: t.state };
  const r = (t.result ?? {}) as { decision?: string; reason?: string; resume_id?: string | null; created?: boolean; pdf_ok?: boolean | null; pdf_issue?: string;
    left_out?: { bullet_id: string; codes: string[] }[] };
  const left = r.left_out?.length ? { left_out: r.left_out } : {};
  if (r.decision === "not_tailored") return { at, state: t.state, ok: false, message: `not tailored: ${r.reason ?? "below 75"}.` };
  if (r.decision === "blocked") return { at, state: t.state, ok: false, message: `stopped: ${r.reason ?? "open risk questions"}.` };
  if (r.pdf_ok === false) return { at, state: t.state, ok: false, message: `resume ${r.resume_id ?? ""} made (${r.decision}), but the PDF failed: ${r.pdf_issue ?? "parse-back check"}.`, ...left };
  return { at, state: t.state, ok: true, message: `resume ${r.resume_id ?? ""} made (${r.decision})${r.created === false ? ", same bullets as before" : ""}.`, ...left };
}

export function tailorStatus(db: Db, jobId: string): TailorStatus {
  const d = jobDetail(db, jobId);
  if (!d) throw new Error("job not found");
  const s = scoreDetail(db, jobId);
  const score = "score" in s ? (s.score ?? null) : null;
  const band = "band" in s ? (s.band ?? null) : null;
  let open = 0;
  try {
    open = gapList(db, jobId).gaps.filter((g) => !g.answer).length;
  } catch {
    // not parsed or no bank: the score check below already says why
  }
  let plan: ResumePlan | null = null;
  try {
    plan = resumePlan(db, jobId);
  } catch {
    // not parsed, no bank: said below
  }
  const tailored = d.state === "tailored";
  const busy = ["parsing", "scoring", "tailoring"].includes(d.state);
  const inBand = band !== null && TAILORED_BANDS.includes(band as Band);
  const planOk = plan !== null && (plan.decision === "adapt" || plan.decision === "reuse");

  const reasons: string[] = [];
  if (busy) reasons.push(`The job is ${d.state}: wait for it to finish.`);
  if (score === null) reasons.push("Not scored yet.");
  else if (!inBand) reasons.push(`Score ${score.toFixed(1)} (${band}): tailoring needs 75 (moderate) or more.`);
  // Open gap questions never block (user, 2026-11-06): at 75+ the user may tailor now; answering
  // them can still raise the score and change the resume (the Tailor box says so).
  if (inBand && plan && !planOk) {
    if (plan.decision === "blocked") reasons.push(`Open risk questions stop the tailor: ${plan.open_risks.join(", ")}.`);
    else reasons.push(`The tailor would not make a resume: ${plan.reason}.`);
  }
  if (inBand && !plan) reasons.push("Could not work out the resume the tailor would build (no bank or not parsed).");
  const can = !busy && inBand && planOk;
  return {
    score, band, open_questions: open, tailored, busy, ready: can && !tailored, can_tailor: can, reasons, plan,
    last: lastTailor(d.tasks), pending_review: pendingLines(db, jobId), verify_review: verifyLines(db, jobId)
  };
}

// The user's files that change a score. Their fingerprint is compared with the one saved at the
// last Rescore all.
function profileFiles(): string[] {
  const dir = process.env.JOBOPS_PROFILE_DIR ?? "profile";
  return [bankPath(), skillsExtraPath(), join(dir, "synonyms.yaml")];
}

export function profileFingerprint(): string {
  const h = createHash("sha256");
  for (const f of profileFiles()) h.update(f).update("\0").update(existsSync(f) ? readFileSync(f) : "").update("\0");
  return h.digest("hex");
}

const KEY = "rescore_all_fingerprint";

// Jobs Rescore all touches: scored below the tailoring bands and not tailored. Tailored jobs and
// jobs at 75+ are left alone.
export function rescoreCandidates(db: Db): string[] {
  return board(db)
    .filter((c) => c.state === "not_tailored" && c.score !== null && !(c.band !== null && TAILORED_BANDS.includes(c.band as Band)))
    .map((c) => c.id);
}

export function rescoreAllStatus(db: Db): { changed: boolean; candidates: number } {
  const row = db.prepare("SELECT value FROM ui_state WHERE key = ?").get(KEY) as { value: string } | undefined;
  return { changed: row?.value !== profileFingerprint(), candidates: rescoreCandidates(db).length };
}

export function markRescoredAll(db: Db): void {
  db.prepare("INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(KEY, profileFingerprint());
}
