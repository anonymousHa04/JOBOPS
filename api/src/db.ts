import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode=WAL");
  }
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
  `);
  return db;
}
