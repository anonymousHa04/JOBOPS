import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { Bank, SkillsExtra } from "../src/profile/schema.ts";
import type { Requirements } from "../src/requirements/schema.ts";
import { decide } from "../src/tailor/decide.ts";
import type { StoredRecord } from "../src/tailor/decide.ts";
import { equivalence } from "../src/tailor/equivalence.ts";
import { idealContent, metricLed } from "../src/tailor/ideal.ts";
import type { ResumeContent } from "../src/tailor/ideal.ts";
import { contentHash, loadRecords, originalContent, recordsDir, writeRecord } from "../src/tailor/records.ts";
import type { NewRecord } from "../src/tailor/records.ts";
import { checkFixedFields, checkRewrite, guardedReword } from "../src/tailor/guard.ts";
import { rewordContent } from "../src/tailor/reword.ts";
import { dryRunAll, tailorJob } from "../src/tailor/tailor.ts";
import { spawnSync } from "node:child_process";
import { checkText, pdftotext } from "../src/render/parseback.ts";
import { renderRecord, resumeData } from "../src/render/render.ts";
import { lintRecord, tenure } from "../src/tailor/lint.ts";
import { norm } from "../src/scoring/terms.ts";
import type { ResumeRecord } from "../src/profile/schema.ts";
import { dedupeSkills, loadBank, regroupSkills, retagBank, saveBank } from "../src/profile/bank.ts";

// Engine tests from the m3-notes skill (engine-algorithm.md §8), on a fake resume only.
// Never the real profile: its overrides (profile/synonyms.yaml, ...) must not change results.
process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-test-"));

const bullet = (id: string, text: string, tags: string[], impact: "high" | "medium" | "low" = "medium") =>
  ({ id, text, short: text.split(" ").slice(0, 5).join(" "), tags, impact, source: "resume" as const });

const bank: Bank = {
  basics: { name: "Test Person", email: "test@example.com", phone: "0", location: "Bangalore", links: [] },
  summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
  roles: [
    {
      id: "cur", title: "Senior Engineer", company: "Acme", location: "Bangalore", dates: "Jan 2018 - Present",
      bullets: [
        bullet("cur-1", "40% faster deploys after moving services to Kubernetes", ["kubernetes", "deploys", "backend", "cloud", "performance"], "high"),
        bullet("cur-2", "3x throughput on the TypeScript event pipeline", ["typescript", "events", "backend", "pipeline", "performance"], "high"),
        bullet("cur-3", "25 services migrated to a shared deploy template", ["deploys", "templates", "backend", "platform", "migration"], "medium"),
        bullet("cur-4", "Mentored three engineers through design reviews", ["mentoring", "design", "people", "reviews", "team"], "medium"),
        bullet("cur-5", "Wrote the on-call runbook for the API", ["oncall", "docs", "api", "reliability", "operations"], "low")
      ]
    },
    {
      id: "old", title: "Engineer", company: "OldCo", location: "Pune", dates: "2014 - 2017",
      bullets: [
        bullet("old-1", "Built internal reporting dashboards", ["reporting", "dashboards", "frontend", "internal", "data"], "low")
      ]
    }
  ],
  projects: [],
  education: [],
  skills: { languages: ["typescript", "go"], frameworks: [], tools: ["kubernetes", "docker"], domains: [] },
  approved: true
};
const extra: SkillsExtra = { skills: [], dismissed: [], learnable: [] };
const budget = { bullets_per_role: 4, bullets_total: 5, max_words: 25 };
const req: Requirements = {
  role: "Senior Backend Engineer", seniority: "senior",
  must_have: ["Kubernetes", "TypeScript", "5+ years of experience"],
  nice_to_have: ["Go"], keywords: ["Kubernetes", "TypeScript"], themes: ["mentoring"], summary_variant: "backend"
};

const record = (id: string, content: ResumeContent): StoredRecord => ({ resume_id: id, content });

