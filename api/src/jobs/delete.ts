// Delete a job the user does not want (UI: Delete this job). Its rows go from every table, its
// tailored resumes (record YAML and PDF in profile/) are removed, and its link and content hash
// go on deleted_jobs so a later fetch does not add it again. The queue's tables are the Go
// queue server's: it drops the job's tasks (forgetJob).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { forgetJob } from "../queue/client.ts";
import { pdfDir } from "../render/render.ts";
import { recordsDir } from "../tailor/records.ts";

export class DeleteRefused extends Error {}

const hasTable = (db: Db, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export async function deleteJob(db: Db, jobId: string): Promise<{ resumes: number; files: number; tasks: number }> {
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
    db.prepare(`INSERT INTO deleted_jobs (source_url, content_hash, title, company, deleted_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_url) DO UPDATE SET content_hash = excluded.content_hash, deleted_at = excluded.deleted_at`)
      .run(job.source_url, job.content_hash, job.title, job.company, new Date().toISOString());
    for (const t of ["gap_notes", "application_tasks", "applications", "job_requirements"]) {
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
  return { resumes: resumes.length, files, tasks };
}
