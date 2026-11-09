import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import type { ResumeRecord, SkillsExtra } from "../src/profile/schema.ts";
import { exitIssues } from "../src/render/exit-gate.ts";
import { pdfChecksPassed, pdfDir, renderRecord } from "../src/render/render.ts";
import { openResumeAvailable } from "../src/render/openresume.ts";
import { fakeBank, fakeRecord } from "../src/render/fake-resume.ts";
import { openFactFlags, reportsDir, resolveFactFlags } from "../src/extension/reports.ts";
import { saveBank } from "../src/profile/bank.ts";
import { bankAudit } from "../src/tools.ts";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { writeRecord } from "../src/tailor/records.ts";

// Exit gate (plan-exit-gate.md K0, tests K5 cases 1-5): the skills line, the summary and open
// chat fact flags block a PDF; checks.json records what ran; the PDF route needs a passing
// checks file; only known files write the profile. Fake person, fake bank, temp folders.

// CI has no OpenResume copy; case 4 unsets it for one test and restores it.
process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";

const hasTools = ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error) && !spawnSync("pdfinfo", ["-v"]).error;
const skip = !hasTools && "typst, pdftotext, or pdfinfo missing";
const tempDir = () => mkdtempSync(join(tmpdir(), "jobops-exit-"));
const JOB = "job-fake";

