import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { parse } from "yaml";
import type { Bank } from "../src/profile/schema.ts";
import { saveBank } from "../src/profile/bank.ts";
import { writeRecord } from "../src/tailor/records.ts";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

test("GET /x/jobs lists parsed jobs with their saved score, without re-scoring", async () => {
  // No reports and no real profile files: an empty profile directory.
  process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-x-"));
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const post = (n: number) =>
    app.inject({
      method: "POST",
      url: "/jobs",
      payload: { title: `Engineer ${n}`, company: `Co${n}`, description: "Build APIs.", source_url: `https://example.com/jobs/${n}` }
    });
  const tailored = JSON.parse((await post(1)).body).id as string;
  const untailored = JSON.parse((await post(2)).body).id as string;
  const unparsed = JSON.parse((await post(3)).body).id as string;
  const now = new Date().toISOString();
  for (const id of [tailored, untailored]) {
    db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, 'v1', '{}', ?)").run(id, now);
  }
  db.prepare(
    `INSERT INTO resume_records (resume_id, jd_id, path, decision, band, score, flags, content_hash, bank_hash, engine_version, created_at)
     VALUES ('r1', ?, 'x.yaml', 'adapt', 'good', 77.5, '[]', 'h', 'b', 'e', ?)`
  ).run(tailored, now);

  const res = await app.inject({ method: "GET", url: "/x/jobs", headers: { origin } });
  assert.equal(res.statusCode, 200);
  const jobs = JSON.parse(res.body).jobs as { job_id: string; score: number | null; decision: string | null; reports: string[] }[];
  assert.deepEqual(jobs.map((j) => j.job_id), [tailored, untailored], "parsed jobs only, scored first");
  assert.equal(jobs[0].score, 77.5);
  assert.equal(jobs[0].decision, "adapt");
  assert.deepEqual(jobs[0].reports, []);
  assert.equal(jobs[1].score, null);
  assert.ok(!jobs.some((j) => j.job_id === unparsed));
  await app.close();
});

