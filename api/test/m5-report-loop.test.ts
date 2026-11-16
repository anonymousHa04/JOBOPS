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

test("POST /x/fix: when the loop ends, your resume from before the check is current (user chooses after)", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  await postReport(app, id);
  const res = await app.inject({ method: "POST", url: `/x/fix/${id}`, headers: ext, payload: { round: 1, source: "claude" } });
  assert.equal(res.statusCode, 200);
  const { prompt, loop } = res.json();
  assert.equal(loop.rounds[0].version, 0);
  // Ended (nothing left to fix, nothing changed, or an error): the start is current again, and
  // a version that scored the same or higher waits as the candidate (2026-11-07).
  if (prompt === null) {
    assert.ok(["covered", "no_change", "error"].includes(loop.stopped), `stopped = ${loop.stopped}`);
    assert.equal(latestRecord(db, id)!.resume_id, loop.rounds[0].resume_id);
  }
  assert.deepEqual(loadLoop(id, "claude")?.best, loop.best);
  await app.close();
});

test("POST /x/fix: round 5 is the last fix round: it fixes, then the loop ends (no sixth ask)", async () => {
  const { app, id } = await setup({ withRecord: true });
  await postReport(app, id);
  const res = await app.inject({ method: "POST", url: `/x/fix/${id}`, headers: ext, payload: { round: 5, source: "claude" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().prompt, null);
  assert.ok(res.json().loop.stopped, "the loop is over");
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
