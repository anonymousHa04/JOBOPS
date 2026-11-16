// Grader for task loop-08b-review-counts (written by the manager; coders must not edit this file).
// Run from the repo root: node --test .claude/bin/review-counts-grader.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addRecord, setup } from "../../api/test/fixtures.ts";
import { fixRound } from "../../api/src/extension/loop.ts";
import type { Report } from "../../api/src/extension/reports.ts";
import type { tailor } from "../../api/src/tools.ts";

test("fixRound review counts every finding: one valid, one wrong", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const report = { missed_gaps: [{ requirement: "Rust", why: "x" }, { requirement: "Go", why: "x" }], already_covered: [], bullet_notes: [] } as unknown as Report;
  const fake = (async () => { addRecord(db, id, ["cur-1", "old-1"]); }) as unknown as typeof tailor;
  const r = await fixRound(db, id, 1, report, fake);
  assert.deepEqual(r.review, { valid: 1, wrong: 1, unclear: 0, causes: { not_in_jd: 1, selection_dropped: 1 } });
  await app.close();
});

test("fixRound review counts are the same when the re-tailor fails (the error result)", async () => {
  const { app, db, id } = await setup({ withRecord: true });
  const report = { missed_gaps: [{ requirement: "Rust", why: "x" }, { requirement: "Go", why: "x" }], already_covered: [], bullet_notes: [] } as unknown as Report;
  const failing = (async () => { throw new Error("model down"); }) as unknown as typeof tailor;
  const r = await fixRound(db, id, 1, report, failing);
  assert.equal(r.error, "model down");
  assert.deepEqual(r.review, { valid: 1, wrong: 1, unclear: 0, causes: { not_in_jd: 1, selection_dropped: 1 } });
  await app.close();
});