test("1. identical ideal set -> reuse at 100%", () => {
  const ideal = idealContent(req, bank, extra, budget);
  const d = decide(ideal, record("r1", structuredClone(ideal)), req, bank, extra, []);
  assert.equal(d.equivalence, 100);
  assert.equal(d.decision, "reuse");
});

test("2. one swapped bullet -> adapt, at the formula's value", () => {
  const ideal = idealContent(req, bank, extra, budget);
  const start = structuredClone(ideal);
  start.bullets[start.bullets.length - 1] = { id: "zzz-9", entry_id: "cur", text: "Something else", reword: null };
  const n = ideal.bullets.length;
  // (n - 1 shared bullets + summary + skills) / (union n + 1, + 2)
  const expected = Math.round((100 * (n - 1 + 1 + 1) / (n + 1 + 2)) * 10) / 10;
  const d = decide(ideal, record("r1", start), req, bank, extra, []);
  assert.equal(d.equivalence, expected);
  assert.equal(d.decision, "adapt");
});

test("3. years gate fails -> not_tailored", () => {
  const strict = { ...req, must_have: ["Kubernetes", "TypeScript", "12+ years of experience"] };
  const ideal = idealContent(strict, bank, extra, budget);
  const d = decide(ideal, null, strict, bank, extra, []);
  assert.equal(d.decision, "not_tailored");
  assert.match(d.reason, /^years/);
});

test("4. unsupported must-have is flagged on reuse", () => {
  // Four supported must-haves keep the resume tailorable (moderate or better) even with
  // one unsupported must-have; the flag must still travel with the reuse decision.
  const withRust = { ...req, must_have: ["Kubernetes", "TypeScript", "deploys", "pipeline", "Rust"], nice_to_have: [] };
  const ideal = idealContent(withRust, bank, extra, budget);
  const d = decide(ideal, record("r1", structuredClone(ideal)), withRust, bank, extra, []);
  assert.notEqual(d.band, "poor");
  assert.equal(d.decision, "reuse");
  assert.deepEqual(d.flags.unsupported_must_haves, ["Rust"]);
});

test("invariant: same inputs give the same ideal set", () => {
  const a = idealContent(req, bank, extra, budget);
  const b = idealContent(req, bank, extra, budget);
  assert.deepEqual(a, b);
});

test("ideal set keeps the budgets, one bullet per role, and at most 2 metric-led per role", () => {
  const ideal = idealContent(req, bank, extra, budget);
  assert.ok(ideal.bullets.length <= budget.bullets_total);
  for (const role of bank.roles) {
    const mine = ideal.bullets.filter((b) => b.entry_id === role.id);
    assert.ok(mine.length >= 1, `role ${role.id} has a bullet`);
    assert.ok(mine.length <= budget.bullets_per_role);
    assert.ok(mine.filter((b) => metricLed(b.text)).length <= 2, `role ${role.id} metric-led`);
  }
  // Must-have evidence comes first in the current role.
  assert.deepEqual(ideal.bullets.slice(0, 2).map((b) => b.id).sort(), ["cur-1", "cur-2"]);
});

test("equivalence: alias-only rewording counts 0.9, a reworded bullet 0.5", () => {
  const ideal = idealContent(req, bank, extra, budget);
  const n = ideal.bullets.length;
  const alias = structuredClone(ideal);
  alias.bullets[0].reword = { alias_only: true, keywords: ["Kubernetes"] };
  assert.equal(equivalence(alias, ideal).value, Math.round((100 * (n - 1 + 0.9 + 2) / (n + 2)) * 10) / 10);
  const reworded = structuredClone(ideal);
  reworded.bullets[0].text = "Different wording";
  assert.equal(equivalence(reworded, ideal).value, Math.round((100 * (n - 1 + 0.5 + 2) / (n + 2)) * 10) / 10);
});

