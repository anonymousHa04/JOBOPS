import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { boardCard } from "../src/ui/data.ts";
import { updateBoard, updateBoardCandidates } from "../src/ui/update-board.ts";
import { subscribe } from "../src/events/bus.ts";

// Update board: tailored jobs now below 75 move to Not tailored; their own records and files
// are backed up, then deleted. Temp profile and data folders only; fake queue_tasks rows.

function env() {
  const dir = mkdtempSync(join(tmpdir(), "jobops-ub-"));
  process.env.JOBOPS_PROFILE_DIR = join(dir, "profile");
  process.env.DB_PATH = join(dir, "data", "jobops.db");
  mkdirSync(join(dir, "profile", "records"), { recursive: true });
  mkdirSync(join(dir, "profile", "pdf"), { recursive: true });
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS queue_tasks (id INTEGER PRIMARY KEY, batch_id INTEGER, job_id TEXT, stage TEXT,
    prompt_version TEXT, state TEXT, attempts INTEGER DEFAULT 0, worker TEXT, error_code TEXT, error_detail TEXT,
    result TEXT, final INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT, lease_until TEXT, retry_at TEXT)`);
  return { db, dir, records: join(dir, "profile", "records"), pdf: join(dir, "profile", "pdf"), backups: join(dir, "data", "backups") };
}

const at = (batch: number) => `2026-11-0${Math.min(batch, 9)}T00:00:00.000Z`;

function job(db: Db, id: string) {
  db.prepare(`INSERT INTO jobs (id, title, company, description, source_url, required_skills, preferred_skills, first_seen_at, last_seen_at, content_hash)
    VALUES (?, ?, ?, 'desc', ?, '[]', '[]', ?, ?, ?)`).run(id, `Title ${id}`, `Co ${id}`, `https://example.com/${id}`, at(1), at(1), `h-${id}`);
}

function task(db: Db, id: string, batch: number, stage: string, state: string, result: Record<string, unknown> | null) {
  db.prepare("INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, result, final, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
    .run(batch, id, stage, `v-${stage}-${batch}`, state, result ? JSON.stringify(result) : null, at(batch), at(batch));
}

function scored(db: Db, id: string, batch: number, score: number, band: string, decision: string) {
  task(db, id, batch, "score", "done", { score, band, decision });
}

function record(db: Db, s: ReturnType<typeof env>, resumeId: string, jdId: string, decision = "adapt") {
  db.prepare(`INSERT INTO resume_records (resume_id, jd_id, path, source_resume_id, decision, band, score, equivalence, flags, content_hash, bank_hash, engine_version, created_at)
    VALUES (?, ?, ?, NULL, ?, 'good', 70, NULL, '{}', 'c', 'b', 'e', ?)`).run(resumeId, jdId, join(s.records, `${resumeId}.yaml`), decision, at(2));
  writeFileSync(join(s.records, `${resumeId}.yaml`), `resume_id: ${resumeId}\n`);
  writeFileSync(join(s.pdf, `${resumeId}.pdf`), "%PDF fake");
  writeFileSync(join(s.pdf, `${resumeId}.checks.json`), "{}");
}

// A tailored job: score task (batch 1), tailor task done (batch 2), and its own record.
function tailoredJob(db: Db, s: ReturnType<typeof env>, id: string, score: number, band: string, withRecord = true) {
  job(db, id);
  scored(db, id, 1, score, band, "adapt");
  task(db, id, 2, "tailor", "done", { decision: "adapt", resume_id: `${id}-r1` });
  if (withRecord) record(db, s, `${id}-r1`, id);
}

const ids = (db: Db) => updateBoardCandidates(db).map((c) => c.id);
const rows = (db: Db, jd: string) => (db.prepare("SELECT resume_id FROM resume_records WHERE jd_id = ?").all(jd) as { resume_id: string }[]).map((r) => r.resume_id);

test("T1: a tailored job at 64.8 (poor) is a candidate; one at 80.3 is not", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor");
  tailoredJob(s.db, s, "high", 80.3, "strong");
  assert.equal(boardCard(s.db, "low")?.state, "tailored");
  assert.equal(boardCard(s.db, "high")?.state, "tailored");
  const c = updateBoardCandidates(s.db);
  assert.deepEqual(c.map((x) => x.id), ["low"]);
  assert.equal(c[0].score, 64.8);
  assert.equal(c[0].band, "poor");
  assert.deepEqual(c[0].resumes, ["low-r1"]);
});

