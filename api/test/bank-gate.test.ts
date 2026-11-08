import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { bullet } from "./fixtures.ts";
import type { Bank } from "../src/profile/schema.ts";
import type { Db } from "../src/db.ts";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { addBullet, loadBank, loadSkillsExtra, markReviewed, saveBank } from "../src/profile/bank.ts";
import { gateBullet } from "../src/profile/gate.ts";
import { pdfDir, renderRecord } from "../src/render/render.ts";
import { writeRecord } from "../src/tailor/records.ts";
import { idealContent } from "../src/tailor/ideal.ts";
import { scoreRequirements } from "../src/scoring/score.ts";
import type { Requirements } from "../src/requirements/schema.ts";
import { answerGap } from "../src/ui/gaps.ts";
import { parseEvidence } from "../src/ui/gap-memory.ts";
import { reportsDir } from "../src/extension/reports.ts";
import { bankAudit } from "../src/tools.ts";

// CI has no OpenResume copy; production requires all three readers (parseBack reads this per call).
process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";

// Bank gate (plan-atlassian-fix.md T6): the deterministic checks a bullet must pass to be in
// the bank (addBullet, Gaps answers) and to be rendered or served (renderRecord, the PDF route),
// plus the read-only bank audit with the chat's fact flags. Fake person, fake bank: no models.

const ANSWER = "answer 2026-11-07: ";

// Two roles: a current one (MCP is possible) and an older one that ended before MCP existed.
// "core engineering" is a tag, so it is in the bank's vocabulary (term_added needs the term).
function fakeBank(extra: { nova?: Bank["roles"][number]["bullets"]; orbit?: Bank["roles"][number]["bullets"] } = {}): Bank {
  return {
    basics: { name: "Riya Testwal", email: "riya@example.com", phone: "+91 90000 11111", location: "Pune", links: [] },
    summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
    roles: [
      { id: "nova", title: "Platform Engineer", company: "Nimbus Labs", dates: "Mar 2025 - Present",
        bullets: [bullet("nova-1", "Ran the nightly billing export for regional finance teams", ["billing"]), ...(extra.nova ?? [])] },
      { id: "orbit", title: "Software Engineer", company: "Orbitware", dates: "Jan 2021 - Aug 2024",
        bullets: [bullet("orbit-1", "Wrote the Go ingestion worker that parsed vendor invoice files every hour", ["go", "core engineering"]), ...(extra.orbit ?? [])] }
    ],
    projects: [],
    education: [{ id: "edu", degree: "B.E.", school: "Fake Institute", dates: "2016 - 2020", details: [] }],
    skills: { languages: ["go", "typescript"], frameworks: [], tools: ["kubernetes"], domains: [] },
    approved: true
  };
}

// A temp profile dir with the fake bank, an in-memory DB, and one job.
async function setup(b: Bank = fakeBank()) {
  const dir = mkdtempSync(join(tmpdir(), "jobops-gate-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  process.env.JOBOPS_FEEDBACK_LOG = join(dir, "report-feedback.jsonl");
  saveBank(b);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Platform Engineer", company: "Fakecorp", description: "Run agent platforms.", source_url: "https://example.com/jobs/fakecorp" } });
  const id = JSON.parse(res.body).id as string;
  return { app, db, id, dir };
}

function record(db: Db, b: Bank, jobId: string, bulletIds: string[]) {
  const all = [...b.roles, ...b.projects];
  const bullets = bulletIds.map((bid) => {
    const e = all.find((x) => x.bullets.some((y) => y.id === bid))!;
    return { id: bid, entry_id: e.id, text: e.bullets.find((y) => y.id === bid)!.text, reword: null };
  });
  return writeRecord(db, b, {
    jd_id: jobId, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 70, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["go"], bullets }
  }).record;
}

const bankBullets = () => [...loadBank()!.roles, ...loadBank()!.projects].flatMap((e) => e.bullets);

// 1-2: a big number needs a word that says what kind of number it is.
test("gate: an unlabeled scale claim is scale_unlabeled", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Managed one million concurrent agents on the queue", ANSWER + "handled 1000000 agents");
  assert.ok(codes.includes("scale_unlabeled"), codes.join(","));
});

test("gate: a labeled scale claim the story holds passes", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Load-tested 1,000,000 simulated agents on the queue",
    ANSWER + "load tested the queue with 1,000,000 simulated agents");
  assert.deepEqual(codes, []);
});