// Records (engine-algorithm.md §7): YAML is the truth, SQLite the index, hashes catch drift.
const newRecord = (content: ResumeContent, decision: NewRecord["decision"] = "adapt"): NewRecord => ({
  jd_id: decision === "original" ? "original" : "job-1", source_resume_id: null, decision, reason: "test",
  band: null, score: null, equivalence: null, flags: { unsupported_must_haves: [], risks: [] },
  review_findings: [], changes: [], evidence_refs: [], content
});
const tempProfile = () => { process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-rec-")); };

test("records: content hash ignores reword marks and key order, changes with the text", () => {
  const ideal = idealContent(req, bank, extra, budget);
  const marked = structuredClone(ideal);
  marked.bullets[0].reword = { alias_only: false, keywords: ["Kubernetes"] };
  assert.equal(contentHash(marked), contentHash(ideal));
  const reordered = { skills: ideal.skills, bullets: ideal.bullets, summary_text: ideal.summary_text, summary_variant: ideal.summary_variant };
  assert.equal(contentHash(reordered), contentHash(ideal));
  const edited = structuredClone(ideal);
  edited.bullets[0].text += " today";
  assert.notEqual(contentHash(edited), contentHash(ideal));
});

test("records: written once, never overwritten, and the index rebuilds from YAML", () => {
  tempProfile();
  const db = openDb(":memory:");
  const orig = writeRecord(db, bank, newRecord(originalContent(bank), "original"));
  assert.equal(orig.record.resume_id, "original");
  const ideal = idealContent(req, bank, extra, budget);
  const first = writeRecord(db, bank, newRecord(ideal));
  assert.ok(first.created);
  const before = readFileSync(first.path, "utf8");
  const again = writeRecord(db, bank, { ...newRecord(ideal), reason: "different" });
  assert.equal(again.created, false);
  assert.equal(readFileSync(first.path, "utf8"), before);
  db.exec("DELETE FROM resume_records");
  const { records, checks } = loadRecords(db, bank);
  assert.deepEqual(records.map((r) => r.resume_id).sort(), [first.record.resume_id, "original"].sort());
  assert.ok(checks.every((c) => !c.edited && !c.stale_bank && !c.stale_engine));
  const row = db.prepare("SELECT content_hash FROM resume_records WHERE resume_id = ?").get(first.record.resume_id) as { content_hash: string };
  assert.equal(row.content_hash, contentHash(ideal));
});

test("records: a hand-edited record and a changed bank are detected", () => {
  tempProfile();
  const db = openDb(":memory:");
  const { path } = writeRecord(db, bank, newRecord(idealContent(req, bank, extra, budget)));
  writeFileSync(path, readFileSync(path, "utf8").replace("Backend engineer.", "Backend engineer!"));
  assert.ok(loadRecords(db, bank).checks[0].edited);
  assert.equal(loadRecords(db, bank).records.length, 0);
  tempProfile();
  writeRecord(db, bank, newRecord(idealContent(req, bank, extra, budget)));
  const changed = structuredClone(bank);
  changed.roles[0].bullets[0].text += " in production";
  const c = loadRecords(db, changed).checks[0];
  assert.ok(!c.edited && c.stale_bank && !c.stale_engine);
});

// Rewrite guard (engine-algorithm.md §6).
const guardOpts = { vocab: new Set(["kubernetes", "typescript", "go", "docker", "rust"]), allowed: ["Kubernetes"], maxWords: 25 };
const src = "Built the deploy pipeline on k8s, cutting deploys by 40%";

test("guard: each rule fires on its own", () => {
  assert.deepEqual(checkRewrite(src, "Built the Kubernetes deploy pipeline, cutting deploys by 40%", guardOpts), []);
  const cases: [string, string][] = [
    ["Built the deploy pipeline on k8s, cutting deploys by 45%", "number_added"],
    ["Built the deploy pipeline on k8s and Rust, cutting deploys by 40%", "term_added"],
    ["Led the deploy pipeline on k8s, cutting deploys by 40%", "scope_raised"],
    ["Built the end-to-end deploy pipeline on k8s, cutting deploys by 40%", "scope_phrase_added"],
    [`Built the deploy pipeline on k8s, cutting deploys by 40%${" again".repeat(20)}`, "too_long"],
    ["40% faster deploys from the pipeline built on k8s", "number_led"]
  ];
  for (const [rewrite, code] of cases) assert.deepEqual(checkRewrite(src, rewrite, guardOpts), [code], code);
});

test("guard: retry once with the codes, then fall back to the bank text", async () => {
  const seen: string[][] = [];
  const bad = await guardedReword(src, guardOpts, async (codes) => { seen.push(codes); return "Led the pipeline, 90% faster"; });
  assert.equal(bad.outcome, "fallback");
  assert.equal(bad.text, src);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], []);
  assert.ok(seen[1].includes("scope_raised"));
  let n = 0;
  const ok = await guardedReword(src, guardOpts, async () => (n++ === 0 ? null : "Built the Kubernetes deploy pipeline, cutting deploys by 40%"));
  assert.equal(ok.outcome, "accepted_on_retry");
});

