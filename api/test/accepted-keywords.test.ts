import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bullet } from "./fixtures.ts";
import type { Bank, ResumeRecord, SkillsExtra } from "../src/profile/schema.ts";
import type { Db } from "../src/db.ts";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { linkedBullets, loadBank, loadSkillsExtra, saveBank, saveSkillsExtra, withRelatedTags } from "../src/profile/bank.ts";
import { idealContent } from "../src/tailor/ideal.ts";
import { checkRewrite } from "../src/tailor/guard.ts";
import { pendingReview, writeRecord } from "../src/tailor/records.ts";
import { vocabulary } from "../src/profile/bank.ts";
import { norm } from "../src/scoring/terms.ts";
import { exitIssues } from "../src/render/exit-gate.ts";
import { answerGap } from "../src/ui/gaps.ts";
import { keywordApprove } from "../src/tools.ts";
import type { Requirements } from "../src/requirements/schema.ts";

// Accepted keywords tied to bullets (plan-exit-gate.md K2, tests K5 cases 8-10): a related
// keyword is a tag on its linked bullets only, never a synonym; its first use in a rewording
// waits for the user's approval of that exact line; Gaps "Related work" is gated at write.
// Fake person, fake bank, temp profiles; no models.

process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";

const TERM = "platform engineering";
const DAY = "2026-11-09";

function fakeBank(): Bank {
  return {
    basics: { name: "Riya Testwal", email: "riya@example.com", phone: "+91 90000 11111", location: "Pune", links: [] },
    summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
    roles: [
      { id: "nova", title: "Platform Engineer", company: "Nimbus Labs (Client: Fakebank)", dates: "Mar 2023 - Present",
        bullets: [
          bullet("nova-1", "Wrote the TypeScript billing export for regional finance teams", ["typescript", "billing"]),
          bullet("nova-2", "Set up the shared deploy pipeline with GitHub Actions and Docker", ["github actions", "docker"])
        ] },
      { id: "orbit", title: "Software Engineer", company: "Orbitware", dates: "Jan 2020 - Feb 2023",
        bullets: [bullet("orbit-1", "Built the Go ingestion worker that parsed vendor invoice files", ["go", "ingestion"])] }
    ],
    projects: [],
    education: [{ id: "edu", degree: "B.E.", school: "Fake Institute", dates: "2015 - 2019", details: [] }],
    skills: { languages: ["go", "typescript"], frameworks: ["react"], tools: ["docker"], domains: [] },
    approved: true
  };
}

type Skill = SkillsExtra["skills"][number];
const extraOf = (...skills: Skill[]): SkillsExtra => ({ skills, dismissed: [], learnable: [] });
const related = (over: Partial<Skill> = {}): Skill => ({ name: TERM, status: "have", kind: "related", bullets: ["nova-2"],
  evidence: `answer ${DAY}: related work: platform engineering for the team: one deploy pipeline every service uses`, added_at: DAY, ...over });

const req = (over: Partial<Requirements> = {}): Requirements => ({
  role: "Backend Engineer", seniority: "senior", must_have: ["TypeScript", "Go"], nice_to_have: [], themes: [],
  keywords: ["Platform Engineering", "TypeScript"], summary_variant: "backend", ...over
});
const budget = (perRole: number) => ({ bullets_per_role: perRole, bullets_total: 10, max_words: 30 });

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobops-kw-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  process.env.JOBOPS_FEEDBACK_LOG = join(dir, "report-feedback.jsonl");
  return dir;
}

// A temp profile with the fake bank and skills, an in-memory DB, and one job.
async function setup(extra: SkillsExtra = extraOf()) {
  const dir = profile();
  saveBank(fakeBank());
  saveSkillsExtra(extra);
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Backend Engineer", company: "Fakecorp", description: "Run platforms.", source_url: "https://example.com/jobs/fakecorp-kw" } });
  return { app, db, dir, id: JSON.parse(res.body).id as string };
}

const tagsOf = (b: Bank) => new Map([...b.roles, ...b.projects].flatMap((e) => e.bullets.map((x) => [x.id, x.tags] as const)));

