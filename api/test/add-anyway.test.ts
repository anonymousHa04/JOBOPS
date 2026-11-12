// "Add it anyway" for a job deleted earlier (.claude/specs/plan-add-anyway.md, T1-T7).
// Written from the spec only. The network is stubbed: the job board (Ashby API) and the queue
// server both go through globalThis.fetch. A temp profile dir; never the real profile/ or data/.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { addByLink, AddRefused } from "../src/ui/add-job.ts";
import { computeContentHash, createJobRepository } from "../src/jobs/repository.ts";
import { fetchJob } from "../src/jobs/from-url.ts";
import { setEventSink } from "../src/log.ts";

const QUEUE = "http://queue.test:8090";
process.env.JOBOPS_QUEUE_URL = QUEUE;

const SLUG = "acme";
const ID = "4c7378a7-6736-4038-b584-f2dc242d756c";
const LINK = `https://jobs.ashbyhq.com/${SLUG}/${ID}`;
const BOARD_JOB = {
  id: ID,
  title: "Software Development Engineer 3",
  location: "Bengaluru",
  descriptionPlain: "Build backend services in Go and TypeScript. Requirements: 5 years of experience with distributed systems.",
  publishedAt: "2026-11-01T00:00:00Z"
};
const DELETED_AT = "2026-11-05T10:00:00.000Z";

const PREFS = `compensation: { currency: INR, unit: year, min: 1, target: 2, keep_if_unlisted: true }
roles:
  - title: SDE 3
    aliases: [SDE III]
seniority:
  include: [senior]
  exclude: [intern]
location: { cities: [Bengaluru], remote: true, hybrid: true, onsite: true }
visa_sponsorship_needed: false
companies:
  include: []
  exclude: []
tailoring: { bullets_per_role: 4, bullets_total: 12, max_words: 25 }
skip_keywords: [sales, recruiter]
`;

const realFetch = globalThis.fetch;
let queueCalls: string[] = [];
let events: string[] = [];
let profileDir = "";

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), "jobops-add-anyway-"));
  process.env.JOBOPS_PROFILE_DIR = profileDir;
  writeFileSync(join(profileDir, "preferences.yaml"), PREFS);
  queueCalls = [];
  events = [];
  setEventSink({ info: (m) => events.push(m), warn: (m) => events.push(m) });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(QUEUE)) {
      queueCalls.push(`${init?.method ?? "GET"} ${url.slice(QUEUE.length)}`);
      if (url.endsWith("/add")) return json(200, { batch_id: 7, stage: "parse" });
      return json(200, {});
    }
    if (url === `https://api.ashbyhq.com/posting-api/job-board/${SLUG}`) return json(200, { jobs: [BOARD_JOB] });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setEventSink(null);
});

type DelRow = { source_url: string; content_hash: string; title: string; company: string; deleted_at: string; reason: string | null; keywords: string | null };

function seedDeleted(db: Db, row: Partial<DelRow> & { source_url: string; content_hash: string }): void {
  const r: DelRow = { title: BOARD_JOB.title, company: "Acme", deleted_at: DELETED_AT, reason: null, keywords: null, ...row };
  db.prepare(`INSERT INTO deleted_jobs (source_url, content_hash, title, company, deleted_at, reason, keywords)
    VALUES (@source_url, @content_hash, @title, @company, @deleted_at, @reason, @keywords)`).run(r);
}

const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const deletedUrls = (db: Db) => (db.prepare("SELECT source_url FROM deleted_jobs ORDER BY source_url").all() as { source_url: string }[]).map((r) => r.source_url);

// The posting exactly as addByLink will see it (same stubbed fetch), and its content hash.
async function posting() {
  const input = await fetchJob(LINK);
  return { input, hash: computeContentHash(input) };
}

async function refusal(p: Promise<unknown>): Promise<AddRefused & { code?: string; deleted_at?: string }> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof AddRefused, `expected AddRefused, got ${String(err)}`);
    return err as AddRefused & { code?: string; deleted_at?: string };
  }
  assert.fail("expected the add to be refused");
}

