import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, addRecord, postReport, ext } from "./fixtures.ts";
import { fixRound } from "../src/extension/loop.ts";
import { followUpPrompt } from "../src/extension/reports.ts";
import type { Report } from "../src/extension/reports.ts";
import { tailor } from "../src/tools.ts";

const empty: Report = { missed_gaps: [], already_covered: [], bullet_notes: [] } as unknown as Report;

test("fixRound: new record -> changed, old-1 added, cur-1 removed", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const fake = async () => { addRecord(db, id, ["old-1"]); };
  const result = await fixRound(db, id, 1, empty, fake as unknown as typeof tailor);
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["old-1"]);
  assert.deepEqual(result.removed, ["cur-1"]);
  assert.deepEqual(result.reworded, []);
  await app.close();
});

test("fixRound: same content again -> not changed", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const fake = async () => { addRecord(db, id, ["old-1"]); };
  await fixRound(db, id, 1, empty, fake as unknown as typeof tailor);
  const result = await fixRound(db, id, 2, empty, fake as unknown as typeof tailor);
  assert.equal(result.changed, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  await app.close();
});

test("followUpPrompt: attempt line, the resume, no contact details", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const changes = { added: ["old-1"], removed: ["cur-1"], reworded: [], needs_facts: [] };
  const prompt = followUpPrompt(db, id, 2, changes, 5);
  assert.match(prompt, /^Attempt 2 of 5: Based on your input/);
  assert.match(prompt, /old-1/);
  assert.match(prompt, /Moved 20 services to Kubernetes/);
  assert.doesNotMatch(prompt, /test@example\.com/);
  await app.close();
});

test("POST /x/fix: round 5 is the last: no sixth ask", async () => {
  const { app, id } = await setup({ withRecord: true });
  await postReport(app, id);
  const res = await app.inject({
    method: "POST",
    url: `/x/fix/${id}`,
    headers: ext,
    payload: { round: 5, source: "claude" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().prompt, null);
  await app.close();
});
