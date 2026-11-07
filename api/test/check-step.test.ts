import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, addRecord, bank } from "./fixtures.ts";
import { writeRecord } from "../src/tailor/records.ts";
import type { Report } from "../src/extension/reports.ts";
import { latestRecord } from "../src/extension/reports.ts";
import { fixRound } from "../src/extension/loop.ts";
import { makeCurrent } from "../src/extension/rounds.ts";
import { decideCheck, fixStep } from "../src/extension/step.ts";
import { checkView } from "../src/ui/check.ts";
import { tailor } from "../src/tools.ts";

// "Check with Claude" after tailoring (drawer Check tab):
// - the report loop never leaves a lower-scoring resume current, and the PDF follows the best;
// - the Check view shows the resume's score against the job's, what it lost, each round's
//   changes and the report.
// Fixture job: must-haves Kubernetes (cur-1) and Go (old-1); fake chat report, fake tailor.

const report = { fit_score: 70, missed_gaps: [{ requirement: "Go", why: "asked" }], already_covered: [], bullet_notes: [] } as unknown as Report;
const writes = (db: Parameters<typeof addRecord>[0], id: string, ids: string[]) =>
  (async () => { addRecord(db, id, ids); }) as unknown as typeof tailor;
// A round that rewords cur-1 (a new text each round), so every round changes something.
const rewords = (db: Parameters<typeof addRecord>[0], id: string, round: number) => (async () => {
  const b = (i: string, text: string, entry: string) => ({ id: i, entry_id: entry, text, reword: null });
  writeRecord(db, bank, { jd_id: id, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["kubernetes"],
      bullets: [b("cur-1", `Moved 20 services to Kubernetes (pass ${round})`, "cur"), b("old-1", "Wrote the TypeScript billing service in Go", "old")] } });
}) as unknown as typeof tailor;
// A point the loop can act on every round: a note on a bullet that is on the resume.
const noted = { fit_score: 75, missed_gaps: [], already_covered: [], bullet_notes: [{ bullet_id: "cur-1", note: "Say what it improved." }] } as unknown as Report;

test("check view: a resume that lost a requirement the bank has is flagged", async () => {
  const { app, db, id } = await setup({ withRecord: true }); // the record has cur-1 only
  const v = checkView(db, id);
  assert.ok(v.resume, "has a resume");
  assert.ok(v.resume.engine_score < v.resume.job_score, "resume scores below the job");
  assert.deepEqual(v.resume.lost.map((l: { requirement: string }) => l.requirement), ["Go"]);
  await app.close();
});

test("fix step: a lower round is still what the chat sees next (its real changes), and it is not offered", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]); // both must-haves
  const first = latestRecord(db, id)!.resume_id;
  const out = await fixStep(db, id, 1, "claude", noted, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const lower = latestRecord(db, id)!.resume_id;
  assert.notEqual(lower, first, "the round's own version is current during the loop");
  assert.match(out.prompt ?? "", /Removed bullets: old-1/, "the chat is told what really changed");
  assert.doesNotMatch(out.prompt ?? "", /No bullets changed/);
  assert.match(out.prompt ?? "", /\[cur-1\]/, "the resume in the prompt is the new version");
  assert.doesNotMatch(out.prompt ?? "", /\[old-1\]/, "not the old one");
  assert.equal(out.loop?.best?.resume_id, first, "the best is still the first");
  await app.close();
});

test("fix step: a round that makes a version this check already had ends the loop (it goes in circles)", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]);
  const first = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 1, "claude", noted, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const back = (async () => { addRecord(db, id, ["cur-1", "old-1"]); return { resume_id: first }; }) as unknown as typeof tailor;
  const out = await fixStep(db, id, 2, "claude", noted, { retailor: back, render: async () => undefined });
  assert.equal(out.prompt, null);
  assert.equal(out.loop?.stopped, "repeat");
  assert.equal(latestRecord(db, id)!.resume_id, first);
  await app.close();
});

test("fix step: a failed round ends the loop with your resume unchanged", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]);
  const first = latestRecord(db, id)!.resume_id;
  const boom = (async () => { addRecord(db, id, ["cur-1"]); throw new Error("model down"); }) as unknown as typeof tailor;
  const out = await fixStep(db, id, 1, "claude", report, { retailor: boom, render: async () => undefined });
  assert.equal(out.loop?.stopped, "error");
  assert.equal(out.loop?.candidate, null, "nothing to choose");
  assert.equal(latestRecord(db, id)!.resume_id, first);
  await app.close();
});

