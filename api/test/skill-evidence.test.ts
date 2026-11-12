// Skills backed by ticked bullets (2026-11-10, user-approved cases 1-5): "Add as a skill" and
// "Edit evidence" save what the resume check (exit gate) will accept, and warn before saving
// what it would block. Fake person, fake bank, temp profile, in-memory DB; no models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bullet } from "./fixtures.ts";
import type { Bank, ResumeRecord } from "../src/profile/schema.ts";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { loadBank, loadSkillsExtra, saveBank, saveSkillsExtra } from "../src/profile/bank.ts";
import { writeRecord } from "../src/tailor/records.ts";
import { exitIssues } from "../src/render/exit-gate.ts";
import { answerGap, WeakEvidence } from "../src/ui/gaps.ts";
import { bulletsShowing } from "../src/profile/skill-evidence.ts";

process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";
const SKILL = "asynchronous programming";

function fakeBank(): Bank {
  return {
    basics: { name: "Riya Testwal", email: "riya@example.com", phone: "+91 90000 11111", location: "Pune", links: [] },
    summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
    roles: [{ id: "nova", title: "Backend Engineer", company: "Nimbus Labs", dates: "Mar 2023 - Present", bullets: [
      bullet("nova-1", "Used asynchronous programming in the Kafka consumers so review agents never wait on each other", ["kafka", "queues"]),
      bullet("nova-2", "Handled concurrent API calls without blocking services", ["api", SKILL]),
      bullet("nova-3", "Wrote the TypeScript billing export for finance teams", ["typescript", "billing"]),
    ] }],
    projects: [],
    education: [{ id: "edu", degree: "B.E.", school: "Fake Institute", dates: "2015 - 2019", details: [] }],
    skills: { languages: ["go", "typescript"], frameworks: [], tools: [], domains: [] },
    approved: true,
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobops-skillev-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  process.env.JOBOPS_FEEDBACK_LOG = join(dir, "report-feedback.jsonl");
  saveBank(fakeBank());
  saveSkillsExtra({ skills: [], dismissed: [], learnable: [] });
  const db = openDb(":memory:");
  const app = buildApp({ db });
  const res = await app.inject({ method: "POST", url: "/jobs",
    payload: { title: "Backend Engineer", company: "Fakecorp", description: "Async work.", source_url: "https://example.com/jobs/fakecorp-async" } });
  return { app, db, id: JSON.parse(res.body).id as string };
}

const record = (db: Db, jd: string): ResumeRecord => writeRecord(db, loadBank()!, {
  jd_id: jd, source_resume_id: null, decision: "adapt", reason: "test", band: "good", score: 80, equivalence: null,
  flags: { unsupported_must_haves: [], risks: [] }, review_findings: [], changes: [], evidence_refs: [],
  content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["go", SKILL],
    bullets: [{ id: "nova-3", entry_id: "nova", text: fakeBank().roles[0].bullets[2].text, reword: null }] },
}).record;
const blocked = (db: Db, jd: string) => exitIssues(record(db, jd), loadBank()!, loadSkillsExtra(), []).some((i) => i.code === "skill_unsupported");
const saved = () => loadSkillsExtra().skills.find((s) => s.name === SKILL);
const WEAK_NOTE = "same as goroutines: Build";
const ask = (over: Record<string, unknown> = {}) => ({ kind: "must" as const, requirement: SKILL, answer: "have" as const,
  as_skill: true, entry_ids: ["nova"], story: WEAK_NOTE, ...over });

test("1: ticked bullets end up in the skill's evidence, and the exit gate accepts the skill", async () => {
  const { db, id } = await setup();
  answerGap(db, id, ask({ bullet_ids: ["nova-1"] }));
  assert.match(saved()!.evidence!, /\(bullet nova-1\)$/);
  assert.equal(blocked(db, id), false);
});

test("2: no ticks and a note that does not name the skill: refused with a warning, saved only when confirmed", async () => {
  const { db, id } = await setup();
  assert.throws(() => answerGap(db, id, ask()), WeakEvidence);
  assert.equal(saved(), undefined, "nothing saved before the confirm");
  answerGap(db, id, ask({ confirm_weak: true }));
  assert.ok(saved(), "saved after the confirm");
  assert.equal(blocked(db, id), true, "and the resume check still blocks it until it is backed");
});

test("3: bank bullets whose text or tags show the skill are offered by code", async () => {
  await setup();
  const ids = bulletsShowing(loadBank()!, SKILL).map((b) => b.id);
  assert.deepEqual(ids, ["nova-1", "nova-2"], "nova-1 by its text, nova-2 by its tag; nova-3 (billing) not offered");
});

test("4: a bullet that was not ticked is never linked", async () => {
  const { db, id } = await setup();
  answerGap(db, id, ask({ bullet_ids: ["nova-2"] }));
  assert.doesNotMatch(saved()!.evidence!, /nova-1/);
  answerGap(db, id, ask({ story: `I did ${SKILL} in the billing service`, bullet_ids: [] }));
  assert.doesNotMatch(saved()!.evidence!, /bullet /, "no ticks: no bullet linked, even though two would match");
});

test("5: Edit evidence uses the same rule: weak is refused, a ticked bullet saves and the gate accepts", async () => {
  const { app, db, id } = await setup();
  answerGap(db, id, ask({ confirm_weak: true }));
  assert.equal(blocked(db, id), true);
  const weak = await app.inject({ method: "POST", url: "/ui/skills/evidence", payload: { name: SKILL, note: WEAK_NOTE } });
  assert.equal(weak.statusCode, 400);
  assert.equal(JSON.parse(weak.body).error, "weak_evidence");
  // Ticking a bullet that is not in the bank is refused; a bank bullet ticked as this work backs it
  // (the verifier checks its meaning).
  const bad = await app.inject({ method: "POST", url: "/ui/skills/evidence", payload: { name: SKILL, note: "Kafka work", bullet_ids: ["nope-9"] } });
  assert.equal(JSON.parse(bad.body).error, "unknown_bullets");
  const ok = await app.inject({ method: "POST", url: "/ui/skills/evidence", payload: { name: SKILL, note: "Kafka queues at Nimbus", bullet_ids: ["nova-1"] } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(blocked(db, id), false);
  const cands = await app.inject({ method: "GET", url: `/ui/skills/candidates?name=${encodeURIComponent(SKILL)}&ids=nova-3` });
  assert.deepEqual(JSON.parse(cands.body).bullets.map((b: { id: string }) => b.id), ["nova-1", "nova-2", "nova-3"]);
});