// ---- 8. A related keyword is a tag on its linked bullets only -------------------------------

test("8. withRelatedTags: a related keyword is a tag on its linked bullet only, in memory (bank.yaml unchanged)", () => {
  profile();
  saveBank(fakeBank());
  const tagged = tagsOf(withRelatedTags(loadBank()!, extraOf(related())));
  assert.ok(tagged.get("nova-2")!.includes(TERM));
  assert.ok(!tagged.get("nova-1")!.includes(TERM));
  assert.ok(!tagged.get("orbit-1")!.includes(TERM));
  // Never written: the saved bank and the object passed in keep their own tags.
  assert.ok(!tagsOf(loadBank()!).get("nova-2")!.includes(TERM));
  assert.ok(!readFileSync(join(process.env.JOBOPS_PROFILE_DIR!, "bank.yaml"), "utf8").includes(TERM));
  // Never a synonym: the term keeps its own name.
  assert.equal(norm("Platform Engineering"), TERM);
});

test("8. idealContent: the related keyword is in the reword's allowed list for its linked bullet only", () => {
  profile();
  saveBank(fakeBank());
  const extra = extraOf(related());
  const c = idealContent(req(), loadBank()!, extra, budget(3));
  const byId = new Map(c.bullets.map((b) => [b.id, b]));
  assert.ok(byId.get("nova-2")?.reword?.keywords.includes("Platform Engineering"), JSON.stringify(byId.get("nova-2")));
  for (const id of ["nova-1", "orbit-1"]) assert.ok(!byId.get(id)?.reword?.keywords.includes("Platform Engineering"), id);
  // The guard: the term is allowed only where it was marked; elsewhere it is term_added.
  const vocab = new Set([...vocabulary(loadBank()!, extra)].map(norm));
  const opts = (allowed: string[]) => ({ vocab, allowed, maxWords: 30 });
  assert.deepEqual(checkRewrite(fakeBank().roles[0].bullets[1].text, "Set up the shared deploy pipeline for platform engineering with GitHub Actions and Docker", opts(["Platform Engineering"])), []);
  assert.ok(checkRewrite(fakeBank().roles[0].bullets[0].text, "Wrote the TypeScript billing export for platform engineering teams", opts([])).includes("term_added"));
});

test("8. idealContent: a related keyword is on the skills line only when a linked bullet is on the resume", () => {
  profile();
  saveBank(fakeBank());
  const extra = extraOf(related());
  // One bullet per role: the must-haves pick nova-1 (TypeScript) and orbit-1 (Go); nova-2 is off.
  const without = idealContent(req(), loadBank()!, extra, budget(1));
  assert.ok(!without.bullets.some((b) => b.id === "nova-2"), without.bullets.map((b) => b.id).join(","));
  assert.ok(!without.skills.some((s) => norm(s) === TERM), without.skills.join(","));
  const withIt = idealContent(req(), loadBank()!, extra, budget(3));
  assert.ok(withIt.bullets.some((b) => b.id === "nova-2"));
  assert.ok(withIt.skills.some((s) => norm(s) === TERM), withIt.skills.join(","));
});

test("8. a 'same' skill behaves as before: no tag on any bullet, listed on every resume", () => {
  profile();
  saveBank(fakeBank());
  const same: Skill = { name: "reactjs", status: "have", kind: "same", evidence: `answer ${DAY}: same as react (used at: Platform Engineer at Nimbus Labs; bullet nova-2)`, added_at: DAY };
  const extra = extraOf(same);
  assert.ok(![...tagsOf(withRelatedTags(loadBank()!, extra)).values()].some((t) => t.includes("reactjs")));
  const c = idealContent(req({ keywords: ["ReactJS"] }), loadBank()!, extra, budget(1));
  assert.ok(!c.bullets.some((b) => b.id === "nova-2"));
  assert.ok(c.skills.includes("ReactJS"), c.skills.join(","));
});