test("gate: 'at peak' labels a scale claim; the bare number does not", async () => {
  await setup();
  const peak = gateBullet(fakeBank(), "nova", "Served up to 50,000 users at peak on the queue", ANSWER + "served 50,000 users at peak");
  assert.ok(!peak.includes("scale_unlabeled"), peak.join(","));
  const bare = gateBullet(fakeBank(), "nova", "Served up to 50,000 users on the queue", ANSWER + "served 50,000 users");
  assert.ok(bare.includes("scale_unlabeled"), bare.join(","));
});

// 3: a tool named at a role that ended before it was released.
test("gate: MCP at a role that ended before MCP existed is tech_before_release", async () => {
  await setup();
  const story = ANSWER + "built mcp servers for our tools";
  assert.ok(gateBullet(fakeBank(), "orbit", "Built MCP servers for internal tools", story).includes("tech_before_release"));
  assert.ok(!gateBullet(fakeBank(), "nova", "Built MCP servers for internal tools", story).includes("tech_before_release"));
});

// 4: model wording in the bullet, or in the story itself.
test("gate: model wording in the bullet or its story is model_wording", async () => {
  await setup();
  assert.ok(gateBullet(fakeBank(), "nova", "Tagged billing exports per cloud account, indicating multi-cloud usage.",
    ANSWER + "tagged billing exports per cloud account").includes("model_wording"));
  assert.ok(gateBullet(fakeBank(), "nova", "Tagged billing exports per cloud account",
    ANSWER + "tagged billing exports per cloud account, indicating multi-cloud usage").includes("model_wording"));
});

// 5: a story pasted from another bullet.
test("gate: a story holding another bullet's first 8 words is evidence_copied", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Added retries to the invoice parser",
    ANSWER + "wrote the Go ingestion worker that parsed vendor invoice files, then added retries");
  assert.ok(codes.includes("evidence_copied"), codes.join(","));
});

// 6: nearly the same bullet as one at another role.
test("gate: a bullet with >= 60% word overlap with another role's bullet is near_duplicate", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Wrote the Go ingestion worker that parsed vendor invoice files daily",
    ANSWER + "wrote a go ingestion worker that parsed vendor invoice files daily");
  assert.ok(codes.includes("near_duplicate"), codes.join(","));
});

// 7: a bank term the story never names.
test("gate: a vocabulary term the story does not name is term_added", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "orbit", "Applied core engineering principles to decompose complex logic",
    ANSWER + "used sonar qube for code quality, broke complex logic into smaller chunks");
  assert.ok(codes.includes("term_added"), codes.join(","));
});

// 8: the answer date prefix supports no number.
test("gate: a number found only in the answer date prefix is number_unsupported", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Reviewed 11 pull requests a week", ANSWER + "reviewed pull requests every week");
  assert.ok(codes.includes("number_unsupported"), codes.join(","));
});

// 9: every writer needs a story.
test("addBullet: no evidence is refused with blocked: no_evidence", async () => {
  await setup();
  assert.throws(() => addBullet("nova", "Ran the weekly on-call handover", ["on-call"], "medium"), /blocked: no_evidence/);
  assert.throws(() => addBullet("nova", "Ran the weekly on-call handover", ["on-call"], "medium", { evidence: "  " }), /blocked: no_evidence/);
  assert.equal(bankBullets().length, 2);
});

// 10: model sizes, context, minutes, year ranges and names are not scale claims.
test("gate: 8B, 16k, 5m, a year range, k8s and S3 are not scale or unsupported numbers", async () => {
  await setup();
  const cases = [
    "Served an 8B model for ticket triage",
    "Raised the 16k context limit for summaries",
    "Set a 5m timeout on report jobs",
    "Ran the release train 2019 - 2021",
    "Moved batch jobs to k8s",
    "Stored exports in S3"
  ];
  for (const text of cases) {
    const same = gateBullet(fakeBank(), "nova", text, ANSWER + text.toLowerCase());
    assert.ok(!same.includes("number_unsupported"), `${text}: ${same.join(",")}`);
    assert.ok(!same.includes("scale_unlabeled"), `${text}: ${same.join(",")}`);
    const none = gateBullet(fakeBank(), "nova", text, ANSWER + "did this work at my job");
    assert.ok(!none.includes("scale_unlabeled"), `${text} (story without it): ${none.join(",")}`);
    const original = gateBullet(fakeBank(), "nova", text, undefined);
    assert.ok(!original.includes("number_unsupported") && !original.includes("scale_unlabeled"), `${text} (no story): ${original.join(",")}`);
  }
});