test("guard: titles, employers, and dates must byte-match the bank", () => {
  const shown = bank.roles.map((r) => ({ entry_id: r.id, title: r.title, company: r.company, dates: r.dates }));
  assert.deepEqual(checkFixedFields(bank, shown), []);
  shown[0].title = "Staff Engineer";
  shown[1].dates = "2014 – 2017";
  assert.deepEqual(checkFixedFields(bank, shown).map((f) => `${f.entry_id}.${f.field}`), ["cur.title", "old.dates"]);
});

// Rewording (engine-algorithm.md §6) against a fake model server: answers are scripted,
// so the test checks the wiring and the guard, not the model.
async function fakeModel(answers: string[]): Promise<{ url: string; prompts: string[]; close: () => void }> {
  const prompts: string[] = [];
  const server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      prompts.push((JSON.parse(body) as { messages: { content: string }[] }).messages[0].content);
      const text = answers[Math.min(prompts.length - 1, answers.length - 1)];
      const out = { summary_variant: "backend", include: [{ id: "cur-1", text }], uncovered_requirements: [], notes: "" };
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, prompts, close: () => server.close() };
}

// One bullet marked for rewording: it supports Kubernetes but says "k8s".
const k8sBank = structuredClone(bank);
k8sBank.roles[0].bullets[0].text = "Cut deploy time 40% by moving services to k8s";
const marked = (): ResumeContent => {
  const c = idealContent(req, k8sBank, extra, budget);
  assert.ok(c.bullets.find((b) => b.id === "cur-1")?.reword, "cur-1 is marked");
  return c;
};
process.env.JOBOPS_PROMPTS_DIR ??= join(import.meta.dirname, "..", "..", "requierements");

test("reword: only marked bullets go to the model; an accepted rewrite is a change", async () => {
  const m = await fakeModel(["Cut deploy time 40% by moving services to Kubernetes"]);
  try {
    const r = await rewordContent(marked(), req, k8sBank, extra, budget, { baseUrl: m.url });
    assert.equal(m.prompts.length, 1);
    assert.match(m.prompts[0], /cur-1 \| Cut deploy time 40% by moving services to k8s/);
    assert.equal(r.content.bullets.find((b) => b.id === "cur-1")?.text, "Cut deploy time 40% by moving services to Kubernetes");
    assert.deepEqual(r.changes.map((c) => c.bullet_id), ["cur-1"]);
    assert.ok(r.content.bullets.every((b) => b.reword === null));
    assert.deepEqual(r.log, [{ bullet_id: "cur-1", outcome: "accepted", codes: [[]] }]);
  } finally { m.close(); }
});

test("reword: a rejected rewrite is retried with its codes, then the bank text stays", async () => {
  const m = await fakeModel(["Led the move to Kubernetes, cutting deploy time 60%"]);
  try {
    const r = await rewordContent(marked(), req, k8sBank, extra, budget, { baseUrl: m.url });
    assert.equal(m.prompts.length, 2);
    assert.match(m.prompts[1], /rejected for: number_added, scope_raised/);
    assert.equal(r.content.bullets.find((b) => b.id === "cur-1")?.text, k8sBank.roles[0].bullets[0].text);
    assert.equal(r.log[0].outcome, "fallback");
  } finally { m.close(); }
});

