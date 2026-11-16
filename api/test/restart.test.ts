import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { addRecord, bank, ext, postReport, reportAnswer, setup } from "./fixtures.ts";
import { markerValue, openDb, setMarker } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { loadPreferences, loadSkillsExtra } from "../src/profile/bank.ts";
import { loadRequirements } from "../src/requirements/parse.ts";
import { loadRecords } from "../src/tailor/records.ts";
import { planJob, tailorJob } from "../src/tailor/tailor.ts";
import { runStage } from "../src/queue/worker.ts";
import { hasFreshChat, loadLoop, loopPath, restartLoop, takeFreshChat } from "../src/extension/rounds.ts";
import { fixStep } from "../src/extension/step.ts";
import { latestRecord, reportsDir, saveReport } from "../src/extension/reports.ts";
import type { Report } from "../src/extension/reports.ts";
import type { tailor } from "../src/tools.ts";

// T7 restart options (plan-atlassian-fix.md): Re-tailor from scratch (fresh), Restart the chat
// check (loop file kept under a timestamp, fresh_chat once). Fake bank and jobs only, temp profile
// directory, fake queue server; no model (the fixture job needs no rewording).

const PREFS = `compensation: { currency: INR, unit: year, min: 1, target: 2, keep_if_unlisted: true }
roles:
  - title: Backend Engineer
    aliases: []
seniority: { include: [senior], exclude: [] }
location: { cities: [Bangalore], remote: true, hybrid: true, onsite: true }
visa_sponsorship_needed: false
companies: { include: [], exclude: [] }
tailoring: { bullets_per_role: 4, bullets_total: 12, max_words: 25 }
`;

// The fixture job with its own tailored record and preferences (so it can be tailored).
async function ready() {
  const s = await setup({ withRecord: true });
  writeFileSync(join(s.dir, "preferences.yaml"), PREFS);
  process.env.JOBOPS_MODEL_LOG = join(s.dir, "model-calls.jsonl");
  return s;
}

async function withQueueUrl(url: string, fn: () => Promise<void>) {
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = url;
  try {
    await fn();
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
}
const DOWN = "http://" + "127.0.0.1:1"; // nothing listens on port 1

// A fake queue: /tailor answers { batch_id } with the current value of `batch`.
async function fakeQueue() {
  const q = { batch: 7, calls: [] as string[], url: "", close: () => {} };
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      q.calls.push(`${rq.url} ${raw}`);
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ batch_id: q.batch }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  q.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  q.close = () => server.close();
  return q;
}

const marker = (db: Db, id: string) => markerValue(db, `fresh_tailor:${id}`);
const report = { fit_score: 70, missed_gaps: [{ requirement: "Go", why: "asked" }], already_covered: [], bullet_notes: [] } as unknown as Report;
const writes = (db: Db, id: string, ids: string[]) => (async () => { addRecord(db, id, ids); }) as unknown as typeof tailor;
const noRender = { render: async () => undefined };
const restart = (app: Awaited<ReturnType<typeof setup>>["app"], id: string, source: string) =>
  app.inject({ method: "POST", url: `/ui/jobs/${id}/check/restart`, payload: { source } });
const prompt = (app: Awaited<ReturnType<typeof setup>>["app"], id: string, source: string) =>
  app.inject({ method: "GET", url: `/x/prompt/${id}?source=${source}&followup=1`, headers: ext });

// 1
test("plan: fresh starts from no record; without it an earlier record starts the plan", async () => {
  const { app, db, id } = await ready();
  const req = loadRequirements(db, id)!;
  const { records } = loadRecords(db, bank);
  assert.ok(records.some((r) => r.jd_id === id), "the job's own record is given");
  const budget = loadPreferences().tailoring;
  const plain = planJob(req, id, records, bank, loadSkillsExtra(), budget, new Map());
  assert.notEqual(plain.start, null);
  const fresh = planJob(req, id, records, bank, loadSkillsExtra(), budget, new Map(), false, undefined, true);
  assert.equal(fresh.start, null);
  await app.close();
});