test("8. old data: the '(used at: ...; bullet X)' evidence still links (no bullets field, with or without kind)", () => {
  profile();
  saveBank(fakeBank());
  const ev = `answer ${DAY}: ran platform engineering for the deploy pipeline (used at: Platform Engineer at Nimbus Labs (Client: Fakebank); bullet nova-2)`;
  const unlabeled: Skill = { name: TERM, status: "have", evidence: ev, added_at: DAY };
  const relatedOld: Skill = { ...unlabeled, kind: "related" };
  for (const s of [unlabeled, relatedOld]) {
    assert.deepEqual(linkedBullets(s), ["nova-2"]);
    const tagged = tagsOf(withRelatedTags(loadBank()!, extraOf(s)));
    assert.ok(tagged.get("nova-2")!.includes(TERM));
    assert.ok(!tagged.get("nova-1")!.includes(TERM));
  }
  // The skills line: unlabeled data works as before (listed); kind related needs its bullet.
  assert.ok(idealContent(req(), loadBank()!, extraOf(unlabeled), budget(1)).skills.some((s) => norm(s) === TERM));
  assert.ok(!idealContent(req(), loadBank()!, extraOf(relatedOld), budget(1)).skills.some((s) => norm(s) === TERM));
});

// ---- 9. First use -> keyword_review; approval holds while the text is the same --------------

const REWORDED = "Set up the shared deploy pipeline for platform engineering with GitHub Actions and Docker";

function recordWith(db: Db, nova2: string): ResumeRecord {
  const bank = loadBank()!;
  const bullets = [
    { id: "nova-1", entry_id: "nova", text: bank.roles[0].bullets[0].text, reword: null },
    { id: "nova-2", entry_id: "nova", text: nova2, reword: null }
  ];
  const pending_review = pendingReview(bullets, bank, loadSkillsExtra());
  return writeRecord(db, bank, {
    jd_id: "job-kw", source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 80, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["go", "typescript", TERM], bullets },
    ...(pending_review.length ? { pending_review } : {})
  }).record;
}
const exitCodes = (r: ResumeRecord) => exitIssues(r, loadBank()!, loadSkillsExtra(), []).map((i) => [i.code, i.detail]);

test("9. first use: a rewording that adds the related keyword is pending_review and blocked by keyword_review", async () => {
  const { db } = await setup(extraOf(related()));
  const r = recordWith(db, REWORDED);
  assert.deepEqual(r.pending_review, [{ bullet_id: "nova-2", keyword: TERM }]);
  assert.deepEqual(exitCodes(r), [["keyword_review", "nova-2"]]);
  // The bank text unchanged: nothing to review.
  const plain = recordWith(db, fakeBank().roles[0].bullets[1].text);
  assert.equal(plain.pending_review, undefined);
  assert.deepEqual(exitCodes(plain), []);
});

test("9. after approval (keyword approve) the same text passes; a changed text asks again", async () => {
  const { db } = await setup(extraOf(related()));
  const r = recordWith(db, REWORDED);
  const out = keywordApprove(db, r.resume_id, "nova-2");
  assert.deepEqual(out, { resume_id: r.resume_id, bullet_id: "nova-2", terms: [TERM] });
  const saved = loadBank()!.roles[0].bullets[1].approved_terms ?? [];
  assert.equal(saved.length, 1);
  assert.equal(saved[0].term, TERM);
  assert.deepEqual(exitCodes(r), []);
  const changed = recordWith(db, "Set up the platform engineering deploy pipeline with GitHub Actions and Docker");
  assert.deepEqual(exitCodes(changed), [["keyword_review", "nova-2"]]);
  // Nothing pending on a bullet: refused.
  assert.throws(() => keywordApprove(db, r.resume_id, "nova-1"), /nothing to approve/);
});

