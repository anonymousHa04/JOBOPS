import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ResumeRecord, SkillsExtra } from "../src/profile/schema.ts";
import type { Issue } from "../src/render/parseback.ts";
import { openDb } from "../src/db.ts";
import { forTask } from "../src/model/registry.ts";
import { fakeBank, fakeRecord } from "../src/render/fake-resume.ts";
import { pdfChecksPassed, renderRecord } from "../src/render/render.ts";
import { openResumeAvailable } from "../src/render/openresume.ts";
import { linkedBulletIds } from "../src/render/verify-rules.ts";
import { checkClaims, checkSkill, checkSummary, verifyRecord } from "../src/render/verify.ts";
import { ats, synonymsAudit, verifyEval } from "../src/tools.ts";
import { saveBank } from "../src/profile/bank.ts";
import { writeRecord } from "../src/tailor/records.ts";
import { createJobRepository } from "../src/jobs/repository.ts";

// Verifier (plan-exit-gate.md K1, tests K5 cases 6-7): the model lists claims with quotes and
// code decides; any model failure is verify_not_run; answers are cached; renderRecord adds the
// "verifier" check only with JOBOPS_VERIFY=on. Fake bank, fake record, a fake model server.

process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";
const tempDir = () => mkdtempSync(join(tmpdir(), "jobops-verify-"));
process.env.JOBOPS_PROFILE_DIR = tempDir();
process.env.JOBOPS_MODEL_LOG = join(process.env.JOBOPS_PROFILE_DIR, "model-calls.jsonl");