// 2
test("tailorJob fresh: the new record has no source resume; earlier records stay", async () => {
  const { app, db, id } = await ready();
  const before = loadRecords(db, bank).records.map((r) => r.resume_id);
  const r = await tailorJob(db, loadRequirements(db, id)!, id, loadRecords(db, bank).records, bank, loadSkillsExtra(),
    loadPreferences().tailoring, new Map(), { fresh: true, baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(r.start, null);
  assert.ok(r.created && r.resume_id);
  const row = db.prepare("SELECT source_resume_id FROM resume_records WHERE resume_id = ?").get(r.resume_id) as { source_resume_id: string | null };
  assert.equal(row.source_resume_id, null);
  const after = loadRecords(db, bank).records.map((x) => x.resume_id);
  for (const b of before) assert.ok(after.includes(b), `${b} is kept`);
  assert.ok(after.includes(r.resume_id!), "the new record is stored beside them");
  await app.close();
});

// 3
test("tailor route: a non-boolean fresh is 400; fresh with the queue down is 503 and leaves no marker", async () => {
  const { app, db, id } = await ready();
  const bad = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: { fresh: "yes" } });
  assert.equal(bad.statusCode, 400);
  await withQueueUrl(DOWN, async () => {
    const down = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: { fresh: true } });
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().error, "queue_down");
  });
  assert.equal(marker(db, id), null);
  await app.close();
});

// 4
test("worker tailor: its own marker makes the run fresh and is used up; a failed run puts it back", async () => {
  const { app, db, id } = await ready();
  const plain = await runStage("tailor", id, "retailor-4", db);
  assert.notEqual(plain.reason, "no starting record", "no marker: an earlier record starts it");
  setMarker(db, `fresh_tailor:${id}`, "5");
  const fresh = await runStage("tailor", id, "retailor-5", db);
  assert.equal(fresh.reason, "no starting record", "the tailor ran with fresh: true");
  assert.equal(marker(db, id), null, "the marker is gone");
  setMarker(db, `fresh_tailor:${id}`, "6");
  db.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(id); // the tailor now throws
  await assert.rejects(runStage("tailor", id, "retailor-6", db), /parse the JD first/);
  assert.equal(marker(db, id), "6", "put back for the retry");
  await app.close();
});

// 5
test("restart route: the loop file gets a timestamped name; none is archived null; bad source 400, unknown job 404", async () => {
  const { app, id } = await ready();
  mkdirSync(reportsDir(), { recursive: true });
  writeFileSync(loopPath(id, "claude"), "{}");
  const res = await restart(app, id, "claude");
  assert.equal(res.statusCode, 200);
  const archived = res.json().archived as string;
  assert.match(archived, new RegExp(`^${id}\\.claude\\.loop\\..+\\.json$`));
  assert.ok(existsSync(join(reportsDir(), archived)), "the old loop is kept");
  assert.equal(existsSync(loopPath(id, "claude")), false);
  const none = await restart(app, id, "claude");
  assert.equal(none.statusCode, 200);
  assert.equal(none.json().archived, null);
  assert.equal((await restart(app, id, "gemini")).statusCode, 400);
  assert.equal((await restart(app, "no-such-job", "claude")).statusCode, 404);
  await app.close();
});

// 6
test("after a restart the next prompt says fresh_chat once, for that site only", async () => {
  const { app, id } = await ready();
  assert.equal((await restart(app, id, "claude")).statusCode, 200);
  const other = await prompt(app, id, "chatgpt");
  assert.equal(other.statusCode, 200);
  assert.equal(other.json().fresh_chat, undefined, "chatgpt is not affected");
  const first = await prompt(app, id, "claude");
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().fresh_chat, true);
  assert.ok(first.json().prompt);
  const next = await prompt(app, id, "claude");
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().fresh_chat, undefined, "only once");
  await app.close();
});

