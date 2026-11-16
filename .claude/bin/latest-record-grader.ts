// Grader for task loop-08c-latest-tiebreak (written by the manager; coders must not edit this file).
// Run from the repo root: node --test .claude/bin/latest-record-grader.ts
// Two records written in the same millisecond: the one written last must be "the latest".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../api/src/app.ts";
import { openDb } from "../../api/src/db.ts";
import type { Bank } from "../../api/src/profile/schema.ts";
import { saveBank } from "../../api/src/profile/bank.ts";
import { writeRecord } from "../../api/src/tailor/records.ts";
import { latestRecord } from "../../api/src/extension/reports.ts";

const b = (id: string, text: string) => ({ id, text, short: text, tags: ["go"], impact: "medium" as const, source: "resume" as const });
const bank: Bank = {
  basics: { name: "Test Person", email: "test@example.com", phone: "+91 99999 00000", location: "Bangalore", links: [] },
  summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
  roles: [{ id: "cur", title: "Engineer", company: "Acme", dates: "2020 - 2026", bullets: [b("a-1", "Did A"), b("z-1", "Did Z")] }],
  projects: [], education: [{ id: "edu", degree: "B.Tech", school: "Some University", dates: "2015 - 2019", details: [] }], skills: { languages: ["go"], frameworks: [], tools: [], domains: [] }, approved: true
};

async function twoRecordsSameTime(firstId: string, secondId: string) {
  process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-tie-"));
  saveBank(bank);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs", payload: { title: "Backend Engineer", company: "Okta",
    description: "Run services.", source_url: "https://example.com/jobs/tie" } });
  const id = JSON.parse(res.body).id as string;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, 'v1', ?, ?)").run(id, JSON.stringify({
    role: "Backend Engineer", seniority: "senior", must_have: ["Go"], nice_to_have: [], keywords: [], themes: [], summary_variant: "backend",
    job_id: id, model: "test", prompt_version: "v1", created_at: now, dropped_keywords: [] }), now);
  const at = new Date("2026-10-30T10:00:00.000Z");
  const write = (bid: string, score: number) => writeRecord(db, bank, { jd_id: id, source_resume_id: null, decision: "adapt", reason: "t",
    band: "good", score, equivalence: null, flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: [], bullets: [{ id: bid, entry_id: "cur", text: bid === "a-1" ? "Did A" : "Did Z", reword: null }] } }, at);
  write(firstId, 60);
  write(secondId, 80);
  return { app, db, id };
}

// Both orders, so neither the resume id nor the content hash can decide the tie by luck.
for (const [first, second] of [["a-1", "z-1"], ["z-1", "a-1"]]) {
  test(`latestRecord: same created_at, written ${first} then ${second} -> ${second}`, async () => {
    const { app, db, id } = await twoRecordsSameTime(first, second);
    assert.deepEqual(latestRecord(db, id)?.content.bullets.map((x) => x.id), [second]);
    await app.close();
  });
  test(`GET /x/jobs: same created_at, written ${first} then ${second} -> score of ${second}`, async () => {
    const { app, id } = await twoRecordsSameTime(first, second);
    const res = await app.inject({ method: "GET", url: "/x/jobs", headers: { "sec-fetch-site": "none" } });
    const row = (JSON.parse(res.body).jobs ?? JSON.parse(res.body)).find((j: { job_id: string }) => j.job_id === id);
    assert.equal(row?.score, 80);
    await app.close();
  });
}
