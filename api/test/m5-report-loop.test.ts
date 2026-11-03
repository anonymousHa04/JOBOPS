import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, addRecord, postReport, ext, reportAnswer } from "./fixtures.ts";
import { engineScore, loadLoop, makeCurrent, setChatScore, startLoop } from "../src/extension/rounds.ts";
import { latestRecord, loadReport } from "../src/extension/reports.ts";

// Milestone 5: the report loop must raise the engine score. No model runs here: a fix round
// that needs one ends with an error, which must also leave the best version current.

test("startLoop: version 0 is the current record with its engine score", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const record = latestRecord(db, id)!;
  const loop = startLoop(db, id, "claude");
  assert.equal(loop.versions.length, 1);
  assert.deepEqual(loop.versions[0], { version: 0, resume_id: record.resume_id, engine_score: engineScore(db, id, record), chat_score: null, needs_facts: [] });
  assert.deepEqual(loop.best, { version: 0, resume_id: record.resume_id, engine_score: loop.versions[0].engine_score });
  await app.close();
});

test("setChatScore: a number is recorded, a missing fit_score changes nothing", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const loop = startLoop(db, id, "claude");
  const rid = loop.versions[0].resume_id;
  setChatScore(loop, rid, 72);
  assert.equal(loop.versions[0].chat_score, 72);
  setChatScore(loop, rid, undefined);
  assert.equal(loop.versions[0].chat_score, 72);
  await app.close();
});

test("makeCurrent: an older record becomes the job's current resume again", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const first = latestRecord(db, id)!.resume_id;
  await new Promise((r) => setTimeout(r, 5)); // a later created_at
  addRecord(db, id, ["old-1"]);
  assert.notEqual(latestRecord(db, id)!.resume_id, first);
  makeCurrent(db, first);
  assert.equal(latestRecord(db, id)!.resume_id, first);
  await app.close();
});

test("POST /x/fix: no gain stops the loop and keeps the best version current", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  await postReport(app, id);
  const res = await app.inject({ method: "POST", url: `/x/fix/${id}`, headers: ext, payload: { round: 1, source: "claude" } });
  assert.equal(res.statusCode, 200);
  const { prompt, loop } = res.json();
  assert.equal(loop.rounds[0].version, 0);
  const second = loop.rounds[1];
  if (!second || second.engine_score <= loop.rounds[0].engine_score) {
    // No new version, or one that did not raise the engine score: the loop ends here.
    assert.equal(prompt, null);
    assert.ok(loop.stopped === "no_gain" || loop.stopped === "error", `stopped = ${loop.stopped}`);
  }
  if (prompt === null) assert.equal(latestRecord(db, id)!.resume_id, loop.best.resume_id);
  assert.deepEqual(loadLoop(id, "claude")?.best, loop.best);
  await app.close();
});

test("POST /x/fix: round 5 with no earlier rounds answers as before", async () => {
  const { app, id } = await setup({ withRecord: true });
  await postReport(app, id);
  const res = await app.inject({ method: "POST", url: `/x/fix/${id}`, headers: ext, payload: { round: 5, source: "claude" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { fix: null, prompt: null });
  await app.close();
});

test("report: the chat's fit_score is saved with the report", async () => {
  const { app, id } = await setup({ withRecord: true });
  const text = reportAnswer.replace("role_summary:", "fit_score: 64\nrole_summary:");
  const res = await app.inject({ method: "POST", url: `/x/reports/${id}`, headers: ext, payload: { source: "claude", text } });
  assert.equal(res.statusCode, 201);
  assert.equal(loadReport(id, "claude")?.fit_score, 64);
  await app.close();
});