test("T1: a deleted link without undelete is refused (deleted_before + date); nothing added, row stays", async () => {
  const db = openDb(":memory:");
  const { hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash });

  const err = await refusal(addByLink(db, LINK));
  assert.equal(err.code, "deleted_before");
  assert.equal(err.deleted_at, DELETED_AT);
  assert.equal(count(db, "jobs"), 0, "no job added");
  assert.equal(count(db, "kept_jobs"), 0);
  assert.deepEqual(deletedUrls(db), [LINK], "the deleted_jobs row stays");
  assert.deepEqual(queueCalls, [], "nothing queued");

  // undelete: false is the same as leaving it out.
  const err2 = await refusal(addByLink(db, LINK, { undelete: false }));
  assert.equal(err2.code, "deleted_before");

  // Route: 400 { error: "deleted_before", message, deleted_at }.
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/ui/jobs/add", payload: { url: LINK } });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body) as { error: string; message: string; deleted_at: string };
  assert.equal(body.error, "deleted_before");
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
  assert.equal(body.deleted_at, DELETED_AT);
  assert.equal(count(db, "jobs"), 0);
  assert.deepEqual(deletedUrls(db), [LINK]);
  await app.close();
});

test("T2: with undelete the row is removed, the job is added (created), kept, queued, and the event is logged", async () => {
  const db = openDb(":memory:");
  const { hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash });

  const out = await addByLink(db, LINK, { undelete: true });
  assert.equal(out.created, true);
  assert.equal(out.title, BOARD_JOB.title);
  assert.equal(out.company, "Acme");
  assert.deepEqual(deletedUrls(db), [], "the deleted_jobs row is removed");
  assert.equal(count(db, "jobs"), 1);
  const kept = db.prepare("SELECT job_id FROM kept_jobs").all() as { job_id: string }[];
  assert.deepEqual(kept.map((k) => k.job_id), [out.job_id], "the job is kept");
  assert.equal(out.batch_id, 7);
  assert.equal(out.stage, "parse");
  assert.ok(queueCalls.includes("POST /add"), "parse and score queued as today");

  const line = events.find((e) => e.startsWith("job added anyway (deleted "));
  assert.ok(line, `event line written; got: ${JSON.stringify(events)}`);
  assert.ok(line.includes("2026-11-05"), `the line names the deleted date: ${line}`);
  assert.ok(line.endsWith(`: Acme · ${BOARD_JOB.title}`), `the line ends with company · title: ${line}`);
});

test("T2 (route): undelete: true through POST /ui/jobs/add adds the job", async () => {
  const db = openDb(":memory:");
  const { hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash });
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/ui/jobs/add", payload: { url: LINK, undelete: true } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { created: boolean; job_id: string };
  assert.equal(body.created, true);
  assert.deepEqual(deletedUrls(db), []);
  assert.equal(count(db, "jobs"), 1);
  await app.close();
});

test("T3: a match by content hash only (new link, same text) is refused, and undelete removes that row", async () => {
  const db = openDb(":memory:");
  const { input, hash } = await posting();
  const OLD = "https://jobs.example.com/acme/old-posting-123";
  seedDeleted(db, { source_url: OLD, content_hash: hash });
  // An unrelated deleted job must stay.
  seedDeleted(db, { source_url: "https://jobs.example.com/other/9", content_hash: "f".repeat(64), title: "Other", company: "Other" });

  const repo = createJobRepository(db);
  assert.equal(repo.isDeleted(input), true, "same text counts as deleted");

  const err = await refusal(addByLink(db, LINK));
  assert.equal(err.code, "deleted_before");
  assert.equal(err.deleted_at, DELETED_AT);
  assert.equal(count(db, "jobs"), 0);

  const out = await addByLink(db, LINK, { undelete: true });
  assert.equal(out.created, true);
  assert.deepEqual(deletedUrls(db), ["https://jobs.example.com/other/9"], "only the matching row is removed");
  assert.equal(repo.isDeleted(input), false);
});

test("T3 (repository): removeDeleted matches source_url OR content_hash and returns rows removed", async () => {
  const db = openDb(":memory:");
  const { input, hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: "0".repeat(64) });          // same link, other text
  seedDeleted(db, { source_url: "https://jobs.example.com/acme/old", content_hash: hash }); // other link, same text
  seedDeleted(db, { source_url: "https://jobs.example.com/other/9", content_hash: "f".repeat(64) });
  const repo = createJobRepository(db);
  assert.equal(repo.removeDeleted(input), 2);
  assert.deepEqual(deletedUrls(db), ["https://jobs.example.com/other/9"]);
  assert.equal(repo.removeDeleted(input), 0, "nothing left to remove");
});