// 11: a refused Gaps answer changes nothing.
test("answerGap: a refused bullet throws blocked and saves no bullet, skill or note", async () => {
  const { db, id } = await setup();
  assert.throws(() => answerGap(db, id, {
    kind: "must", requirement: "Agent platforms", answer: "have", entry_id: "nova", entry_ids: ["nova", "orbit"],
    text: "Managed one million concurrent agents on the queue", story: "handled 1000000 agents for agent platforms"
  }), /blocked/);
  assert.equal(bankBullets().length, 2);
  assert.equal(loadSkillsExtra().skills.some((s) => s.name.toLowerCase() === "agent platforms"), false);
  assert.equal(db.prepare("SELECT 1 FROM gap_notes WHERE job_id = ?").get(id), undefined);
});

// 12: a good bullet is saved, but the requirement is a skill only when the story names it.
test("answerGap: a story that does not name the requirement saves the bullet but not the skill", async () => {
  const { db, id } = await setup();
  const r = answerGap(db, id, {
    kind: "must", requirement: "Terraform", answer: "have", entry_id: "nova", entry_ids: ["nova", "orbit"],
    text: "Set up staging servers with shell scripts", story: "set up the staging servers by hand with shell scripts"
  });
  assert.ok(r.bullet_id);
  assert.ok(bankBullets().some((b) => b.id === r.bullet_id));
  assert.match(r.outcome, /skill not added/);
  assert.equal(loadSkillsExtra().skills.some((s) => s.name.toLowerCase() === "terraform"), false);
});

// 13: a failing record gets no PDF, and an older one is removed.
test("renderRecord: a failing bullet is refused with bank_gate and the old PDF is deleted", async () => {
  const b = fakeBank({ nova: [bullet("nova-2", "Managed one million concurrent agents on the queue", ["queue"])] });
  const { db, id } = await setup(b);
  const rec = record(db, b, id, ["nova-1", "nova-2", "orbit-1"]);
  mkdirSync(pdfDir(), { recursive: true });
  const old = join(pdfDir(), `${rec.resume_id}.pdf`);
  writeFileSync(old, "%PDF-1.4 fake");
  const r = await renderRecord(rec, loadBank()!);
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.deepEqual(r.issues.filter((i) => i.code === "bank_gate").map((i) => i.detail), ["nova-2: scale_unlabeled"]);
  assert.equal(existsSync(old), false);
});

// 14a/14b: term_added (and scope_raised) block output unless the user reviewed the bullet.
const hasTools = ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error);
const termOnly = (reviewed?: string) => ({
  ...bullet("orbit-2", "Applied core engineering principles to decompose complex logic", ["design"]),
  evidence: ANSWER + "used sonar qube for code quality, broke complex logic into smaller chunks",
  ...(reviewed ? { reviewed } : {})
}) as Bank["roles"][number]["bullets"][number];

test("renderRecord: a term_added-only bullet without reviewed is refused with bank_gate", async () => {
  const b = fakeBank({ orbit: [termOnly()] });
  const { db, id } = await setup(b);
  const saved = loadBank()!;
  const ob = saved.roles.find((e) => e.id === "orbit")!.bullets.find((x) => x.id === "orbit-2")!;
  assert.deepEqual(gateBullet(saved, "orbit", ob.text, ob.evidence, ob.id), ["term_added"]);
  const rec = record(db, b, id, ["nova-1", "orbit-2"]);
  const r = await renderRecord(rec, saved);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.filter((i) => i.code === "bank_gate").map((i) => i.detail), ["orbit-2: term_added"]);
});

test("renderRecord: the same bullet with reviewed is not refused by the gate", async () => {
  const b = fakeBank({ orbit: [termOnly("2026-11-07")] });
  const { db, id } = await setup(b);
  const saved = loadBank()!;
  const ob = saved.roles.find((e) => e.id === "orbit")!.bullets.find((x) => x.id === "orbit-2")! as { reviewed?: string };
  assert.equal(ob.reviewed, "2026-11-07", "reviewed survives saveBank/loadBank");
  const rec = record(db, b, id, ["nova-1", "orbit-2"]);
  const r = await renderRecord(rec, saved);
  assert.equal(r.issues.some((i) => i.code === "bank_gate"), false, JSON.stringify(r.issues));
  if (hasTools) assert.equal(r.ok, true, JSON.stringify(r));
});

