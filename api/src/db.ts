import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode=WAL");
  }
  // The first resume_records table (no hashes) was never written to; replace it.
  const cols = db.prepare("SELECT name FROM pragma_table_info('resume_records')").all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === "content_hash")) db.exec("DROP TABLE resume_records");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      description TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_name TEXT,
      location TEXT,
      employment_type TEXT,
      seniority TEXT,
      required_skills TEXT NOT NULL,
      preferred_skills TEXT NOT NULL,
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_content_hash ON jobs (content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_url ON jobs (source_url);
    CREATE TABLE IF NOT EXISTS job_requirements (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      prompt_version TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, prompt_version)
    );
    CREATE TABLE IF NOT EXISTS resume_records (
      resume_id TEXT PRIMARY KEY,
      jd_id TEXT NOT NULL,
      path TEXT NOT NULL,
      source_resume_id TEXT,
      decision TEXT NOT NULL,
      band TEXT,
      score REAL,
      equivalence REAL,
      flags TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bank_hash TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judge_cache (
      key TEXT PRIMARY KEY,
      requirement TEXT NOT NULL,
      label TEXT NOT NULL,
      bullet_ids TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      bank_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      status TEXT NOT NULL CHECK (status IN ('interested', 'applied', 'interview', 'offer', 'rejected', 'withdrawn')),
      note TEXT,
      applied_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS application_tasks_job ON application_tasks (job_id);
    ${GAP_NOTES}
    CREATE TABLE IF NOT EXISTS ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Jobs the user deleted (UI): a fetch that finds the same link or the same content again
    -- does not add it back. Only what that check needs, plus a label for the user.
    CREATE TABLE IF NOT EXISTS deleted_jobs (
      source_url TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deleted_jobs_hash ON deleted_jobs (content_hash);
  `);
  // gap_notes first allowed only must, nice and keyword; responsibilities (theme) came later.
  // SQLite cannot change a CHECK, so an old table is rebuilt once with its rows kept.
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gap_notes'").get() as { sql: string } | undefined)?.sql ?? "";
  if (!sql.includes("'theme'")) {
    db.exec(`BEGIN;
      ALTER TABLE gap_notes RENAME TO gap_notes_old;
      ${GAP_NOTES}
      INSERT INTO gap_notes (job_id, requirement, kind, help, answer, outcome, updated_at)
        SELECT job_id, requirement, kind, help, answer, outcome, updated_at FROM gap_notes_old;
      DROP TABLE gap_notes_old;
      COMMIT;`);
  }
  return db;
}

const GAP_NOTES = `CREATE TABLE IF NOT EXISTS gap_notes (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      requirement TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('must', 'theme', 'nice', 'keyword')),
      help TEXT,
      answer TEXT CHECK (answer IN ('have', 'other_name', 'learnable', 'no')),
      outcome TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, requirement)
    );`;