test("reword: with the model server down, nothing changes and the error is reported", async () => {
  const r = await rewordContent(marked(), req, k8sBank, extra, budget, { baseUrl: "http://127.0.0.1:9/v1" });
  assert.deepEqual(r.changes, []);
  assert.match(r.error ?? "", /unavailable/);
  assert.equal(r.log[0].outcome, "skipped");
});

// tailor (engine-algorithm.md §4): one JD end to end, and the dry run.
const ready = { ...extra, dismissed: ["impact:old-1"] }; // risks the user already answered

test("tailor --all --dry-run: decisions and questions, no model calls, no files", () => {
  tempProfile();
  const out = dryRunAll([{ job_id: "job-1", company: "Acme", title: "SBE", req, verdicts: new Map() }], [], k8sBank, extra, budget);
  assert.equal(out.rows[0].decision, "adapt");
  assert.equal(out.rows[0].start, "original");
  assert.equal(out.rows[0].to_reword, 1);
  assert.ok(out.rows[0].blocked);
  assert.deepEqual(out.questions.map((q) => q.id), ["impact:old-1"]);
  assert.equal(existsSync(recordsDir()), false);
});

test("tailor: open risks block an adapt; nothing is written", async () => {
  tempProfile();
  const db = openDb(":memory:");
  const r = await tailorJob(db, req, "job-1", [], k8sBank, extra, budget, new Map(), { baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(r.decision, "blocked");
  assert.deepEqual(r.questions.map((q) => q.id), ["impact:old-1"]);
  assert.equal(existsSync(recordsDir()), false);
});

test("tailor: adapt rewords and writes the record; the same JD again is a reuse", async () => {
  tempProfile();
  const db = openDb(":memory:");
  const m = await fakeModel(["Cut deploy time 40% by moving services to Kubernetes"]);
  try {
    const first = await tailorJob(db, req, "job-1", [], k8sBank, ready, budget, new Map(), { baseUrl: m.url });
    assert.equal(first.decision, "adapt");
    assert.ok(first.created);
    assert.deepEqual(readdirSync(recordsDir()).sort(), ["original.yaml", `${first.resume_id}.yaml`].sort());
    const rec = loadRecords(db, k8sBank).records.find((x) => x.resume_id === first.resume_id);
    assert.deepEqual(rec?.changes.map((c) => c.bullet_id), ["cur-1"]);
    assert.ok(rec?.evidence_refs.some((e) => e.requirement === "Kubernetes"));

    const again = await tailorJob(db, req, "job-1", loadRecords(db, k8sBank).records, k8sBank, ready, budget, new Map(), { baseUrl: m.url });
    assert.equal(again.decision, "reuse");
    assert.equal(again.start, first.resume_id);
    assert.equal(again.created, false);
    assert.equal(m.prompts.length, 1); // reuse calls no model
  } finally { m.close(); }
});

test("tailor: a failed years gate writes a not_tailored record, with no model calls", async () => {
  tempProfile();
  const db = openDb(":memory:");
  const strict = { ...req, must_have: ["Kubernetes", "TypeScript", "12+ years of experience"] };
  const r = await tailorJob(db, strict, "job-2", [], k8sBank, ready, budget, new Map(), { baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(r.decision, "not_tailored");
  assert.deepEqual(r.reworded, []);
  assert.equal(loadRecords(db, k8sBank).records.find((x) => x.jd_id === "job-2")?.decision, "not_tailored");
});

// Template + parse-back (engine-algorithm.md §7): every generated PDF is read back by two
// extractors and must hold the record exactly. Needs typst and poppler (pdftotext).
const hasTools = ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error);
const fullBank = structuredClone(bank);
fullBank.basics = { name: "Test Person", email: "test.person@example.com", phone: "+91 90000 00000", location: "Bangalore, India",
  links: ["https://github.com/testperson", "linkedin.com/in/test-person-with-a-long-profile-name"] };
fullBank.education = [{ id: "edu-1", degree: "B.Tech, Computer Science", school: "Example Institute of Technology", dates: "2010 - 2014", details: [] }];
const sampleRecord = () => {
  tempProfile();
  const db = openDb(":memory:");
  return writeRecord(db, fullBank, newRecord(idealContent(req, fullBank, extra, budget))).record;
};

test("render: a record becomes a PDF that both extractors read back exactly", { skip: !hasTools && "typst or pdftotext missing" }, async () => {
  const record = sampleRecord();
  const r = await renderRecord(record, fullBank);
  assert.deepEqual(r.issues, []);
  assert.ok(r.ok && r.path && existsSync(r.path));
  const text = pdftotext(r.path);
  assert.match(text, /linkedin\.com\/in\/test-person-with-a-long-profile-name/); // whole, one line
  assert.match(text, /\+91 90000 00000/);
});

test("parse-back: broken bullets, wrapped links, missing fields, and icon glyphs are caught", () => {
  const data = resumeData(sampleRecord(), fullBank);
  const good = [data.name, data.phone, data.location, data.email, ...data.links.map((l) => l.text), "Summary", data.summary, "Experience",
    ...data.experience.flatMap((e) => [e.title, e.dates, e.company, e.location, ...e.bullets]),
    "Education", ...data.education.flatMap((e) => [e.school, e.dates, e.degree]), "Skills", data.skills.join(", ")].join("\n");
  assert.deepEqual(checkText(good, data, "t"), []);
  const first = data.experience[0].bullets[0];
  const codes = (text: string) => checkText(text, data, "t").map((i) => i.code);
  assert.ok(codes(good.replace(first, first.slice(0, 20) + "\n\n\nzzz " + first.slice(20))).includes("bullet_broken"));
  assert.ok(codes(good.replace("linkedin.com/in/", "linkedin.com/in/\n")).includes("link_wrapped"));
  assert.ok(codes(good.replace(data.experience[0].dates, "")).includes("field_missing"));
  assert.ok(codes(good + "\uf0e0").includes("icon_glyphs"));
});

// Lint, tenure/gaps, same company (gaps-and-rejection-risks.md §2-3, engine-algorithm.md §4 step 8).
const lintCodes = (r: ResumeRecord, b = fullBank) => lintRecord(r, b, extra, { now: new Date("2026-10-27") }).map((f) => f.code);

test("lint: each check reports its problem; lint never changes the record", () => {
  const base = sampleRecord();
  const clean = lintCodes(base);
  assert.ok(clean.includes("check_linkedin")); // always: a manual check
  for (const c of ["planned_work", "possible_typo", "metric_led_over_2", "link_not_url", "same_opening_verb"]) assert.ok(!clean.includes(c), c);
  const r = structuredClone(base);
  r.content.bullets[0].text = "Will migrate 40 services to Kubernates next quarter";
  r.content.bullets.forEach((b, i) => { if (i < 3 && b.entry_id === "cur") b.text = `${10 + i}% faster ${b.text}`; });
  const linkBank = structuredClone(fullBank);
  linkBank.basics.links = ["LinkedIn"];
  const before = structuredClone(r);
  const codes = lintCodes(r, linkBank);
  for (const c of ["planned_work", "possible_typo", "metric_led_over_2", "link_not_url"]) assert.ok(codes.includes(c), c);
  assert.deepEqual(r, before);
});

test("tenure: short roles, gaps over 6 months, and mixed date formats; a year-only end is not a gap", () => {
  assert.deepEqual(tenure(fullBank, new Date("2026-10-27")).map((f) => f.code), ["mixed_date_formats"]); // "Jan 2018" vs "2014"
  const b = structuredClone(fullBank);
  b.roles[0].dates = "Mar 2026 - Present";
  b.roles[1].dates = "Jan 2014 - Jun 2025";
  assert.deepEqual(tenure(b, new Date("2026-10-27")).map((f) => f.code).sort(), ["gap", "short_tenure"]);
});

test("same company: start from that company's record, and warn above 3 applications", async () => {
  tempProfile();
  const db = openDb(":memory:");
  const m = await fakeModel(["Cut deploy time 40% by moving services to Kubernetes"]);
  const companyOf = (id: string) => (id.startsWith("acme") ? "Acme" : "Other");
  try {
    const go = (id: string) => tailorJob(db, req, id, loadRecords(db, k8sBank).records, k8sBank, ready, budget, new Map(),
      { baseUrl: m.url, companies: { company: companyOf(id), companyOf } });
    const first = await go("acme-1");
    assert.equal(first.decision, "adapt");
    const second = await go("acme-2");
    assert.equal(second.start, first.resume_id); // one version across roles
    assert.equal(second.decision, "reuse");
    await go("acme-3");
    const fourth = await go("acme-4");
    assert.ok(fourth.lint.some((f) => f.code === "same_company_applications"));
    assert.ok(!(await go("other-1")).lint.some((f) => f.code.startsWith("same_company")));
  } finally { m.close(); }
});

test("bank retag: keeps only tags the bullet names, never changes text", async () => {
  tempProfile();
  const b = structuredClone(bank);
  b.approved = false;
  b.roles[1].bullets[0].tags = ["reporting", "dashboards"]; // "Built internal reporting dashboards"
  saveBank(b);
  const server = createServer((rq, rs) => {
    rq.resume();
    rq.on("end", () => rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tags: ["internal", "kubernetes", "reporting dashboards"] }) } }] })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await retagBank({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    const after = loadBank()!.roles[1].bullets[0];
    assert.deepEqual(after.tags, ["reporting", "dashboards", "internal", "reporting dashboards"]); // no "kubernetes"
    assert.equal(after.text, "Built internal reporting dashboards");
    assert.deepEqual(r.retagged, [{ id: "old-1", before: 2, after: 4 }]);
    assert.ok(r.still_short.includes("old-1"));
  } finally { server.close(); }
});