test("9. job drawer: the Tailor box lists the pending line; Approve wording clears it", async () => {
  const { app, db, id } = await setup(extraOf(related()));
  const bank = loadBank()!;
  const bullets = [{ id: "nova-2", entry_id: "nova", text: REWORDED, reword: null }];
  const { record } = writeRecord(db, bank, {
    jd_id: id, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 80, equivalence: null,
    flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
    content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["docker"], bullets },
    pending_review: pendingReview(bullets, bank, loadSkillsExtra())
  });
  const status = async () => JSON.parse((await app.inject({ method: "GET", url: `/ui/jobs/${id}/tailor` })).body);
  assert.deepEqual((await status()).pending_review.map((p: { bullet_id: string; keyword: string }) => [p.bullet_id, p.keyword]), [["nova-2", TERM]]);
  const res = await app.inject({ method: "POST", url: `/ui/jobs/${id}/resumes/${record.resume_id}/approve-wording`, payload: { bullet_id: "nova-2" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).terms, [TERM]);
  assert.deepEqual((await status()).pending_review, []);
});

test("8. exitIssues: a related keyword on the skills line without a linked bullet on the resume is skill_unlinked", async () => {
  const same: Skill = { name: "reactjs", status: "have", kind: "same", evidence: `answer ${DAY}: same as react`, added_at: DAY };
  const { db } = await setup(extraOf(related(), same));
  const bank = loadBank()!;
  const make = (ids: string[]) => {
    const bullets = [...bank.roles, ...bank.projects].flatMap((e) => e.bullets.filter((b) => ids.includes(b.id))
      .map((b) => ({ id: b.id, entry_id: e.id, text: b.text, reword: null })));
    return writeRecord(db, bank, {
      jd_id: "job-unlinked", source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 80, equivalence: null,
      flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
      content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["go", "Platform Engineering", "reactjs", "docker"], bullets }
    }).record;
  };
  // nova-2 off the resume: the related keyword (skill#2) is flagged; the same skill and bank skills are not.
  assert.deepEqual(exitCodes(make(["nova-1", "orbit-1"])), [["skill_unlinked", "skill#2"]]);
  assert.deepEqual(exitCodes(make(["nova-1", "nova-2"])), []);
});

// ---- 10. Gaps "Other name": same thing vs related work --------------------------------------

const base = { kind: "keyword" as const, requirement: "Platform Engineering", answer: "other_name" as const };
const synonymsFile = (dir: string) => join(dir, "synonyms.yaml");

test("10. Related work without a story naming the term, without a bullet, or with an unknown bullet is refused", async () => {
  const { db, id } = await setup();
  assert.throws(() => answerGap(db, id, { ...base, relation: "related", bullet_ids: ["nova-2"], story: "I set up the deploy pipeline for every service" }), /^Error: blocked: skill_unsupported/);
  assert.throws(() => answerGap(db, id, { ...base, relation: "related", bullet_ids: [], story: "I did platform engineering on the pipeline" }), /^Error: blocked: no_bullet/);
  assert.throws(() => answerGap(db, id, { ...base, relation: "related", bullet_ids: ["nova-2", "nova-99"], story: "I did platform engineering on the pipeline" }), /^Error: blocked: unknown_bullet nova-99/);
  assert.deepEqual(loadSkillsExtra().skills, []);
});

test("10. Related work with a story naming the term saves kind related with its bullets and no synonym", async () => {
  const { db, id, dir } = await setup();
  answerGap(db, id, { ...base, relation: "related", bullet_ids: ["nova-2"], story: "I did platform engineering: one deploy pipeline for every service" });
  const s = loadSkillsExtra().skills.find((x) => x.name === TERM)!;
  assert.equal(s.kind, "related");
  assert.deepEqual(s.bullets, ["nova-2"]);
  assert.equal(existsSync(synonymsFile(dir)), false);
});

test("10. Same thing, another spelling still writes the synonym (kind same)", async () => {
  const { db, id, dir } = await setup();
  answerGap(db, id, { kind: "keyword", requirement: "React JS", answer: "other_name", relation: "same", same_as: "react" });
  const s = loadSkillsExtra().skills.find((x) => x.name === "react js")!;
  assert.equal(s.kind, "same");
  assert.match(readFileSync(synonymsFile(dir), "utf8"), /react js: react/);
  // No relation given (older UI): the same as before.
  answerGap(db, id, { kind: "keyword", requirement: "React UI library", answer: "other_name", same_as: "react" });
  assert.match(readFileSync(synonymsFile(dir), "utf8"), /react ui library: react/);
});