const hasTools = ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error) && !spawnSync("pdfinfo", ["-v"]).error;
const skip = !hasTools && "typst, pdftotext, or pdfinfo missing";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// A fake OpenAI-compatible server: answer(prompt) gives the JSON answer (or a raw string).
async function fakeModel(answer: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages[0].content;
      prompts.push(prompt);
      const a = answer(prompt);
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ choices: [{ message: { content: typeof a === "string" ? a : JSON.stringify(a) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, prompts, close: () => server.close() };
}

// A port with nothing listening on it.
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}/v1`;
}

const newDb = () => openDb(join(tempDir(), "t.db"));
const codes = (issues: Issue[]) => issues.map((i) => i.code);
const claims = (...pairs: [string, string][]) => ({ claims: pairs.map(([claim, quote]) => ({ claim, quote })) });
const VOCAB = new Set(["kubernetes", "kustomize", "typescript"]);

// (a) claims
const KUSTOMIZE = "applies the manifests with Kustomize and waits for the rollout";

test("6. claims: a quote that is in the source passes", async () => {
  const m = await fakeModel(() => claims(["applies manifests with Kustomize", "applies the manifests with Kustomize"], ["waits for rollout", "waits for the rollout"]));
  try {
    assert.deepEqual(await checkClaims(newDb(), "b-1", "Applies the manifests with Kustomize and waits for the rollout", KUSTOMIZE, VOCAB, m.url), []);
  } finally { m.close(); }
});

test("6. claims: a quote that is not in the source is claim_unsupported (detail: the bullet id)", async () => {
  const m = await fakeModel(() => claims(["owns the release", "owns every production release end to end"]));
  try {
    const issues = await checkClaims(newDb(), "b-1", "Owns every production release end to end", KUSTOMIZE, VOCAB, m.url);
    assert.deepEqual(issues.map((i) => [i.code, i.extractor, i.detail]), [["claim_unsupported", "verifier", "b-1"]]);
  } finally { m.close(); }
});

test("6. claims: a number in the text that no quote has is claim_unsupported", async () => {
  const source = "Moved 20 services to Kubernetes, cutting deploy time 40%";
  const m = await fakeModel(() => claims(["moved 25 services", "Moved 20 services to Kubernetes"], ["cut deploy time", "cutting deploy time 40%"]));
  try {
    assert.deepEqual(codes(await checkClaims(newDb(), "acme-1", "Moved 25 services to Kubernetes, cutting deploy time 40%", source, VOCAB, m.url)), ["claim_unsupported"]);
  } finally { m.close(); }
});

test("6. claims: a vocabulary term no quote has is claim_unsupported (the control-plane rewording)", async () => {
  // Every quote is real; "Kubernetes" comes from none of them.
  const m = await fakeModel(() => claims(["applies manifests with Kustomize", "applies the manifests with Kustomize"], ["for Kubernetes control plane", "waits for the rollout"]));
  try {
    const text = "Applies the manifests with Kustomize and waits for the rollout for Kubernetes control plane";
    assert.deepEqual(codes(await checkClaims(newDb(), "kubectl-go-cli", text, KUSTOMIZE, VOCAB, m.url)), ["claim_unsupported"]);
  } finally { m.close(); }
});

// (b) fail closed
const reworded = (): ResumeRecord => {
  const r = fakeRecord();
  return { ...r, content: { ...r.content, bullets: r.content.bullets.map((b) => b.id === "acme-1" ? { ...b, text: "Moved 20 services to Kubernetes control plane" } : b) } } as ResumeRecord;
};
const noExtra: SkillsExtra = { skills: [], dismissed: [], learnable: [] };

test("6. verifyRecord: an answer that does not parse is verify_not_run", async () => {
  const m = await fakeModel(() => "this is not json");
  try {
    const issues = await verifyRecord(newDb(), reworded(), fakeBank, noExtra, { baseUrl: m.url });
    assert.deepEqual(issues.map((i) => [i.code, i.extractor, i.detail]), [["verify_not_run", "verifier", "claims"]]);
  } finally { m.close(); }
});

test("6. verifyRecord: model down (nothing listening) is verify_not_run", async () => {
  const issues = await verifyRecord(newDb(), reworded(), fakeBank, noExtra, { baseUrl: await deadUrl() });
  assert.deepEqual(codes(issues), ["verify_not_run"]);
});

test("6. verifyRecord: unchanged bullets, bank skills and an empty summary ask nothing", async () => {
  const m = await fakeModel(() => claims());
  try {
    const r = fakeRecord();
    const record = { ...r, content: { ...r.content, summary_text: "" } } as ResumeRecord;
    assert.deepEqual(await verifyRecord(newDb(), record, fakeBank, noExtra, { baseUrl: m.url }), []);
    assert.equal(m.prompts.length, 0);
  } finally { m.close(); }
});

// summary_claims: the summary against every bank bullet (text and evidence).
const withSummary = (summary_text: string): ResumeRecord => {
  const r = fakeRecord();
  return { ...r, content: { ...r.content, summary_text } } as ResumeRecord;
};

test("6. summary: a summary claim backed by a bullet quote passes", async () => {
  const m = await fakeModel(() => claims(["moved services to Kubernetes", "Moved 20 services to Kubernetes"]));
  try {
    assert.deepEqual(await checkSummary(newDb(), withSummary("Backend engineer who moved 20 services to Kubernetes."), fakeBank, noExtra, { baseUrl: m.url }), []);
    assert.match(m.prompts[0], /Built internal reporting dashboards in React/, "every bank bullet is in the source");
  } finally { m.close(); }
});

test("6. summary: a number no bullet has is claim_unsupported (detail summary), also through verifyRecord", async () => {
  const m = await fakeModel(() => claims(["moved services to Kubernetes", "Moved 20 services to Kubernetes"]));
  try {
    const record = withSummary("Backend engineer who moved 50 services to Kubernetes.");
    const issues = await checkSummary(newDb(), record, fakeBank, noExtra, { baseUrl: m.url });
    assert.deepEqual(issues.map((i) => [i.code, i.extractor, i.detail]), [["claim_unsupported", "verifier", "summary"]]);
    assert.deepEqual((await verifyRecord(newDb(), record, fakeBank, noExtra, { baseUrl: m.url })).map((i) => [i.code, i.detail]), [["claim_unsupported", "summary"]]);
  } finally { m.close(); }
});

test("6. summary: model down is verify_not_run (detail summary)", async () => {
  const issues = await verifyRecord(newDb(), withSummary("Backend engineer."), fakeBank, noExtra, { baseUrl: await deadUrl() });
  assert.deepEqual(issues.map((i) => [i.code, i.detail]), [["verify_not_run", "summary"]]);
});

// (c) cache
test("7. cache: the same question and evidence twice is one model call", async () => {
  const m = await fakeModel(() => claims(["applies manifests with Kustomize", "applies the manifests with Kustomize"]));
  try {
    const db = newDb();
    const first = await checkClaims(db, "b-1", "Applies the manifests with Kustomize", KUSTOMIZE, VOCAB, m.url);
    const second = await checkClaims(db, "b-1", "Applies the manifests with Kustomize", KUSTOMIZE, VOCAB, m.url);
    assert.deepEqual([first, second], [[], []]);
    assert.equal(m.prompts.length, 1);
    await checkClaims(db, "b-1", "Applies the manifests with Kustomize quickly", KUSTOMIZE, VOCAB, m.url);
    assert.equal(m.prompts.length, 2, "a changed text asks again");
  } finally { m.close(); }
});

// (d) skills
const EVIDENCE = "answer 2026-11-08: wrote terraform modules for the staging stack";

test("6. skill: supported with a real quote passes; an invented quote is skill_unsupported_model", async () => {
  const good = await fakeModel(() => ({ supported: true, quote: "wrote terraform modules for the staging stack" }));
  const bad = await fakeModel(() => ({ supported: true, quote: "ran terraform for every production account" }));
  try {
    assert.deepEqual(await checkSkill(newDb(), 5, "Terraform", EVIDENCE, good.url), []);
    const issues = await checkSkill(newDb(), 5, "Terraform", EVIDENCE, bad.url);
    assert.deepEqual(issues.map((i) => [i.code, i.extractor, i.detail]), [["skill_unsupported_model", "verifier", "skill#6"]]);
  } finally { good.close(); bad.close(); }
});

test("6. skill: supported false with a real quote is skill_unsupported_model", async () => {
  const m = await fakeModel(() => ({ supported: false, quote: "wrote terraform modules for the staging stack" }));
  try {
    assert.deepEqual(codes(await checkSkill(newDb(), 0, "Terraform", EVIDENCE, m.url)), ["skill_unsupported_model"]);
  } finally { m.close(); }
});

test("6. linkedBulletIds: ids after 'bullet ', unique and in order", () => {
  assert.deepEqual(linkedBulletIds("(used at: X; bullet acme-2) and bullet oldco-1, again bullet acme-2"), ["acme-2", "oldco-1"]);
  assert.deepEqual(linkedBulletIds("no links here"), []);
});

test("6. verifyRecord: a skills-extra skill's evidence includes its linked bullet's text", async () => {
  // The quote is only in the linked bank bullet acme-2, not in the answer itself.
  const m = await fakeModel(() => ({ supported: true, quote: "Built the TypeScript event pipeline" }));
  try {
    const r = fakeRecord();
    const record = { ...r, content: { ...r.content, summary_text: "", skills: [...r.content.skills, "Event pipelines"] } } as ResumeRecord;
    const extra: SkillsExtra = { ...noExtra, skills: [{ name: "event pipelines", status: "have", evidence: "answer 2026-11-08: see bullet acme-2", added_at: "2026-11-08" }] };
    assert.deepEqual(await verifyRecord(newDb(), record, fakeBank, extra, { baseUrl: m.url }), []);
    assert.equal(m.prompts.length, 1);
    assert.match(m.prompts[0], /Built the TypeScript event pipeline for billing/);
  } finally { m.close(); }
});

// (e) render
const readChecks = (dir: string, id: string) =>
  (JSON.parse(readFileSync(join(dir, `${id}.checks.json`), "utf8")) as { checks: { name: string; ran: boolean; ok: boolean; codes: string[] }[] }).checks;
const NAMES = ["bank_gate", "exit_gate", "layout", "pages_fonts", "pdftotext", "pdfjs", "openresume"];

test("6. render: JOBOPS_VERIFY=on without verifyIssues -> verifier ran=false, pdfChecksPassed false", { skip }, async () => {
  const out = tempDir();
  const r = await withEnv({ JOBOPS_VERIFY: "on" }, () => renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra }));
  const checks = readChecks(out, fakeRecord().resume_id);
  assert.deepEqual(checks.map((c) => c.name), ["bank_gate", "exit_gate", "verifier", ...NAMES.slice(2)]);
  assert.deepEqual(checks.find((c) => c.name === "verifier"), { name: "verifier", ran: false, ok: false, codes: [] });
  assert.deepEqual(r.checks, checks);
  assert.equal(pdfChecksPassed(fakeRecord().resume_id, out), false);
});

test("6. render: JOBOPS_VERIFY=on with verifyIssues [] -> verifier ran and ok", { skip }, async () => {
  const out = tempDir();
  const r = await withEnv({ JOBOPS_VERIFY: "on" }, () => renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra, verifyIssues: [] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(readChecks(out, fakeRecord().resume_id).find((c) => c.name === "verifier"), { name: "verifier", ran: true, ok: true, codes: [] });
});

const skipAll = skip || (!openResumeAvailable() && "OpenResume runner not installed (CI)");
test("6. render: with every reader, JOBOPS_VERIFY=on: [] is served, no verifier result is not", { skip: skipAll }, async () => {
  await withEnv({ JOBOPS_VERIFY: "on", JOBOPS_PARSE_READERS: undefined }, async () => {
    const id = fakeRecord().resume_id;
    const out = tempDir();
    await renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra, verifyIssues: [] });
    assert.equal(pdfChecksPassed(id, out), true);
    await renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra });
    assert.equal(pdfChecksPassed(id, out), false);
  });
});

test("6. render: JOBOPS_VERIFY=on with a verifier issue blocks; no PDF; verifier ok=false", async () => {
  const out = tempDir();
  const issue: Issue = { code: "claim_unsupported", extractor: "verifier", detail: "acme-1" };
  const r = await withEnv({ JOBOPS_VERIFY: "on" }, () => renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra, verifyIssues: [issue] }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, [issue]);
  assert.deepEqual(readChecks(out, fakeRecord().resume_id).find((c) => c.name === "verifier"), { name: "verifier", ran: true, ok: false, codes: ["claim_unsupported"] });
  assert.deepEqual(existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".pdf")) : [], []);
});

test("6. render: JOBOPS_VERIFY unset -> 7 checks, no verifier, verifier issues ignored", { skip }, async () => {
  const out = tempDir();
  const issue: Issue = { code: "claim_unsupported", extractor: "verifier", detail: "acme-1" };
  const r = await withEnv({ JOBOPS_VERIFY: undefined }, () => renderRecord(fakeRecord(), fakeBank, { outDir: out, extra: noExtra, verifyIssues: [issue] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(readChecks(out, fakeRecord().resume_id).map((c) => c.name), NAMES);
});

// (f) model config
test("verify task: qwen2.5:7b by default, JOBOPS_VERIFY_MODEL wins; report_normalize ignores it", async () => {
  await withEnv({ JOBOPS_VERIFY_MODEL: undefined }, () => {
    assert.equal(forTask("verify").model, "qwen2.5:7b");
  });
  await withEnv({ JOBOPS_VERIFY_MODEL: "qwen2.5:14b" }, () => {
    assert.equal(forTask("verify").model, "qwen2.5:14b");
    assert.equal(forTask("report_normalize").model, "qwen2.5:7b");
  });
});

// (g) verify eval
function casesFile(cases: unknown[]): string {
  const file = join(tempDir(), "verify-eval.yaml");
  writeFileSync(file, stringify({ cases }));
  return file;
}
// Quotes "Built the billing pipeline": a real quote, so every claims case passes the rules.
const passAll = () => fakeModel(() => claims(["built the billing pipeline", "Built the billing pipeline"]));
const SOURCE = "Built the billing pipeline in TypeScript";

test("verify eval: a known-bad case that passes is a false pass; A4 fails; exit_code 1", async () => {
  const m = await passAll();
  try {
    const r = await verifyEval(newDb(), casesFile([
      { id: "bad-1", kind: "claims", source: SOURCE, text: "Built the billing pipeline", expect: "block" },
      { id: "good-1", kind: "claims", source: SOURCE, text: "Built the billing pipeline", expect: "pass" }
    ]), { baseUrl: m.url });
    assert.deepEqual(r.cases.map((c) => [c.id, c.expect, c.got]), [["bad-1", "block", "pass"], ["good-1", "pass", "pass"]]);
    assert.deepEqual(r.false_passes, ["bad-1"]);
    assert.deepEqual(r.false_blocks, []);
    assert.equal(r.a4.holds, false);
    assert.equal(r.exit_code, 1);
  } finally { m.close(); }
});

test("verify eval: no false passes and all good cases passed -> A4 holds; exit_code 0", async () => {
  const m = await passAll();
  try {
    const r = await verifyEval(newDb(), casesFile([
      { id: "bad-number", kind: "claims", source: SOURCE, text: "Built the billing pipeline for 30 teams", expect: "block" },
      { id: "good-1", kind: "claims", source: SOURCE, text: "Built the billing pipeline", expect: "pass" }
    ]), { baseUrl: m.url });
    assert.deepEqual(r.cases.map((c) => c.got), ["block", "pass"]);
    assert.deepEqual([r.a4.holds, r.exit_code, r.a4.good_pct], [true, 0, 100]);
  } finally { m.close(); }
});

test("verify eval: a summary case uses its own source; a number not in it blocks", async () => {
  const m = await passAll();
  try {
    const r = await verifyEval(newDb(), casesFile([
      { id: "sum-good", kind: "summary", source: SOURCE, text: "Built the billing pipeline", expect: "pass" },
      { id: "sum-bad", kind: "summary", source: SOURCE, text: "Built the billing pipeline for 12 teams", expect: "block" }
    ]), { baseUrl: m.url });
    assert.deepEqual(r.cases.map((c) => [c.id, c.got, c.codes]), [["sum-good", "pass", []], ["sum-bad", "block", ["claim_unsupported"]]]);
    assert.equal(r.exit_code, 0);
  } finally { m.close(); }
});

test("verify eval: model down -> model_down, an error, exit_code 1", async () => {
  const r = await verifyEval(newDb(), casesFile([
    { id: "good-1", kind: "skill", evidence: EVIDENCE, skill: "Terraform", expect: "pass" }
  ]), { baseUrl: await deadUrl() });
  assert.equal(r.model_down, true);
  assert.match(String(r.error), /not running/);
  assert.equal(r.exit_code, 1);
});

test("verify eval: a missing cases file is an error naming the file", async () => {
  await assert.rejects(verifyEval(newDb(), join(tempDir(), "none.yaml")), /no calibration set at/);
});

// synonyms audit (read-only): not "same" first; no synonym file changes.
test("synonyms audit: pairs not 'same' come first; the synonym file is unchanged", async () => {
  const config = join(import.meta.dirname, "..", "config", "synonyms.yaml");
  const before = readFileSync(config, "utf8");
  const m = await fakeModel((p) => /"eks"/.test(p) ? { kind: "related", reason: "a managed Kubernetes service" } : { kind: "same", reason: "a spelling" });
  try {
    const r = await synonymsAudit(newDb(), { baseUrl: m.url });
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.deepEqual(r.pairs[0], { alias: "eks", term: "kubernetes", kind: "related", reason: "a managed Kubernetes service" });
    assert.equal("not_same" in r && r.not_same, 1);
    assert.ok(r.pairs.slice(1).every((p) => p.kind === "same"));
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(existsSync(join(process.env.JOBOPS_PROFILE_DIR!, "synonyms.yaml")), false);
  } finally { m.close(); }
});

// ats check <id> goes through the verifier like render (JOBOPS_VERIFY=on); fake bank and record.
test("ats check <id>: with JOBOPS_VERIFY=on a verifier issue blocks and the verifier check is in checks.json", async () => {
  // The verify task's server comes from LLM_GENERAL7_URL; the fake model quotes words not in the source.
  const m = await fakeModel(() => claims(["runs the control plane", "runs the Kubernetes control plane"]));
  const dir = tempDir();
  try {
    await withEnv({ JOBOPS_VERIFY: "on", JOBOPS_PROFILE_DIR: dir, LLM_GENERAL7_URL: m.url, JOBOPS_VERIFY_MODEL: undefined }, async () => {
      saveBank(fakeBank);
      const db = newDb();
      const { job } = createJobRepository(db).upsert({ title: "Backend Engineer", company: "Fakecorp", description: "Run backend services.", source_url: "https://example.com/jobs/fakecorp", required_skills: [], preferred_skills: [] });
      const content = fakeRecord().content;
      const { record } = writeRecord(db, fakeBank, {
        jd_id: job.id, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
        flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
        content: { ...content, bullets: content.bullets.map((b) => ({ ...b, text: b.id === "acme-1" ? "Moved 20 services to the Kubernetes control plane" : b.text, reword: null })) }
      });
      const r = await ats(db, { resumeId: record.resume_id });
      assert.equal(r.ok, false);
      assert.ok(r.issues.some((i) => i.code === "claim_unsupported" && i.detail === "acme-1"), JSON.stringify(r.issues));
      assert.equal(r.pdf, null);
      const verifier = readChecks(join(dir, "pdf"), record.resume_id).find((c) => c.name === "verifier");
      assert.equal(verifier?.ran, true);
      assert.equal(verifier?.ok, false);
      assert.ok(verifier?.codes.includes("claim_unsupported"));
    });
  } finally { m.close(); }
});