test("bank: repeated skills are removed, in a group and across groups, first spelling kept", () => {
  const b = structuredClone(bank);
  b.skills = { languages: ["Go", "TypeScript", "go", "Go", "Python"], frameworks: ["React"], tools: ["Docker", "typescript", "react"], domains: ["Docker"] };
  assert.equal(dedupeSkills(b), 5);
  assert.deepEqual(b.skills, { languages: ["Go", "TypeScript", "Python"], frameworks: ["React"], tools: ["Docker"], domains: [] });
});

test("bank: known frameworks leave languages, known languages leave frameworks", () => {
  const b = structuredClone(bank);
  b.skills = { languages: ["TypeScript", "React", "Node.js", "Go"], frameworks: ["Express", "Python"], tools: [], domains: [] };
  assert.equal(regroupSkills(b), 3);
  assert.deepEqual(b.skills.languages, ["TypeScript", "Go", "Python"]);
  assert.deepEqual(b.skills.frameworks, ["React", "Node.js", "Express"]);
});

test("lists: your profile files add synonyms and pin skill groups, over the defaults", () => {
  tempProfile();
  const dir = process.env.JOBOPS_PROFILE_DIR!;
  const b = structuredClone(bank);
  b.skills = { languages: ["Node.js", "Go"], frameworks: [], tools: [], domains: [] };
  assert.equal(regroupSkills(structuredClone(b)), 1); // default: Node.js is a framework
  writeFileSync(join(dir, "skill-groups.yaml"), "languages: [node.js]\n");
  assert.equal(regroupSkills(b), 0); // yours: it stays a language
  assert.equal(norm("hapi"), "hapi");
  writeFileSync(join(dir, "synonyms.yaml"), "hapi: node.js\n");
  assert.equal(norm("hapi"), "node.js");
  writeFileSync(join(dir, "synonyms.yaml"), "hapi: [broken\n");
  assert.throws(() => norm("x"), /synonyms\.yaml/);
});
