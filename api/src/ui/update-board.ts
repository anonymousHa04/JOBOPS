// Update board (top bar): tailored jobs whose current board score is below the tailoring bands
// (75, "moderate") move to Not tailored and lose their tailored resumes. The job, its score,
// gap notes, keep mark and application status stay. Every record row and its files are backed
// up first to data/backups/update-board-<time>/. A ui_state marker board_cleared:<job_id> keeps
// the card in Not tailored until a later tailor run (see pipelineOf in data.ts).
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../db.ts";
import { setMarker } from "../db.ts";
import { board, CLEARED_PREFIX } from "./data.ts";
import { TAILORED_BANDS } from "../scoring/config.ts";
import { recordsDir } from "../tailor/records.ts";
import { pdfDir } from "../render/render.ts";
import { publish } from "../events/bus.ts";
import { event, plural } from "../log.ts";

export type UpdateCandidate = {
  id: string; company: string; title: string; score: number | null; band: string | null;
  application: string | null; resumes: string[];
};

export type UpdateResult = {
  jobs: number; records: number; files: number; backup_dir: string | null;
  refused: { id: string; company: string; title: string; message: string }[];
};

const hasTable = (db: Db, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const SAFE_ID = /^[\w-]+$/;

// The data folder is the database's folder (DB_PATH, default data/jobops.db).
export const backupsDir = () => join(dirname(process.env.DB_PATH ?? "data/jobops.db"), "backups");

// Only <resume_id>.yaml/.pdf/.checks.json built from a safe id, never a path from the database.
function recordFiles(resumeId: string): string[] {
  if (!SAFE_ID.test(resumeId)) return [];
  return [join(recordsDir(), `${resumeId}.yaml`), join(pdfDir(), `${resumeId}.pdf`), join(pdfDir(), `${resumeId}.checks.json`)];
}

// Tailored cards whose band is not a tailoring band. A card without a score is left alone
// (unknown is not below 75: a job tailored outside the queue may have no score task).
export function updateBoardCandidates(db: Db): UpdateCandidate[] {
  const ids = db.prepare("SELECT resume_id FROM resume_records WHERE jd_id = ? AND decision NOT IN ('not_tailored') ORDER BY created_at");
  return board(db)
    .filter((c) => c.state === "tailored" && c.band !== null && !(TAILORED_BANDS as readonly string[]).includes(c.band))
    .map((c) => ({
      id: c.id, company: c.company, title: c.title, score: c.score, band: c.band, application: c.application,
      resumes: (ids.all(c.id) as { resume_id: string }[]).map((r) => r.resume_id)
    }));
}

export function updateBoard(db: Db): UpdateResult {
  const out: UpdateResult = { jobs: 0, records: 0, files: 0, backup_dir: null, refused: [] };
  const candidates = updateBoardCandidates(db);
  const queue = hasTable(db, "queue_tasks");
  let backup: string | null = null;
  for (const [i, c] of candidates.entries()) {
    // A worker writing this job's score or resume right now would undo the cleanup.
    if (queue) {
      const leased = db.prepare("SELECT count(*) AS n FROM queue_tasks WHERE job_id = ? AND state = 'leased'").get(c.id) as { n: number };
      if (leased.n > 0) {
        out.refused.push({ id: c.id, company: c.company, title: c.title, message: "A worker is on this job right now: run Update board again when it finishes." });
        continue;
      }
    }
    // Only this job's own records: a record of another job it reused is never touched.
    const rows = db.prepare("SELECT * FROM resume_records WHERE jd_id = ? AND decision NOT IN ('not_tailored')").all(c.id) as
      ({ resume_id: string } & Record<string, unknown>)[];

    // 1. Back up the rows and their files.
    if (rows.length) {
      if (!backup) {
        backup = join(backupsDir(), `update-board-${new Date().toISOString().replace(/:/g, "-")}`);
        mkdirSync(backup, { recursive: true });
      }
      const dir = join(backup, SAFE_ID.test(c.id) ? c.id : `job-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "records.json"), JSON.stringify(rows, null, 2) + "\n");
      for (const r of rows) {
        for (const f of recordFiles(r.resume_id)) {
          if (existsSync(f)) copyFileSync(f, join(dir, f.slice(dirname(f).length + 1)));
        }
      }
    }

    // 2-4. Rows and the marker together, then the files (a missing file is fine).
    const lastTailor = queue
      ? (db.prepare("SELECT MAX(batch_id) AS b FROM queue_tasks WHERE job_id = ? AND stage = 'tailor'").get(c.id) as { b: number | null }).b
      : null;
    db.transaction(() => {
      const del = db.prepare("DELETE FROM resume_records WHERE resume_id = ? AND jd_id = ?");
      for (const r of rows) del.run(r.resume_id, c.id);
      setMarker(db, CLEARED_PREFIX + c.id, String(lastTailor ?? 0));
    })();
    for (const r of rows) {
      for (const f of recordFiles(r.resume_id)) {
        if (existsSync(f)) { rmSync(f); out.files++; }
      }
    }
    out.jobs++;
    out.records += rows.length;
    publish({ kind: "job", job_id: c.id, state: "changed" });
  }
  out.backup_dir = backup;
  if (candidates.length) {
    event(`board updated: ${plural(out.jobs, "job")} moved to Not tailored; ${plural(out.records, "resume record")} and ${plural(out.files, "file")} removed`
      + (backup ? `; backup ${backup}` : "") + (out.refused.length ? `; ${out.refused.length} refused (worker on it)` : ""));
  }
  return out;
}
