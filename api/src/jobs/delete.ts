// Delete a job the user does not want (UI: Delete this job). Its rows go from every table, its
// tailored resumes (record YAML and PDF in profile/) are removed, and its link and content hash
// go on deleted_jobs so a later fetch does not add it again. The queue's tables are the Go
// queue server's: it drops the job's tasks (forgetJob).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { addSkipKeywords, loadPreferences, roleWords } from "../profile/bank.ts";
import { forgetJob } from "../queue/client.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { gapList } from "../ui/gaps.ts";
import { event, plural, warnEvent } from "../log.ts";
import { pdfDir } from "../render/render.ts";
import { recordsDir } from "../tailor/records.ts";
import { publish } from "../events/bus.ts";

export class DeleteRefused extends Error {}

const hasTable = (db: Db, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// Whole-word match, the same rule as jd-search's filter (hasWord in filter.go).
const hasWord = (s: string, phrase: string) =>
  phrase !== "" && new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(s);

// Words that never make a useful reason on their own.
const STOP = new Set(["a", "an", "and", "the", "of", "for", "in", "at", "to", "with", "on", "or", "i", "ii", "iii", "iv",
  "1", "2", "3", "4", "-", "&", "remote", "hybrid", "onsite", "india", "team"]);

// Keyword suggestions for "Why delete it?": the title's words, and this job's red keywords from
// the Gaps tab (gapList: the JD's keywords your bank does not show), minus the words of your own
// target roles (those would skip every job). Without a gap list (not parsed, no bank) the JD's
// parsed keywords stand in. current: saved skip words this job has.
export function deleteHints(db: Db, jobId: string): { title: string[]; keywords: string[]; current: string[]; protected: string[] } {
  const job = db.prepare("SELECT title, description FROM jobs WHERE id = ?").get(jobId) as { title: string; description: string } | undefined;
  if (!job) throw new DeleteRefused("job not found");
  let mine = new Set<string>();
  let current: string[] = [];
  let saved = new Set<string>();
  try {
    const p = loadPreferences();
    mine = roleWords(p);
    // Only the saved skip words this job has (title or description, whole words, as jd-search
    // matches them): it was fetched before they were added. Others say nothing about this job.
    const text = `${job.title}\n${job.description}`.toLowerCase();
    saved = new Set(p.skip_keywords.map((w) => w.trim().toLowerCase()));
    current = [...saved].filter((w) => hasWord(text, w));
  } catch {
    // no preferences.yaml: suggestions without the role guard; saving reports the error
  }
  const ok = (w: string) => w.length > 1 && !STOP.has(w) && !mine.has(w) && !saved.has(w);
  const title = [...new Set(job.title.toLowerCase().split(/[^a-z0-9+#.]+/).filter(ok))];
  let source: string[];
  try {
    source = gapList(db, jobId).gaps.filter((g) => g.kind === "keyword").map((g) => g.requirement);
  } catch {
    source = loadRequirements(db, jobId)?.keywords ?? [];
  }
  const keywords = [...new Set(source.map((k) => k.trim().toLowerCase()).filter(ok))]
    .filter((k) => !title.includes(k)).slice(0, 15);
  return { title, keywords, current, protected: [...mine].filter((w) => !w.includes(" ")).sort() };
}

export type DeleteReason = { reason?: string; keywords?: string[] };

export async function deleteJob(db: Db, jobId: string, why: DeleteReason = {}): Promise<{
  resumes: number; files: number; tasks: number;
  keywords_added: string[]; keywords_refused: string[]; keywords_error: string | null;
}> {
  const job = db.prepare("SELECT id, title, company, source_url, content_hash FROM jobs WHERE id = ?").get(jobId) as
    { id: string; title: string; company: string; source_url: string; content_hash: string } | undefined;
  if (!job) throw new DeleteRefused("job not found");
  // A worker writing this job's score or resume right now would write into a deleted job.
  if (hasTable(db, "queue_tasks")) {
    const leased = db.prepare("SELECT count(*) AS n FROM queue_tasks WHERE job_id = ? AND state = 'leased'").get(jobId) as { n: number };
    if (leased.n > 0) throw new DeleteRefused("A worker is on this job right now: wait for it to finish, then delete.");
  }

  const resumes = db.prepare("SELECT resume_id FROM resume_records WHERE jd_id = ?").all(jobId) as { resume_id: string }[];
  db.transaction(() => {
    const words = [...new Set((why.keywords ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean))];
    db.prepare(`INSERT INTO deleted_jobs (source_url, content_hash, title, company, deleted_at, reason, keywords) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_url) DO UPDATE SET content_hash = excluded.content_hash, deleted_at = excluded.deleted_at, reason = excluded.reason, keywords = excluded.keywords`)
      .run(job.source_url, job.content_hash, job.title, job.company, new Date().toISOString(),
        why.reason?.trim() || null, words.length ? JSON.stringify(words) : null);
    for (const t of ["gap_notes", "application_tasks", "applications", "job_requirements", "kept_jobs"]) {
      db.prepare(`DELETE FROM ${t} WHERE job_id = ?`).run(jobId);
    }
    db.prepare("DELETE FROM resume_records WHERE jd_id = ?").run(jobId);
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  })();

  // Files after the rows: a missing file is fine. Only <resume_id>.yaml/.pdf of this job's
  // records, never a path read from the database.
  let files = 0;
  for (const { resume_id } of resumes) {
    if (!/^[\w-]+$/.test(resume_id)) continue;
    for (const f of [join(recordsDir(), `${resume_id}.yaml`), join(pdfDir(), `${resume_id}.pdf`)]) {
      if (existsSync(f)) { rmSync(f); files++; }
    }
  }
  let tasks = 0;
  try {
    tasks = (await forgetJob(jobId)).removed;
  } catch {
    // Queue down: its rows for this job stay until the next delete; the board shows only jobs
    // that exist, so they are not seen.
  }
  // The reasons, as skip keywords for later batches (preferences.yaml skip_keywords; jd-search
  // re-checks stored jobs before every batch, so matching jobs already fetched are skipped too).
  let added: string[] = [];
  let refused: string[] = [];
  let kwError: string | null = null;
  if (why.keywords?.length) {
    try {
      ({ added, refused } = addSkipKeywords(why.keywords));
    } catch (err) {
      kwError = err instanceof Error ? err.message : String(err);
    }
  }
  event(`job deleted: ${job.company} · ${job.title}${why.reason ? ` (${why.reason})` : ""}`
    + (resumes.length ? `; ${plural(resumes.length, "resume record")} and ${plural(files, "file")} removed` : "")
    + (tasks ? `; ${plural(tasks, "queue task")} forgotten` : ""));
  if (added.length) event(`skip words added: ${added.join(", ")}`);
  if (refused.length) event(`skip words refused (your target-role words): ${refused.join(", ")}`);
  if (kwError) warnEvent(`skip words not saved: ${kwError}`);
  publish({ kind: "job", job_id: jobId, state: "deleted" });
  return { resumes: resumes.length, files, tasks, keywords_added: added, keywords_refused: refused, keywords_error: kwError };
}

// --- Delete every job with a skip word (top bar) ------------------------------------------
// The stored jobs whose title or description has one of the user's skip words (whole words,
// as jd-search matches them) and that are not tailored. Never included: tailored jobs (they
// have resumes), jobs marked applied, interview or offer, and kept jobs.
export type SkipMatch = { id: string; title: string; company: string; word: string; status: string | null; resumes: number };
const KEEP = new Set(["applied", "interview", "offer"]);

export function skipMatches(db: Db): { keywords: string[]; jobs: SkipMatch[]; kept: SkipMatch[] } {
  let keywords: string[] = [];
  try {
    keywords = [...new Set(loadPreferences().skip_keywords.map((w) => w.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return { keywords: [], jobs: [], kept: [] };
  }
  if (!keywords.length) return { keywords, jobs: [], kept: [] };
  const rows = db.prepare(`SELECT j.id, j.title, j.company, j.description, a.status,
      (SELECT count(*) FROM resume_records r WHERE r.jd_id = j.id AND r.decision != 'not_tailored') AS resumes
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
    WHERE j.id NOT IN (SELECT job_id FROM kept_jobs) ORDER BY j.company, j.title`).all() as
    { id: string; title: string; company: string; description: string; status: string | null; resumes: number }[];
  const jobs: SkipMatch[] = [];
  const kept: SkipMatch[] = [];
  for (const r of rows) {
    const text = `${r.title}\n${r.description}`.toLowerCase();
    const word = keywords.find((w) => hasWord(text, w));
    if (!word) continue;
    const m = { id: r.id, title: r.title, company: r.company, word, status: r.status, resumes: r.resumes };
    (r.resumes > 0 || (r.status && KEEP.has(r.status)) ? kept : jobs).push(m);
  }
  return { keywords, jobs, kept };
}

// Deletes the given jobs, but only those that still match a skip word and are not kept (the
// list the user confirmed may be a little old). Each goes through deleteJob, one at a time.
export async function deleteSkipMatches(db: Db, ids: string[]): Promise<{
  deleted: number; resumes: number; files: number; refused: { title: string; company: string; message: string }[]; skipped: number;
}> {
  const now = new Map(skipMatches(db).jobs.map((m) => [m.id, m]));
  const out = { deleted: 0, resumes: 0, files: 0, refused: [] as { title: string; company: string; message: string }[], skipped: 0 };
  for (const id of new Set(ids)) {
    const m = now.get(id);
    if (!m) { out.skipped++; continue; }
    try {
      const r = await deleteJob(db, id, { reason: `skip word: ${m.word}` });
      out.deleted++;
      out.resumes += r.resumes;
      out.files += r.files;
    } catch (err) {
      out.refused.push({ title: m.title, company: m.company, message: err instanceof Error ? err.message : String(err) });
    }
  }
  event(`jobs deleted (skip words): ${out.deleted} of ${new Set(ids).size} ticked; ${plural(out.resumes, "resume record")} removed`
    + (out.skipped ? `; ${out.skipped} no longer matched` : "") + (out.refused.length ? `; ${out.refused.length} refused` : ""));
  return out;
}

// Keep this job (drawer): on, the preference check leaves it out and a bulk delete never takes
// it; its last "skipped" verdict is cleared so it shows on the board again. Off: the next
// batch's check decides again.
export function setKept(db: Db, jobId: string, keep: boolean): { kept: boolean } {
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) throw new DeleteRefused("job not found");
  if (keep) {
    db.prepare("INSERT INTO kept_jobs (job_id, kept_at) VALUES (?, ?) ON CONFLICT (job_id) DO NOTHING").run(jobId, new Date().toISOString());
    if (hasTable(db, "job_filter")) db.prepare("DELETE FROM job_filter WHERE job_id = ? AND ok = 0").run(jobId);
  } else {
    db.prepare("DELETE FROM kept_jobs WHERE job_id = ?").run(jobId);
  }
  const j = db.prepare("SELECT title, company FROM jobs WHERE id = ?").get(jobId) as { title: string; company: string };
  event(`${keep ? "job kept" : "keep removed"}: ${j.company} · ${j.title}`);
  return { kept: keep };
}

// --- Delete the jobs ticked on the board (Tailored, Skipped, Not tailored columns) ----------
export type BulkItem = { id: string; title: string; company: string; resumes: number; status: string | null; kept: boolean };

// What the confirm panel shows for the ticked jobs: resumes each one would lose, its tracking
// status, and whether it is kept.
export function bulkPreview(db: Db, ids: string[]): BulkItem[] {
  const get = db.prepare(`SELECT j.id, j.title, j.company, a.status,
      (SELECT count(*) FROM resume_records r WHERE r.jd_id = j.id AND r.decision != 'not_tailored') AS resumes,
      EXISTS (SELECT 1 FROM kept_jobs k WHERE k.job_id = j.id) AS kept
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE j.id = ?`);
  const out: BulkItem[] = [];
  for (const id of new Set(ids)) {
    const r = get.get(id) as { id: string; title: string; company: string; status: string | null; resumes: number; kept: number } | undefined;
    if (r) out.push({ id: r.id, title: r.title, company: r.company, status: r.status, resumes: r.resumes, kept: !!r.kept });
  }
  return out;
}

// Deletes the ticked jobs one by one through deleteJob. Jobs marked applied, interview or offer
// are deleted only when the user ticked "include" for them in the panel; otherwise left.
export async function bulkDelete(db: Db, ids: string[], opts: { include_applied: boolean }): Promise<{
  deleted: number; resumes: number; left_applied: number; refused: { title: string; company: string; message: string }[];
}> {
  const out = { deleted: 0, resumes: 0, left_applied: 0, refused: [] as { title: string; company: string; message: string }[] };
  for (const item of bulkPreview(db, ids)) {
    if (item.status && KEEP.has(item.status) && !opts.include_applied) { out.left_applied++; continue; }
    try {
      const r = await deleteJob(db, item.id, { reason: "deleted from the board" });
      out.deleted++;
      out.resumes += r.resumes;
    } catch (err) {
      out.refused.push({ title: item.title, company: item.company, message: err instanceof Error ? err.message : String(err) });
    }
  }
  event(`jobs deleted (board selection): ${out.deleted} of ${new Set(ids).size} ticked; ${plural(out.resumes, "resume record")} removed`
    + (out.left_applied ? `; ${out.left_applied} applied left` : "") + (out.refused.length ? `; ${out.refused.length} refused` : ""));
  return out;
}
