import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.ts";
import { parse } from "yaml";
import type { Bank } from "../src/profile/schema.ts";
import type { Db } from "../src/db.ts";
import { saveBank } from "../src/profile/bank.ts";
import { writeRecord } from "../src/tailor/records.ts";
import { buildApp } from "../src/app.ts";

export const ext = { "sec-fetch-site": "none" };

export const bullet = (id: string, text: string, tags: string[]) =>
  ({ id, text, short: text, tags, impact: "medium" as const, source: "resume" as const });

export const bank: Bank = {
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

export const reportAnswer: string = [
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

export function addRecord(db: Db, jobId: string, bulletIds: string[]): void {
  const content = {
    summary_variant: "backend",
    summary_text: "Backend engineer.",
    skills: ["kubernetes"],
    bullets: bulletIds.map(id => {
      const role = bank.roles.find(r => r.bullets.some(b => b.id === id));
      if (!role) throw new Error(`Role not found for bullet id: ${id}`);
      const bullet = role.bullets.find(b => b.id === id);
      if (!bullet) throw new Error(`Bullet not found for id: ${id}`);
      return { id, entry_id: role.id, text: bullet.text, reword: null };
    })
  };
  writeRecord(db, bank, {
    jd_id: jobId, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content
  });
}

export async function setup(opts: { withRecord?: boolean; description?: string; must_have?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jobops-x-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  process.env.JOBOPS_FEEDBACK_LOG = join(dir, "report-feedback.jsonl");
  saveBank(bank);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Backend Engineer", company: "Okta", description: opts.description ?? "Run Kubernetes services in Go.", source_url: "https://example.com/jobs/okta" } });
  const id = JSON.parse(res.body).id as string;
  const now = new Date().toISOString();
  const data = { role: "Backend Engineer", seniority: "senior", must_have: opts.must_have ?? ["Kubernetes", "Go"], nice_to_have: [], keywords: ["Kubernetes"],
    themes: [], summary_variant: "backend", job_id: id, model: "test", prompt_version: "v1", created_at: now, dropped_keywords: [] };
  db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, 'v1', ?, ?)").run(id, JSON.stringify(data), now);
  if (opts.withRecord) {
    addRecord(db, id, ["cur-1"]);
  }
  return { app, db, id, dir };
}

export async function postReport(app: FastifyInstance, jobId: string, source: "claude" | "chatgpt" = "claude") {
  return app.inject({ method: "POST", url: `/x/reports/${jobId}`, headers: ext, payload: { source, text: reportAnswer } });
}
