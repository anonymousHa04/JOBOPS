// Grader for task fx-a-fixtures (written by the manager; coders must not edit this file).
// Run from the repo root: node --test .claude/bin/fixtures-grader.ts
// Checks the shared test fixtures in api/test/fixtures.ts do what the spec says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bank, bullet, ext, reportAnswer, addRecord, setup, postReport } from "../../api/test/fixtures.ts";
import { latestRecord } from "../../api/src/extension/reports.ts";
import { loadBank } from "../../api/src/profile/bank.ts";

test("bullet and bank: valid bank with cur-1 (Kubernetes) and old-1 (Go)", () => {
  assert.deepEqual(bullet("x", "Did y", ["t"]), { id: "x", text: "Did y", short: "Did y", tags: ["t"], impact: "medium", source: "resume" });
  const ids = bank.roles.flatMap((r) => r.bullets.map((b) => b.id));
  assert.deepEqual(ids, ["cur-1", "old-1"]);
  assert.equal(ext["sec-fetch-site"], "none");
});

test("setup(): temp profile with the bank saved, a feedback log inside it, the default job, no record", async () => {
  const { app, db, id, dir } = await setup();
  assert.equal(process.env.JOBOPS_PROFILE_DIR, dir);
  assert.equal(process.env.JOBOPS_FEEDBACK_LOG, join(dir, "report-feedback.jsonl"));
  assert.equal(loadBank()?.roles.length, 2);
  const job = db.prepare("SELECT description FROM jobs WHERE id = ?").get(id) as { description: string };
  assert.equal(job.description, "Run Kubernetes services in Go.");
  const row = db.prepare("SELECT data FROM job_requirements WHERE job_id = ?").get(id) as { data: string };
  assert.deepEqual(JSON.parse(row.data).must_have, ["Kubernetes", "Go"]);
  assert.equal(latestRecord(db, id), null);
  await app.close();
});

test("setup({ withRecord, description, must_have }): overrides apply and the record holds cur-1 only", async () => {
  const { app, db, id } = await setup({ withRecord: true, description: "Run Kubernetes in Go with Terraform.", must_have: ["Kubernetes", "Go", "Terraform"] });
  const row = db.prepare("SELECT data FROM job_requirements WHERE job_id = ?").get(id) as { data: string };
  assert.deepEqual(JSON.parse(row.data).must_have, ["Kubernetes", "Go", "Terraform"]);
  const job = db.prepare("SELECT description FROM jobs WHERE id = ?").get(id) as { description: string };
  assert.equal(job.description, "Run Kubernetes in Go with Terraform.");
  assert.deepEqual(latestRecord(db, id)?.content.bullets.map((b) => b.id), ["cur-1"]);
  await app.close();
});

test("addRecord: a new record with exactly the given bank bullets, entry ids and texts from the bank", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  addRecord(db, id, ["old-1"]);
  const b = latestRecord(db, id)?.content.bullets ?? [];
  assert.deepEqual(b.map((x) => [x.id, x.entry_id, x.text]), [["old-1", "old", "Wrote the TypeScript billing service in Go"]]);
  await app.close();
});

test("postReport: saves reportAnswer as the job's report (201) for the given source", async () => {
  const { app, id } = await setup({ withRecord: true });
  assert.ok(reportAnswer.includes("missed_gaps:") && reportAnswer.includes("bullet_notes:"));
  const res = await postReport(app, id);
  assert.equal(res.statusCode, 201);
  assert.ok(existsSync(JSON.parse(res.body).path));
  const gpt = await postReport(app, id, "chatgpt");
  assert.match(JSON.parse(gpt.body).path, /\.chatgpt\.yaml$/);
  await app.close();
});