test("T2: a not-tailored job below 75 is not a candidate", () => {
  const s = env();
  job(s.db, "nt");
  scored(s.db, "nt", 1, 60, "poor", "not_tailored");
  assert.equal(boardCard(s.db, "nt")?.state, "not_tailored");
  assert.deepEqual(ids(s.db), []);
});

test("T3: an applied job below 75 is a candidate", () => {
  const s = env();
  tailoredJob(s.db, s, "app", 64.8, "poor");
  s.db.prepare("INSERT INTO applications (job_id, status, updated_at) VALUES ('app', 'applied', ?)").run(at(3));
  const c = updateBoardCandidates(s.db);
  assert.deepEqual(c.map((x) => x.id), ["app"]);
  assert.equal(c[0].application, "applied");
});

test("T4: updateBoard deletes the rows, YAML, PDF and checks.json, after backing them up", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor");
  const r = updateBoard(s.db);
  assert.equal(r.jobs, 1);
  assert.equal(r.records, 1);
  assert.equal(r.files, 3);
  assert.deepEqual(rows(s.db, "low"), []);
  for (const f of [join(s.records, "low-r1.yaml"), join(s.pdf, "low-r1.pdf"), join(s.pdf, "low-r1.checks.json")]) assert.equal(existsSync(f), false, f);
  assert.ok(r.backup_dir && r.backup_dir.startsWith(join(s.backups, "update-board-")));
  assert.ok(!r.backup_dir.includes(":"));
  const jobDir = join(r.backup_dir, "low");
  assert.deepEqual(readdirSync(jobDir).sort(), ["low-r1.checks.json", "low-r1.pdf", "low-r1.yaml", "records.json"]);
  const saved = JSON.parse(readFileSync(join(jobDir, "records.json"), "utf8")) as { resume_id: string; jd_id: string }[];
  assert.deepEqual(saved.map((x) => [x.resume_id, x.jd_id]), [["low-r1", "low"]]);
  assert.equal(readFileSync(join(jobDir, "low-r1.yaml"), "utf8"), "resume_id: low-r1\n");
});

test("T5: after updateBoard the card is not_tailored; job, score, gaps, keep and status stay", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor");
  s.db.prepare("INSERT INTO gap_notes (job_id, requirement, kind, answer, updated_at) VALUES ('low', 'Go', 'must', 'have', ?)").run(at(3));
  s.db.prepare("INSERT INTO kept_jobs (job_id, kept_at) VALUES ('low', ?)").run(at(3));
  s.db.prepare("INSERT INTO applications (job_id, status, updated_at) VALUES ('low', 'interview', ?)").run(at(3));
  const seen: string[] = [];
  const off = subscribe((c) => { if (c.kind === "job" && c.job_id) seen.push(c.job_id); });
  try {
    updateBoard(s.db);
  } finally {
    off();
  }
  assert.deepEqual(seen, ["low"]);
  const card = boardCard(s.db, "low")!;
  assert.equal(card.state, "not_tailored");
  assert.equal(card.decision, "not_tailored");
  assert.equal(card.reason, "score below 75; tailored resume removed by Update board");
  assert.equal(card.score, 64.8);
  assert.equal(card.band, "poor");
  assert.equal(card.application, "interview");
  assert.equal(card.title, "Title low");
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM gap_notes WHERE job_id = 'low'").get() as { n: number }).n, 1);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM kept_jobs WHERE job_id = 'low'").get() as { n: number }).n, 1);
  assert.equal((s.db.prepare("SELECT value FROM ui_state WHERE key = 'board_cleared:low'").get() as { value: string }).value, "2");
});