test("fix step: 5 fix rounds at most, then your resume is current again and the best is offered", async () => {
  const { app, db, id } = await setup({ withRecord: true }); // cur-1 only
  const first = latestRecord(db, id)!.resume_id;
  let out = await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1", "old-1"]), render: async () => undefined });
  const better = out.loop!.best!.resume_id;
  assert.equal(latestRecord(db, id)!.resume_id, better, "round 2 builds on the better version");
  for (let round = 2; round <= 5; round++) {
    out = await fixStep(db, id, round, "claude", noted, { retailor: rewords(db, id, round), render: async () => undefined });
    if (round < 5) assert.ok(out.prompt, `round ${round} asks the chat again`);
  }
  assert.equal(out.prompt, null, "no sixth round");
  assert.equal(out.loop?.stopped, "round_limit");
  assert.equal(out.loop?.candidate?.resume_id, latestRecord(db, id) && out.loop?.best?.resume_id, "the best version waits for your choice");
  assert.notEqual(out.loop?.candidate?.resume_id, first);
  assert.equal(latestRecord(db, id)!.resume_id, first, "your resume is unchanged until you choose");
  await app.close();
});

test("fix step: nothing left to fix (only points that need your facts) ends the loop", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const none = { fit_score: 80, missed_gaps: [], already_covered: [], bullet_notes: [] } as unknown as Report;
  const out = await fixStep(db, id, 1, "claude", none, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  assert.equal(out.prompt, null);
  assert.equal(out.loop?.stopped, "covered");
  await app.close();
});

test("decide: use the new resume makes it current and renders its PDF; keep previous does not", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const first = latestRecord(db, id)!.resume_id;
  const out = await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1", "old-1"]), render: async () => undefined });
  const better = out.loop!.best!.resume_id;
  await fixStep(db, id, 2, "claude", { ...report, missed_gaps: [] } as unknown as Report, { retailor: writes(db, id, ["cur-1", "old-1"]), render: async () => undefined });
  assert.equal(latestRecord(db, id)!.resume_id, first);
  const rendered: string[] = [];
  const keep = await decideCheck(db, id, "claude", { use: "previous" }, async (r) => { rendered.push(r); });
  assert.equal(keep.resume_id, first);
  assert.equal(latestRecord(db, id)!.resume_id, first);
  const use = await decideCheck(db, id, "claude", { use: "new" }, async (r) => { rendered.push(r); });
  assert.equal(use.resume_id, better);
  assert.equal(latestRecord(db, id)!.resume_id, better);
  assert.deepEqual(rendered, [better], "only the chosen new resume gets a PDF");
  await app.close();
});

test("check view: rounds with their engine and chat scores and the bullets each one changed", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  await fixStep(db, id, 1, "claude", report, { retailor: writes(db, id, ["cur-1", "old-1"]), render: async () => undefined });
  const v = checkView(db, id);
  const loop = v.loops.find((l: { source: string }) => l.source === "claude");
  assert.ok(loop, "the claude loop is shown");
  assert.equal(loop.rounds.length, 2);
  assert.equal(loop.rounds[0].chat_score, 70, "the chat scored the resume it was shown");
  assert.deepEqual(loop.rounds[1].added.map((b: { id: string }) => b.id), ["old-1"]);
  assert.equal(loop.rounds[1].kept, true);
  await app.close();
});