// A fresh temp profile for each test (reports, skills-extra, pdf live under it).
function profile(): string {
  const dir = tempDir();
  process.env.JOBOPS_PROFILE_DIR = dir;
  process.env.JOBOPS_FEEDBACK_LOG = join(dir, "report-feedback.jsonl");
  return dir;
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// The fake record for the fake job, with changes to its content.
function rec(content: Partial<ResumeRecord["content"]> = {}): ResumeRecord {
  const r = fakeRecord();
  return { ...r, jd_id: JOB, content: { ...r.content, ...content } } as ResumeRecord;
}

const noExtra: SkillsExtra = { skills: [], dismissed: [], learnable: [] };
const extraWith = (name: string, evidence: string): SkillsExtra =>
  ({ ...noExtra, skills: [{ name, status: "have", evidence, added_at: "2026-11-08" }] });

// A saved chat report for the fake job with fact flags on these bullets.
function saveFlags(flags: { bullet_id: string; why: string }[], job = JOB) {
  mkdirSync(reportsDir(), { recursive: true });
  const report = {
    role_summary: "Runs backend services.",
    must_haves_ranked: [{ requirement: "Go", why_it_matters: "Core of the job." }],
    gaps: [], keywords_priority: ["Go"], interview_topics: ["Queues"], company_notes: ["Fake company."], questions_to_ask: ["Who owns on-call?"],
    fact_flags: flags.map((f) => ({ ...f, problem: "number" }))
  };
  writeFileSync(join(reportsDir(), `${job}.claude.yaml`),
    stringify({ meta: { job_id: job, source: "claude", saved_at: "2026-11-08T00:00:00Z" }, report }));
}

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);
const pdfs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".pdf")) : []);
type Checks = { checks: { name: string; ran: boolean; ok: boolean; codes: string[] }[] };
const readChecks = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.checks.json`), "utf8")) as Checks;
const PARSE_BACK = ["layout", "pages_fonts", "pdftotext", "pdfjs", "openresume"];

// 1. Skills line
test("1. exitIssues: a 'have' skill whose answer does not name it is skill_unsupported (skill#N)", () => {
  profile();
  const r = rec({ skills: [...fakeRecord().content.skills, "Terraform"] });
  const issues = exitIssues(r, fakeBank, extraWith("terraform", "answer 2026-11-08: set up the deploy scripts for staging"), []);
  assert.deepEqual(issues.map((i) => [i.code, i.detail]), [["skill_unsupported", "skill#6"]]);
});

test("1. renderRecord: an unsupported skill gives skill_unsupported and no PDF", async () => {
  profile();
  const out = tempDir();
  const r = await renderRecord(rec({ skills: [...fakeRecord().content.skills, "Terraform"] }), fakeBank,
    { outDir: out, extra: extraWith("terraform", "answer 2026-11-08: set up the deploy scripts for staging") });
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.ok(codes(r).includes("skill_unsupported"), JSON.stringify(r.issues));
  assert.deepEqual(pdfs(out), []);
});

test("1. exitIssues: the same skill with an answer that names it passes", () => {
  profile();
  const r = rec({ skills: [...fakeRecord().content.skills, "Terraform"] });
  assert.deepEqual(exitIssues(r, fakeBank, extraWith("terraform", "answer 2026-11-08: wrote terraform modules for the staging stack"), []), []);
});

test("1. exitIssues: a bank skill in another spelling (synonym k8s, golang) is not flagged", () => {
  profile();
  const r = rec({ skills: ["TypeScript", "golang", "React", "k8s", "postgres"] });
  assert.deepEqual(exitIssues(r, fakeBank, noExtra, []), []);
});

// 2. Summary
test("2. exitIssues: a summary that differs from the bank variant is summary_changed; identical is none", () => {
  profile();
  const changed = exitIssues(rec({ summary_text: "Backend engineer with ten years of experience." }), fakeBank, noExtra, []);
  assert.deepEqual(changed.map((i) => [i.code, i.detail]), [["summary_changed", "backend"]]);
  assert.deepEqual(exitIssues(rec(), fakeBank, noExtra, []), []);
});

// 3. Chat fact flags
test("3. renderRecord: an open fact flag on a resume bullet blocks; after resolveFactFlags it renders", async () => {
  profile();
  saveFlags([{ bullet_id: "acme-1", why: "The 40% does not fit the other bullets." }]);
  const out = tempDir();
  const blocked = await renderRecord(rec(), fakeBank, { outDir: out, extra: noExtra });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.issues.filter((i) => i.code === "fact_flag_open").map((i) => i.detail), ["acme-1"]);
  assert.deepEqual(pdfs(out), []);

  assert.deepEqual(resolveFactFlags("acme-1", "checked the deploy logs: 40% is right"), { resolved: 1 });
  assert.deepEqual(openFactFlags(JOB, rec().content.bullets.map((b) => b.id)), []);
  const after = await renderRecord(rec(), fakeBank, { outDir: out, extra: noExtra });
  assert.ok(!codes(after).includes("fact_flag_open"), JSON.stringify(after.issues));
  if (hasTools) assert.equal(after.ok, true, JSON.stringify(after));
});

test("3. resolveFactFlags: an empty reason throws 'reason is required'", () => {
  profile();
  saveFlags([{ bullet_id: "acme-1", why: "The 40% does not fit the other bullets." }]);
  assert.throws(() => resolveFactFlags("acme-1", "   "), /reason is required/);
  assert.deepEqual(openFactFlags(JOB, ["acme-1"]), ["acme-1"], "nothing resolved");
});

test("3. renderRecord: a flag on a bullet not on the resume does not block", async () => {
  profile();
  saveFlags([{ bullet_id: "other-9", why: "Reads like a different job." }]);
  const r = await renderRecord(rec(), fakeBank, { outDir: tempDir(), extra: noExtra });
  assert.ok(!codes(r).includes("fact_flag_open"), JSON.stringify(r.issues));
  if (hasTools) assert.equal(r.ok, true, JSON.stringify(r));
});

test("3. bankAudit: a resolved flag is no longer listed", () => {
  profile();
  saveBank(fakeBank);
  saveFlags([{ bullet_id: "acme-1", why: "The 40% does not fit the other bullets." }]);
  assert.equal(bankAudit().bullets.find((b) => b.id === "acme-1")?.chat?.length, 1);
  resolveFactFlags("acme-1", "checked the deploy logs");
  assert.equal(bankAudit().bullets.find((b) => b.id === "acme-1")?.chat, undefined);
});

// 4. checks.json
test("4. checks.json: readers pdftotext,pdfjs -> 7 checks, six ran and ok, openresume ran=false; pdfChecksPassed is false", { skip }, async () => {
  profile();
  const out = tempDir();
  const r = await renderRecord(rec(), fakeBank, { outDir: out, extra: noExtra });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { checks } = readChecks(out, rec().resume_id);
  assert.deepEqual(r.checks, checks, "RenderResult.checks is what the file holds");
  assert.deepEqual(checks.map((c) => c.name), ["bank_gate", "exit_gate", ...PARSE_BACK]);
  assert.ok(checks.filter((c) => c.name !== "openresume").every((c) => c.ran && c.ok), JSON.stringify(checks));
  const or = checks.find((c) => c.name === "openresume");
  assert.equal(or?.ran, false, "a reader not in JOBOPS_PARSE_READERS did not run");
  assert.equal(or?.ok, false);
  assert.equal(pdfChecksPassed(rec().resume_id, out), false, "no PDF served when openresume did not run");
});

const skipAll = skip || (!openResumeAvailable() && "OpenResume runner not installed (CI)");
test("4. checks.json: all readers (JOBOPS_PARSE_READERS unset) -> 7 checks, all ran and ok; pdfChecksPassed is true", { skip: skipAll }, async () => {
  profile();
  const out = tempDir();
  const r = await withEnv({ JOBOPS_PARSE_READERS: undefined }, () =>
    renderRecord(rec(), fakeBank, { outDir: out, extra: noExtra }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const { checks } = readChecks(out, rec().resume_id);
  assert.deepEqual(checks.map((c) => c.name), ["bank_gate", "exit_gate", ...PARSE_BACK]);
  assert.ok(checks.every((c) => c.ran && c.ok), JSON.stringify(checks));
  assert.equal(pdfChecksPassed(rec().resume_id, out), true);
});

test("4. checks.json: after a gate failure the five parse-back checks did not run; pdfChecksPassed is false", async () => {
  profile();
  const out = tempDir();
  const r = await renderRecord(rec({ summary_text: "Changed summary." }), fakeBank, { outDir: out, extra: noExtra });
  assert.equal(r.ok, false);
  const { checks } = readChecks(out, rec().resume_id);
  assert.deepEqual(checks.filter((c) => !c.ran).map((c) => c.name), PARSE_BACK);
  assert.equal(checks.find((c) => c.name === "exit_gate")?.ok, false);
  assert.equal(pdfChecksPassed(rec().resume_id, out), false);
});

test("4. pdfChecksPassed: a missing checks file is false", () => {
  assert.equal(pdfChecksPassed("no-such-resume", tempDir()), false);
});

test("4. checks.json: OpenResume required and missing -> openresume ran=false; pdfChecksPassed is false", { skip }, async () => {
  profile();
  const out = tempDir();
  const r = await withEnv({ JOBOPS_PARSE_READERS: undefined, JOBOPS_OPENRESUME_DIR: tempDir() }, () =>
    renderRecord(rec(), fakeBank, { outDir: out, extra: noExtra }));
  assert.equal(r.ok, false);
  const { checks } = readChecks(out, rec().resume_id);
  assert.equal(checks.find((c) => c.name === "openresume")?.ran, false, JSON.stringify(checks));
  assert.equal(pdfChecksPassed(rec().resume_id, out), false);
});

test("4. GET /ui/resumes/:rid/pdf: a record whose checks file is missing is 409 checks", async () => {
  profile();
  saveBank(fakeBank);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Backend Engineer", company: "Fakecorp", description: "Run backend services.", source_url: "https://example.com/jobs/fakecorp" } });
  const jobId = JSON.parse(res.body).id as string;
  const { record } = writeRecord(db, fakeBank, {
    jd_id: jobId, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { ...fakeRecord().content, bullets: fakeRecord().content.bullets.map((b) => ({ ...b, reword: null })) }
  });
  mkdirSync(pdfDir(), { recursive: true });
  writeFileSync(join(pdfDir(), `${record.resume_id}.pdf`), "%PDF-1.4 fake");
  const pdf = await app.inject({ method: "GET", url: `/ui/resumes/${record.resume_id}/pdf` });
  assert.equal(pdf.statusCode, 409, pdf.body);
  assert.equal((JSON.parse(pdf.body) as { error: string }).error, "checks");
});

// 5. Static guard: one way into the profile.
const WRITERS = /\b(saveBank|saveSkillsExtra|addSynonym)\s*\(/;
const ALLOWED = ["api/src/profile/bank.ts", "api/src/lists.ts", "api/src/ui/gaps.ts", "api/src/ui/gap-memory.ts", "api/src/tools.ts"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsFiles(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []);
}

test("5. saveBank / saveSkillsExtra / addSynonym are called only from the allowed files", () => {
  const root = join(import.meta.dirname, "..", "..");
  const bad: string[] = [];
  for (const file of tsFiles(join(root, "api", "src"))) {
    const rel = relative(root, file).split("\\").join("/");
    if (ALLOWED.includes(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (!WRITERS.test(line) || /\bfunction\s+(saveBank|saveSkillsExtra|addSynonym)\b/.test(line)) return;
      bad.push(`${rel}:${i + 1}: ${t}`);
    });
  }
  assert.deepEqual(bad, [], `a new writer to the profile needs review (plan-exit-gate.md K0):\n${bad.join("\n")}`);
});