test("T6: a tailor run after the cleanup (higher batch_id) makes the job tailored again", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor");
  updateBoard(s.db);
  assert.equal(boardCard(s.db, "low")?.state, "not_tailored");
  task(s.db, "low", 5, "tailor", "done", { decision: "adapt", resume_id: "low-r2" });
  const card = boardCard(s.db, "low")!;
  assert.equal(card.state, "tailored");
  assert.equal(card.reason, null);
});

test("T7: another job's record reused by the candidate is not deleted", () => {
  const s = env();
  tailoredJob(s.db, s, "other", 82, "strong");
  job(s.db, "low");
  scored(s.db, "low", 1, 64.8, "poor", "reuse");
  // The candidate's tailor run reused the other job's resume; it also has a record of its own.
  task(s.db, "low", 2, "tailor", "done", { decision: "reuse", resume_id: "other-r1" });
  record(s.db, s, "low-own", "low");
  assert.deepEqual(updateBoardCandidates(s.db).map((c) => [c.id, c.resumes]), [["low", ["low-own"]]]);
  const r = updateBoard(s.db);
  assert.equal(r.records, 1);
  assert.deepEqual(rows(s.db, "other"), ["other-r1"]);
  for (const f of [join(s.records, "other-r1.yaml"), join(s.pdf, "other-r1.pdf"), join(s.pdf, "other-r1.checks.json")]) assert.equal(existsSync(f), true, f);
  assert.equal(boardCard(s.db, "other")?.state, "tailored");
  assert.equal(boardCard(s.db, "low")?.state, "not_tailored");
});

test("T8: a job with a leased queue task is refused and nothing of it is touched", () => {
  const s = env();
  tailoredJob(s.db, s, "busy", 64.8, "poor");
  task(s.db, "busy", 3, "gap_help", "leased", null);
  assert.deepEqual(ids(s.db), ["busy"]);
  const r = updateBoard(s.db);
  assert.equal(r.jobs, 0);
  assert.equal(r.records, 0);
  assert.equal(r.files, 0);
  assert.deepEqual(r.refused.map((x) => x.id), ["busy"]);
  assert.equal(r.backup_dir, null);
  assert.equal(existsSync(s.backups), false);
  assert.deepEqual(rows(s.db, "busy"), ["busy-r1"]);
  for (const f of [join(s.records, "busy-r1.yaml"), join(s.pdf, "busy-r1.pdf"), join(s.pdf, "busy-r1.checks.json")]) assert.equal(existsSync(f), true, f);
  assert.equal(s.db.prepare("SELECT 1 FROM ui_state WHERE key = 'board_cleared:busy'").get(), undefined);
  assert.equal(boardCard(s.db, "busy")?.state, "tailored");
});

test("T9: running updateBoard twice: the second run finds no candidates and deletes nothing", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor");
  tailoredJob(s.db, s, "high", 80.3, "strong");
  const first = updateBoard(s.db);
  assert.equal(first.jobs, 1);
  assert.deepEqual(ids(s.db), []);
  const second = updateBoard(s.db);
  assert.deepEqual(second, { jobs: 0, records: 0, files: 0, backup_dir: null, refused: [] });
  assert.deepEqual(rows(s.db, "high"), ["high-r1"]);
});

test("T10: a resume id that does not match /^[\\w-]+$/ deletes no file", () => {
  const s = env();
  tailoredJob(s.db, s, "low", 64.8, "poor", false);
  record(s.db, s, "bad.id", "low");
  const r = updateBoard(s.db);
  assert.equal(r.files, 0);
  for (const f of [join(s.records, "bad.id.yaml"), join(s.pdf, "bad.id.pdf"), join(s.pdf, "bad.id.checks.json")]) assert.equal(existsSync(f), true, f);
  assert.equal(boardCard(s.db, "low")?.state, "not_tailored");
});
