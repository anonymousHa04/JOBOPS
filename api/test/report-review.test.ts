import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./fixtures.ts";
import { reviewReport } from "../src/extension/review.ts";
import { readFileSync } from "node:fs";
import type { Report } from "../src/extension/reports.ts";
import type { Finding } from "../src/extension/review.ts";

const opts = {
  withRecord: true,
  description: "Run Kubernetes services in Go with Terraform.",
  must_have: ["Kubernetes", "Go", "Terraform"]
};

const report: Report = {
  missed_gaps: [
    { requirement: "Rust", why: "x" },
    { requirement: "Go", why: "x" },
    { requirement: "Terraform", why: "x" }
  ],
  already_covered: [
    { gap: "Go", bullet_ids: ["old-1"] }
  ],
  bullet_notes: []
} as unknown as Report;

const find = (fs: Finding[], kind: string, item: string) => fs.find((f) => f.kind === kind && f.item === item);

test("Rust -> wrong / not_in_jd", async () => {
  const { app, db, id } = await setup(opts);
  const f = find(reviewReport(db, id, 1, report), "missed_gap", "Rust");
  assert.equal(f?.verdict, "wrong");
  assert.equal(f?.cause, "not_in_jd");
  await app.close();
});

test("Go -> valid / selection_dropped", async () => {
  const { app, db, id } = await setup(opts);
  const f = find(reviewReport(db, id, 1, report), "missed_gap", "Go");
  assert.equal(f?.verdict, "valid");
  assert.equal(f?.cause, "selection_dropped");
  await app.close();
});

test("Terraform -> valid / needs_facts", async () => {
  const { app, db, id } = await setup(opts);
  const f = find(reviewReport(db, id, 1, report), "missed_gap", "Terraform");
  assert.equal(f?.verdict, "valid");
  assert.equal(f?.cause, "needs_facts");
  await app.close();
});

test("already_covered Go -> wrong / bullet_not_on_resume", async () => {
  const { app, db, id } = await setup(opts);
  const f = find(reviewReport(db, id, 1, report), "already_covered", "Go");
  assert.equal(f?.verdict, "wrong");
  assert.equal(f?.cause, "bullet_not_on_resume");
  await app.close();
});

test("one log line per review", async () => {
  const { app, db, id } = await setup(opts);
  reviewReport(db, id, 1, report);
  const logPath = process.env.JOBOPS_FEEDBACK_LOG as string;
  const logContent = readFileSync(logPath, "utf8");
  const logLines = logContent.split("\n").filter(line => line.trim() !== "");
  assert.equal(logLines.length, 1);
  const logEntry = JSON.parse(logLines[0]);
  assert.equal(logEntry.job_id, id);
  assert.equal(logEntry.round, 1);
  await app.close();
});