test("T4: after undelete, a later job search import (POST /jobs) no longer skips it", async () => {
  const db = openDb(":memory:");
  const { input, hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash });
  const app = buildApp({ db });

  const before = await app.inject({ method: "POST", url: "/jobs", payload: input });
  assert.equal(before.statusCode, 200);
  assert.equal((JSON.parse(before.body) as { deleted?: boolean }).deleted, true, "skipped while deleted");
  assert.equal(count(db, "jobs"), 0);

  const out = await addByLink(db, LINK, { undelete: true });
  const after = await app.inject({ method: "POST", url: "/jobs", payload: input });
  assert.ok(after.statusCode === 200 || after.statusCode === 201, `status ${after.statusCode}`);
  const body = JSON.parse(after.body) as { deleted?: boolean; id?: string };
  assert.notEqual(body.deleted, true, "the import is no longer skipped");
  assert.equal(body.id, out.job_id, "the import finds the job that was added anyway");
  await app.close();
});

test("T5: skip words saved by that delete stay in preferences and are listed in skip_words_kept", async () => {
  const db = openDb(":memory:");
  const { hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash, reason: "skip words", keywords: JSON.stringify(["sales"]) });
  const prefsBefore = readFileSync(join(profileDir, "preferences.yaml"), "utf8");

  const out = await addByLink(db, LINK, { undelete: true });
  assert.equal(out.created, true);
  assert.deepEqual(out.skip_words_kept, ["sales"]);
  const prefsAfter = readFileSync(join(profileDir, "preferences.yaml"), "utf8");
  assert.equal(prefsAfter, prefsBefore, "preferences.yaml is not changed");
  assert.match(prefsAfter, /skip_keywords: \[sales, recruiter\]/);
});

test("T5: a deleted row without keywords gives no skip_words_kept (or an empty list)", async () => {
  const db = openDb(":memory:");
  const { hash } = await posting();
  seedDeleted(db, { source_url: LINK, content_hash: hash, keywords: null });
  const out = await addByLink(db, LINK, { undelete: true });
  assert.ok(out.skip_words_kept === undefined || out.skip_words_kept.length === 0, `got ${JSON.stringify(out.skip_words_kept)}`);
});

test("T6: undelete on a link that was never deleted adds it normally (no error, 0 rows removed)", async () => {
  const db = openDb(":memory:");
  const { input } = await posting();
  seedDeleted(db, { source_url: "https://jobs.example.com/other/9", content_hash: "f".repeat(64), title: "Other", company: "Other" });
  assert.equal(createJobRepository(db).removeDeleted(input), 0);

  const out = await addByLink(db, LINK, { undelete: true });
  assert.equal(out.created, true);
  assert.equal(count(db, "jobs"), 1);
  assert.deepEqual(deletedUrls(db), ["https://jobs.example.com/other/9"], "other deleted rows are untouched");
  assert.ok(out.skip_words_kept === undefined || out.skip_words_kept.length === 0);
  assert.ok(!events.some((e) => e.startsWith("job added anyway")), "not logged as added anyway: nothing was deleted");
});

test("T7: route: undelete that is not a boolean -> 400 invalid body", async () => {
  const db = openDb(":memory:");
  const app = buildApp({ db });
  for (const undelete of ["yes", "true", 1, null, {}]) {
    const res = await app.inject({ method: "POST", url: "/ui/jobs/add", payload: { url: LINK, undelete } });
    assert.equal(res.statusCode, 400, `undelete=${JSON.stringify(undelete)}`);
    assert.equal((JSON.parse(res.body) as { error: string }).error, "invalid body");
  }
  // strict: an unknown key is still refused.
  const res = await app.inject({ method: "POST", url: "/ui/jobs/add", payload: { url: LINK, undeleted: true } });
  assert.equal(res.statusCode, 400);
  assert.equal((JSON.parse(res.body) as { error: string }).error, "invalid body");
  assert.equal(count(db, "jobs"), 0);
  assert.deepEqual(queueCalls, []);
  await app.close();
});
