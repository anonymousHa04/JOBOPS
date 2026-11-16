// Local review of a chat report's claims (plan-report-loop.md, loop-07): for each claim, why the
// local side missed it and whether it holds. Output is codes, requirement names (JD wording), and
// bullet ids only; never bullet or report text. Every call is appended to the feedback log, so the
// causes can be counted over many jobs (which part of the engine misses most).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "../db.ts";
import { loadBank, loadSkillsExtra } from "../profile/bank.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { loadVerdicts } from "../scoring/judge.ts";
import { scoreRequirements } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { latestRecord } from "./reports.ts";
import type { Report } from "./reports.ts";

export type Finding = {
  kind: "missed_gap" | "already_covered" | "bullet_note";
  item: string;
  verdict: "valid" | "wrong" | "unclear";
  cause: string;
};

// The log of every review (one JSON line per call). JOBOPS_FEEDBACK_LOG lets tests use a temp file.
export const feedbackLog = () => process.env.JOBOPS_FEEDBACK_LOG ?? "data/report-feedback.jsonl";

// The words of a requirement (2+ characters, so "Go" counts), normalized, and whether one appears
// in a text as a whole word ("go" not inside "good").
const words = (s: string) => norm(s).split(/[^a-z0-9+#]+/).filter((w) => w.length >= 2);
const hasWord = (text: string, w: string) =>
  new RegExp(`(^|[^a-z0-9])${w.replace(/[+#]/g, "\\$&")}([^a-z0-9]|$)`).test(text);

export function reviewReport(db: Db, jobId: string, round: number, report: Report): Finding[] {
  const req = loadRequirements(db, jobId);
  const bank = loadBank();
  const job = db.prepare("SELECT description FROM jobs WHERE id = ?").get(jobId) as { description: string } | undefined;
  if (!req || !bank || !job) throw new Error("review needs parsed requirements, a bank, and the job");
  const extra = loadSkillsExtra();
  const verdicts = loadVerdicts(db, req, bank, extra);
  const record = latestRecord(db, jobId);
  const onResume = new Set((record?.content.bullets ?? []).map((b) => b.id));
  const jd = norm(job.description);
  const parsed = new Set([...req.must_have, ...req.nice_to_have, ...req.keywords].map(norm));

  // Credit for one requirement, scored as a must-have, over the whole bank or only some bullets.
  const credit = (r: string, only?: string[]) => {
    const probe = { ...req, must_have: [r], nice_to_have: [], keywords: [], themes: [] };
    const item = scoreRequirements(probe, bank, extra, only, jobId, verdicts).items.find((i) => i.kind === "must");
    return item?.credit ?? 0;
  };

  const findings: Finding[] = [];
  for (const { requirement: r } of report.missed_gaps ?? []) {
    const w = words(r);
    const inJd = w.length > 0 && w.filter((x) => hasWord(jd, x)).length * 2 >= w.length;
    if (!inJd) {
      findings.push({ kind: "missed_gap", item: r, verdict: "wrong", cause: "not_in_jd" });
    } else if (!parsed.has(norm(r))) {
      findings.push({ kind: "missed_gap", item: r, verdict: "valid", cause: "jd_parse_missed" });
    } else {
      const inBank = credit(r) >= 0.5;
      const shown = credit(r, [...onResume]) >= 0.5;
      findings.push(shown
        ? { kind: "missed_gap", item: r, verdict: "wrong", cause: "already_on_resume" }
        : { kind: "missed_gap", item: r, verdict: "valid", cause: inBank ? "selection_dropped" : "needs_facts" });
    }
  }
  for (const { gap, bullet_ids } of report.already_covered ?? []) {
    if (bullet_ids.some((id) => !onResume.has(id))) {
      findings.push({ kind: "already_covered", item: gap, verdict: "wrong", cause: "bullet_not_on_resume" });
    } else {
      findings.push(credit(gap, bullet_ids) >= 0.5
        ? { kind: "already_covered", item: gap, verdict: "valid", cause: "local_list_stale" }
        : { kind: "already_covered", item: gap, verdict: "unclear", cause: "scorer_or_judge_miss" });
    }
  }
  for (const { bullet_id } of report.bullet_notes ?? []) {
    findings.push(onResume.has(bullet_id)
      ? { kind: "bullet_note", item: bullet_id, verdict: "valid", cause: "note_for_reword" }
      : { kind: "bullet_note", item: bullet_id, verdict: "wrong", cause: "bullet_not_on_resume" });
  }

  const log = feedbackLog();
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), job_id: jobId, round, findings }) + "\n");
  return findings;
}