test("routes: GET check answers the view; the PDF route serves only stored records' PDFs", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const res = await app.inject({ method: "GET", url: `/ui/jobs/${id}/check` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().resume.lost.map((l: { requirement: string }) => l.requirement), ["Go"]);
  const rid = latestRecord(db, id)!.resume_id;
  assert.equal((await app.inject({ method: "GET", url: `/ui/resumes/${rid}/pdf` })).statusCode, 404, "no PDF rendered in tests");
  assert.equal((await app.inject({ method: "GET", url: `/ui/resumes/..%2F..%2Fetc%2Fpasswd/pdf` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/ui/resumes/not-a-record/pdf` })).statusCode, 404);
  await app.close();
});

test("fix round: a round that lands on a resume made before (same content) still counts as that resume", async () => {
  const { app, db, id } = await setup({ withRecord: true }); // A: cur-1
  const a = latestRecord(db, id)!.resume_id;
  addRecord(db, id, ["cur-1", "old-1"]);                     // B, from an earlier check
  const b = latestRecord(db, id)!.resume_id;
  makeCurrent(db, a);                                        // A is the resume again
  // The tailor writes B's content again: the store returns B as it is (created: false).
  const again = (async () => { addRecord(db, id, ["cur-1", "old-1"]); return { resume_id: b, created: false }; }) as unknown as typeof tailor;
  const fix = await fixRound(db, id, 1, report, again);
  assert.equal(fix.changed, true, "B differs from A");
  assert.deepEqual(fix.added, ["old-1"]);
  assert.equal(latestRecord(db, id)!.resume_id, b, "B is the resume the round made");
  await app.close();
});

test("choose: any version of a finished check can be chosen; it becomes your resume and gets its PDF", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]);
  const first = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 1, "claude", noted, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const lower = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 2, "claude", { ...noted, bullet_notes: [] } as unknown as Report, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  assert.equal(latestRecord(db, id)!.resume_id, first, "finished: your resume is back");
  const rendered: string[] = [];
  const r = await decideCheck(db, id, "claude", { resume_id: lower }, async (x) => { rendered.push(x); });
  assert.equal(r.resume_id, lower);
  assert.equal(latestRecord(db, id)!.resume_id, lower, "the chosen version is your resume");
  assert.deepEqual(rendered, [lower], "its PDF is made");
  await assert.rejects(decideCheck(db, id, "claude", { resume_id: "not-in-this-check" }, async () => undefined), /not a version of this check/);
  await app.close();
});

test("choose route: makes the version current and re-scores the job; refused while the check runs", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]);
  const first = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 1, "claude", noted, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const lower = latestRecord(db, id)!.resume_id;
  const running = await app.inject({ method: "POST", url: `/ui/jobs/${id}/check/decide`, payload: { source: "claude", resume_id: first } });
  assert.equal(running.statusCode, 409, "the check has not finished");
  await fixStep(db, id, 2, "claude", { ...noted, bullet_notes: [] } as unknown as Report, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const calls: string[] = [];
  const { createServer } = await import("node:http");
  const q = createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { calls.push(`${rq.url} ${b}`); rs.setHeader("content-type", "application/json"); rs.end('{"batch_id":7}'); }); });
  await new Promise<void>((r) => q.listen(0, "127.0.0.1", r));
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = `http://127.0.0.1:${(q.address() as { port: number }).port}`;
  try {
    const res = await app.inject({ method: "POST", url: `/ui/jobs/${id}/check/decide`, payload: { source: "claude", resume_id: lower } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().resume_id, lower);
    assert.equal(res.json().rescore_batch, 7);
    assert.deepEqual(calls, [`/rescore {"job_id":"${id}"}`]);
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
    q.close();
  }
  await app.close();
});

test("resume list: every tailored resume of the job, best engine score first, with the current one marked", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1"]);
  const low = latestRecord(db, id)!.resume_id;
  addRecord(db, id, ["cur-1", "old-1"]);
  const high = latestRecord(db, id)!.resume_id;
  makeCurrent(db, low);
  const v = checkView(db, id);
  assert.deepEqual(v.resumes.map((r) => r.resume_id), [high, low], "best first");
  assert.equal(v.resumes.find((r) => r.resume_id === low)?.current, true);
  assert.ok(v.resumes[0].engine_score > v.resumes[1].engine_score);
  assert.ok(v.job_score != null && v.job_score >= v.resumes[0].engine_score, "the whole bank is the ceiling");
  await app.close();
});

test("choose a resume from the list: it becomes current; another job's resume is refused; the next check is a new chat", async () => {
  const { app, db, id } = await setup();
  addRecord(db, id, ["cur-1", "old-1"]);
  const first = latestRecord(db, id)!.resume_id;
  await fixStep(db, id, 1, "claude", noted, { retailor: writes(db, id, ["cur-1"]), render: async () => undefined });
  const lower = latestRecord(db, id)!.resume_id;
  makeCurrent(db, first);
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = "http://" + "127.0.0.1:1"; // queue down: the choice still works
  try {
    const res = await app.inject({ method: "POST", url: `/ui/jobs/${id}/resumes/${lower}/choose` });
    assert.equal(res.statusCode, 200);
    assert.equal(latestRecord(db, id)!.resume_id, lower);
    assert.equal(checkView(db, id).loops[0].decision, "chosen", "the next check starts a new chat");
    const other = await setup({ withRecord: true });
    const foreign = latestRecord(other.db, other.id)!.resume_id;
    assert.equal((await app.inject({ method: "POST", url: `/ui/jobs/${id}/resumes/${foreign}/choose` })).statusCode, 404);
    await other.app.close();
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
  await app.close();
});