test("GET /x/jobs refuses requests that are not from an extension", async () => {
  const app = buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "GET", url: "/x/jobs", headers: { origin: "https://example.com" } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("GET /x/jobs: no Origin is accepted only with Sec-Fetch-Site none (extension with host permission)", async () => {
  const app = buildApp({ db: openDb(":memory:") });
  const ext = await app.inject({ method: "GET", url: "/x/jobs", headers: { "sec-fetch-site": "none" } });
  assert.equal(ext.statusCode, 200);
  const page = await app.inject({ method: "GET", url: "/x/jobs", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(page.statusCode, 403);
  const bare = await app.inject({ method: "GET", url: "/x/jobs" });
  assert.equal(bare.statusCode, 403);
  await app.close();
});

// --- The prompt carries the tailored resume (user decision 2026-10-29) ---
const bullet = (id: string, text: string, tags: string[]) =>
  ({ id, text, short: text, tags, impact: "medium" as const, source: "resume" as const });
const bank: Bank = {
  basics: { name: "Test Person", email: "test@example.com", phone: "+91 99999 00000", location: "Bangalore", links: ["https://github.com/testperson"] },
  summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
  roles: [
    { id: "cur", title: "Senior Engineer", company: "Acme", dates: "Mar 2025 - Oct 2026",
      bullets: [bullet("cur-1", "Moved 20 services to Kubernetes", ["kubernetes", "backend"])] },
    { id: "old", title: "Engineer", company: "OldCo", dates: "Jan 2020 - Aug 2024",
      bullets: [bullet("old-1", "Wrote the TypeScript billing service in Go", ["typescript", "go", "billing"])] }
  ],
  projects: [],
  education: [{ id: "edu", degree: "B.Tech", school: "Some University", dates: "2015 - 2019", details: [] }],
  skills: { languages: ["typescript", "go"], frameworks: [], tools: ["kubernetes"], domains: [] },
  approved: true
};

async function setup(withRecord: boolean) {
  process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-x-"));
  saveBank(bank);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Backend Engineer", company: "Okta", description: "Run Kubernetes services in Go.", source_url: "https://example.com/jobs/okta" } });
  const id = JSON.parse(res.body).id as string;
  const now = new Date().toISOString();
  const data = { role: "Backend Engineer", seniority: "senior", must_have: ["Kubernetes", "Go"], nice_to_have: [], keywords: ["Kubernetes"],
    themes: [], summary_variant: "backend", job_id: id, model: "test", prompt_version: "v1", created_at: now, dropped_keywords: [] };
  db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, 'v1', ?, ?)").run(id, JSON.stringify(data), now);
  if (withRecord) {
    // The tailored resume keeps cur-1 only: the Go evidence (old-1) is in the bank but not on it.
    writeRecord(db, bank, {
      jd_id: id, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
      flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
      content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["kubernetes"],
        bullets: [{ id: "cur-1", entry_id: "cur", text: "Moved 20 services to Kubernetes", reword: null }] }
    });
  }
  return { app, id };
}

const ext = { "sec-fetch-site": "none" };

test("chat prompt: carries the tailored resume with bullet ids and roles, never contact details", async () => {
  const { app, id } = await setup(true);
  const res = await app.inject({ method: "GET", url: `/x/prompt/${id}`, headers: ext });
  assert.equal(res.statusCode, 200);
  const { basis, prompt } = JSON.parse(res.body) as { basis: string; prompt: string };
  assert.match(basis, /^record /);
  assert.ok(prompt.includes("[cur-1] Moved 20 services to Kubernetes"));
  assert.ok(prompt.includes("Senior Engineer") && prompt.includes("Acme") && prompt.includes("Mar 2025 - Oct 2026"));
  assert.ok(prompt.includes("missed_gaps") && prompt.includes("already_covered") && prompt.includes("bullet_notes"));
  assert.ok(prompt.startsWith("I'm applying for Backend Engineer at Okta"), "the prompt opens about me and the job");
  assert.ok(prompt.includes("everything you know about my work and skills") && prompt.includes("from_memory"));
  assert.ok(!/candidate/i.test(prompt), "first person throughout");
  assert.ok(prompt.includes("Use your memory\nof me as well") && prompt.includes("don't\nsave anything from this chat to your memory"));
  assert.ok(!prompt.includes("Wrote the TypeScript billing service"), "bullets left off the resume are not sent");
  for (const secret of [bank.basics.name, bank.basics.email, bank.basics.phone, bank.basics.links[0]]) {
    assert.ok(!prompt.includes(secret), `contact detail sent: ${secret}`);
  }
  await app.close();
});

test("chat prompt: without a tailored resume, gaps are against the bank and no resume is sent", async () => {
  const { app, id } = await setup(false);
  const { basis, prompt } = JSON.parse((await app.inject({ method: "GET", url: `/x/prompt/${id}`, headers: ext })).body) as { basis: string; prompt: string };
  assert.equal(basis, "bank");
  assert.ok(prompt.includes("I have no tailored resume for this job yet"));
  assert.ok(!prompt.includes("[cur-1]") && !prompt.includes("missed_gaps"));
  await app.close();
});

test("saved report: keeps the chat's resume fields and the local findings, Go as bank-only", async () => {
  const { app, id } = await setup(true);
  const answer = [
    "```yaml",
    "role_summary: Runs Kubernetes services.",
    "must_haves_ranked: [{requirement: Kubernetes, why_it_matters: Core of the job.}]",
    "gaps: [{gap: Go, advice: frame, how: Point to the Go billing work.}]",
    "keywords_priority: [Kubernetes, Go]",
    "interview_topics: [Kubernetes operations]",
    "company_notes: [Identity company.]",
    "questions_to_ask: [How is on-call shared?]",
    "missed_gaps: [{requirement: On-call ownership, why: The JD asks for it.}]",
    "already_covered: [{gap: Kubernetes, bullet_ids: [cur-1]}]",
    "bullet_notes: [{bullet_id: cur-1, note: Say what the migration improved.}]",
    "from_memory: [{fact: Ran on-call for a payments team., fills_gap: On-call ownership}]",
    "```"
  ].join("\n");
  const res = await app.inject({ method: "POST", url: `/x/reports/${id}`, headers: ext, payload: { source: "claude", text: answer } });
  assert.equal(res.statusCode, 201);
  const saved = parse(readFileSync(JSON.parse(res.body).path, "utf8"));
  assert.equal(saved.report.missed_gaps[0].requirement, "On-call ownership");
  assert.deepEqual(saved.report.already_covered[0].bullet_ids, ["cur-1"]);
  assert.equal(saved.report.from_memory[0].fills_gap, "On-call ownership");
  assert.match(saved.local.basis, /^record /);
  assert.ok(saved.local.bank_only.includes("Go"), "Go is in the bank (old-1) but not on the tailored resume");
  await app.close();
});