// T8: the tailor never picks a bullet the render gate would refuse; it lists it in left_out.
test("idealContent: a bullet that fails the gate is never selected, and it is listed in left_out", async () => {
  const b = fakeBank({ nova: [bullet("nova-2", "Managed one million concurrent agents on the queue", ["queue"]),
    bullet("nova-3", "Kept the agent job queue healthy with retries and alerts", ["queue"])] });
  await setup(b);
  const saved = loadBank()!;
  const req: Requirements = { role: "Platform Engineer", seniority: "mid", must_have: ["queue"], nice_to_have: [], keywords: [],
    themes: [], summary_variant: "backend" };
  const ideal = idealContent(req, saved, loadSkillsExtra(), { bullets_per_role: 4, bullets_total: 6, max_words: 25 });
  const ids = ideal.bullets.map((x) => x.id);
  assert.equal(ids.includes("nova-2"), false, ids.join(","));
  assert.ok(ids.includes("nova-3"), ids.join(","));
  assert.deepEqual(ideal.left_out, [{ bullet_id: "nova-2", codes: ["scale_unlabeled"] }]);
});

// T8 review: a job whose only bullet is blocked is not left off silently: the render refuses it.
test("renderRecord: a role whose only bullet is blocked gives role_dropped and no PDF", async () => {
  const b = fakeBank();
  b.roles[1].bullets = [bullet("orbit-1", "Managed one million concurrent agents on the queue", ["queue"])];
  const { db, id } = await setup(b);
  const saved = loadBank()!;
  const rec = record(db, saved, id, ["nova-1"]);
  const r = await renderRecord(rec, saved);
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.deepEqual(r.issues.filter((i) => i.code === "bank_gate").map((i) => i.detail), ["role_dropped: orbit"]);
});

// T8 review: a blocked bullet is no evidence for the job's score.
test("scoreRequirements: a requirement supported only by a blocked bullet scores as unsupported", async () => {
  const b = fakeBank({ nova: [bullet("nova-2", "Managed one million concurrent agents on the queue", ["queue"])] });
  await setup(b);
  const req: Requirements = { role: "Platform Engineer", seniority: "mid", must_have: ["queue"], nice_to_have: [], keywords: [],
    themes: [], summary_variant: "backend" };
  const item = scoreRequirements(req, loadBank()!, loadSkillsExtra()).items.find((i) => i.requirement === "queue")!;
  assert.equal(item.credit, 0, JSON.stringify(item));
  assert.deepEqual(item.bullet_ids, []);
});

// 15: a PDF made before the gate is not served while its bullets fail it.
test("GET /ui/resumes/:rid/pdf: a failing record is 409 with the bullet id in issues", async () => {
  const b = fakeBank({ nova: [bullet("nova-2", "Managed one million concurrent agents on the queue", ["queue"])] });
  const { app, db, id } = await setup(b);
  const rec = record(db, b, id, ["nova-1", "nova-2"]);
  mkdirSync(pdfDir(), { recursive: true });
  writeFileSync(join(pdfDir(), `${rec.resume_id}.pdf`), "%PDF-1.4 fake");
  const res = await app.inject({ method: "GET", url: `/ui/resumes/${rec.resume_id}/pdf` });
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body) as { error: string; issues: { code: string; detail: string }[] };
  assert.equal(body.error, "bank_gate");
  assert.ok(body.issues.some((i) => i.code === "bank_gate" && i.detail.startsWith("nova-2:")), res.body);
});

// 16: the chat's fact flags from the saved report, lenient per item.
test("bankAudit: fact_flags give chat flags; an unknown problem is other, a malformed one dropped", async () => {
  await setup();
  mkdirSync(reportsDir(), { recursive: true });
  const report = {
    role_summary: "Runs agent platforms.",
    must_haves_ranked: [{ requirement: "Go", why_it_matters: "Core of the job." }],
    gaps: [], keywords_priority: ["Go"], interview_topics: ["Queues"], company_notes: ["Fake company."], questions_to_ask: ["Who owns on-call?"],
    fact_flags: [
      { bullet_id: "orbit-1", problem: "number", why: "The hourly count conflicts with another bullet." },
      { bullet_id: "orbit-1", problem: "vibes", why: "Reads like a different job." },
      { bullet_id: "orbit-1" }
    ]
  };
  writeFileSync(join(reportsDir(), "job-fake.claude.yaml"),
    stringify({ meta: { job_id: "job-fake", source: "claude", saved_at: "2026-11-07T00:00:00Z" }, report }));
  const audit = bankAudit();
  const row = audit.bullets.find((x) => x.id === "orbit-1");
  assert.ok(row?.chat, JSON.stringify(audit));
  assert.equal(row.chat.length, 2);
  assert.deepEqual(row.chat.map((f) => f.problem).sort(), ["number", "other"]);
  assert.ok(row.chat.every((f) => f.source === "claude" && f.job_id === "job-fake"));
});