// 7
test("after a restart the saved report is still listed, and round 1 starts a new loop", async () => {
  const { app, db, id } = await ready();
  assert.equal((await postReport(app, id)).statusCode, 201);
  await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1", "old-1"]), ...noRender });
  assert.ok(loadLoop(id, "claude"));
  const archived = (await restart(app, id, "claude")).json().archived as string;
  assert.ok(archived);
  assert.equal(loadLoop(id, "claude"), null);
  const listed = (await app.inject({ method: "GET", url: `/x/reports/${id}`, headers: ext })).json().reports as { file: string }[];
  assert.ok(listed.some((r) => r.file.endsWith(`${id}.claude.yaml`)), "the latest report stays");
  const old = JSON.parse(readFileSync(join(reportsDir(), archived), "utf8")) as { versions: { resume_id: string }[] };
  const current = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1"]), ...noRender });
  const loop = loadLoop(id, "claude");
  assert.ok(loop, "a new loop file");
  assert.equal(loop.versions[0].resume_id, current, "it starts from the current resume");
  assert.ok(!loop.versions.some((v) => v.resume_id === old.versions[0].resume_id), "the old loop's start is not in it");
  assert.ok(existsSync(join(reportsDir(), archived)), "the archived loop is untouched");
  await app.close();
});

// 8
test("the fresh_chat marker survives reopening the database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobops-db-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  const path = join(dir, "test.db");
  const db = openDb(path);
  restartLoop(db, "job-1", "claude");
  db.close();
  const again = openDb(path);
  assert.equal(hasFreshChat(again, "job-1", "claude"), true);
  assert.equal(takeFreshChat(again, "job-1", "claude"), true);
  assert.equal(takeFreshChat(again, "job-1", "claude"), false);
  again.close();
});

// 9
test("extension: the prompt URL carries the source, and fresh_chat forgets the saved chat", () => {
  const js = readFileSync(join(import.meta.dirname, "..", "..", "extension", "background.js"), "utf8");
  assert.match(js, /\/x\/prompt\/\$\{encodeURIComponent\(jobId\)\}\?source=\$\{target\}/);
  assert.match(js, /\{[^}]*\bfresh_chat\b[^}]*\}\s*=\s*await response\.json\(\)/);
  assert.match(js, /if \(fresh_chat\) await forgetChat\(jobId, target\)/);
});

// 10
test("a prompt that fails (job not parsed) does not use up fresh_chat", async () => {
  const { app, db, id } = await ready();
  assert.equal((await restart(app, id, "claude")).statusCode, 200);
  const rows = db.prepare("SELECT job_id, prompt_version, data, created_at FROM job_requirements WHERE job_id = ?").all(id) as Record<string, string>[];
  db.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(id);
  const failed = await prompt(app, id, "claude");
  assert.ok(failed.statusCode >= 400, `status ${failed.statusCode}`);
  assert.equal(hasFreshChat(db, id, "claude"), true, "still waiting");
  for (const r of rows) db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, ?, ?, ?)").run(r.job_id, r.prompt_version, r.data, r.created_at);
  assert.equal((await prompt(app, id, "claude")).json().fresh_chat, true);
  await app.close();
});

// 11
test("restart is refused while a fix step of that job and site runs", async () => {
  const { app, db, id } = await ready();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const held = (async () => { entered = true; await gate; addRecord(db, id, ["cur-1", "old-1"]); }) as unknown as typeof tailor;
  const step = fixStep(db, id, 1, "claude", report, { retailor: held, ...noRender });
  try {
    await new Promise((r) => setImmediate(r));
    assert.ok(entered, "the step is waiting on the stub");
    const busy = await restart(app, id, "claude");
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().error, "check_running");
    assert.equal((await restart(app, id, "chatgpt")).statusCode, 200, "the other site is free");
  } finally {
    release();
    await step;
  }
  assert.equal((await restart(app, id, "claude")).statusCode, 200, "free once the step ends");
  await app.close();
});