// 17: markReviewed accepts only bullets whose sole problems are the reviewable ones.
test("markReviewed: a hard code is blocked; a term_added-only bullet gets the date", async () => {
  await setup(fakeBank({
    nova: [bullet("nova-2", "Managed one million concurrent agents on the queue", ["queue"])],
    orbit: [termOnly()]
  }));
  assert.throws(() => markReviewed(["nova-2"]), /blocked: .*scale_unlabeled/);
  assert.equal((bankBullets().find((x) => x.id === "nova-2") as { reviewed?: string }).reviewed, undefined);
  markReviewed(["orbit-2"]);
  assert.match((bankBullets().find((x) => x.id === "orbit-2") as { reviewed?: string }).reviewed ?? "", /^\d{4}-\d{2}-\d{2}/);
});

// 15 (user, 2026-11-08): a bullet written as the answer to one gap may name that gap's
// requirement ("multi-cloud" for a multi-cloud story that never says the word), recorded in its
// evidence as "(for: <requirement>)". Nothing else gets in, and other bullets are as before.
const FOR = (req: string) => `answer 2026-11-08 (for: ${req}): `;
const vocabBank = () => fakeBank({ nova: [bullet("nova-9", "Kept invoices in object storage", ["multi-cloud", "terraform"])] });
const MC_TEXT = "Deployed multi-cloud services on AWS and GCP";
const MC_STORY = "worked across AWS for the APIs and GCP for analytics";

test("gate: an answer to a gap may name that gap's requirement; without (for:) it is term_added as before", async () => {
  await setup(vocabBank());
  assert.ok(gateBullet(vocabBank(), "nova", MC_TEXT, ANSWER + MC_STORY).includes("term_added"), "no gap named: blocked");
  assert.ok(!gateBullet(vocabBank(), "nova", MC_TEXT, FOR("multi-cloud") + MC_STORY).includes("term_added"), "the gap's own name passes");
});

test("gate: (for:) lets in only that requirement's terms; another added term is still term_added", async () => {
  await setup(vocabBank());
  const codes = gateBullet(vocabBank(), "nova", "Deployed multi-cloud services with Terraform on AWS and GCP", FOR("multi-cloud") + MC_STORY);
  assert.ok(codes.includes("term_added"), codes.join(","));
});

test("gate: a sentence requirement lets in the terms it names", async () => {
  await setup(vocabBank());
  const codes = gateBullet(vocabBank(), "nova", MC_TEXT, FOR("Experience running multi-cloud platforms") + MC_STORY);
  assert.ok(!codes.includes("term_added"), codes.join(","));
});

test("answerGap: a bullet answer records the gap it answers and is saved with the requirement's name", async () => {
  const { db, id } = await setup(vocabBank());
  const r = answerGap(db, id, { kind: "theme", requirement: "multi-cloud", answer: "have", entry_id: "nova", entry_ids: ["nova"], text: MC_TEXT, story: MC_STORY });
  const b = bankBullets().find((x) => x.id === r.bullet_id);
  assert.ok(b, "the bullet is in the bank");
  assert.match(b.evidence ?? "", /^answer \d{4}-\d{2}-\d{2} \(for: multi-cloud\): worked across AWS/);
});

test("parseEvidence: the story of an answer that names its gap", () => {
  assert.equal(parseEvidence(FOR("multi-cloud") + MC_STORY + " Proof: a PR").story, MC_STORY);
});

// 16 (user, 2026-11-08): the user's own story may use one listed word in a normal way ("writing
// and suggesting code"); a story with a rider, a phrase, a listed word as a comma rider, or two
// listed words still reads as model text. The bullet itself is checked as strictly as before.
test("gate: one listed word used normally in the user's story is not model_wording", async () => {
  await setup();
  const codes = gateBullet(fakeBank(), "nova", "Wrote unit tests for the billing export",
    ANSWER + "wrote unit tests for the billing export, always followed solid principles for writing and suggesting code");
  assert.ok(!codes.includes("model_wording"), codes.join(","));
});

test("gate: a story with a comma rider or two listed words is still model_wording", async () => {
  await setup();
  assert.ok(gateBullet(fakeBank(), "nova", "Wrote unit tests for the billing export",
    ANSWER + "wrote unit tests for the billing export, demonstrating strong quality").includes("model_wording"));
  assert.ok(gateBullet(fakeBank(), "nova", "Wrote unit tests for the billing export",
    ANSWER + "wrote robust unit tests and suggesting fixes for the billing export").includes("model_wording"));
});

test("gate: the bullet itself is as strict as before (one listed word blocks)", async () => {
  await setup();
  assert.ok(gateBullet(fakeBank(), "nova", "Wrote robust unit tests for the billing export",
    ANSWER + "wrote unit tests for the billing export").includes("model_wording"));
});