// 12
test("restart renames the round reports with the loop's timestamp and keeps the latest report", async () => {
  const { app, id } = await ready();
  const dir = reportsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(loopPath(id, "claude"), "{}");
  for (const f of [`${id}.claude.r1.yaml`, `${id}.claude.r2.yaml`, `${id}.claude.yaml`, `${id}.chatgpt.r1.yaml`]) writeFileSync(join(dir, f), "meta: {}\n");
  const archived = (await restart(app, id, "claude")).json().archived as string;
  const stamp = archived.slice(`${id}.claude.loop.`.length, -".json".length);
  const files = readdirSync(dir);
  for (const n of [1, 2]) {
    assert.ok(files.includes(`${id}.claude.r${n}.${stamp}.yaml`), `r${n} renamed`);
    assert.ok(!files.includes(`${id}.claude.r${n}.yaml`));
  }
  assert.ok(files.includes(`${id}.claude.yaml`), "the latest report stays");
  assert.ok(files.includes(`${id}.chatgpt.r1.yaml`), "the other site is untouched");
  await app.close();
});

// 13
test("saveReport attempt: 1 for round 1 or with no loop file, else the last one plus 1", async () => {
  const { app, db, id } = await ready();
  const attempt = async (round?: number) => {
    const r = await saveReport(db, id, "claude", reportAnswer, { round, baseUrl: "http://127.0.0.1:9/v1" });
    assert.ok(r.ok, r.error ?? "");
    return (parse(readFileSync(r.path!, "utf8")) as { meta: { attempt: number } }).meta.attempt;
  };
  assert.equal(await attempt(), 1, "no loop file");
  assert.equal(await attempt(), 1, "still no loop file");
  await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1", "old-1"]), ...noRender });
  assert.equal(await attempt(1), 1, "round 1");
  assert.equal(await attempt(2), 2);
  assert.equal(await attempt(3), 3);
  restartLoop(db, id, "claude");
  assert.equal(await attempt(2), 1, "the loop file is gone after a restart");
  await app.close();
});

// 14
test("worker tailor: a marker for another batch is left alone; its own batch or pending is used and put back on a throw", async () => {
  const { app, db, id } = await ready();
  setMarker(db, `fresh_tailor:${id}`, "9");
  const other = await runStage("tailor", id, "retailor-5", db);
  assert.notEqual(other.reason, "no starting record", "not fresh");
  assert.equal(marker(db, id), "9", "left in place");
  setMarker(db, `fresh_tailor:${id}`, "pending");
  const pending = await runStage("tailor", id, "retailor-5", db);
  assert.equal(pending.reason, "no starting record");
  assert.equal(marker(db, id), null);
  db.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(id); // the tailor now throws
  for (const v of ["pending", "5"]) {
    setMarker(db, `fresh_tailor:${id}`, v);
    await assert.rejects(runStage("tailor", id, "retailor-5", db));
    assert.equal(marker(db, id), v, `${v} put back`);
  }
  await app.close();
});

// 15
test("tailor route fresh: the marker holds the batch id; none for batch 0 or with the queue down", async () => {
  const { app, db, id } = await ready();
  const q = await fakeQueue();
  try {
    await withQueueUrl(q.url, async () => {
      const res = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: { fresh: true } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().tailor_batch, 7);
      assert.equal(marker(db, id), "7");
      assert.deepEqual(q.calls, [`/tailor {"job_id":"${id}"}`]);
      q.batch = 0;
      const open = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: { fresh: true } });
      assert.equal(open.statusCode, 200);
      assert.equal(open.json().tailor_batch, 0);
      assert.equal(marker(db, id), null, "an open task was not asked to be fresh");
      q.batch = 8;
      const plain = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: {} });
      assert.equal(plain.statusCode, 200);
      assert.equal(marker(db, id), null, "no fresh, no marker");
    });
    setMarker(db, `fresh_tailor:${id}`, "7");
    await withQueueUrl(DOWN, async () => {
      const down = await app.inject({ method: "POST", url: `/ui/jobs/${id}/tailor`, payload: { fresh: true } });
      assert.equal(down.statusCode, 503);
    });
    assert.equal(marker(db, id), null, "cleared when the queue is down");
  } finally {
    q.close();
  }
  await app.close();
});

