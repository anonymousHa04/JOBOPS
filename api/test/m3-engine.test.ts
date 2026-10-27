import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bank, SkillsExtra } from "../src/profile/schema.ts";
import type { Requirements } from "../src/requirements/schema.ts";
import { decide } from "../src/tailor/decide.ts";
import type { StoredRecord } from "../src/tailor/decide.ts";
import { equivalence } from "../src/tailor/equivalence.ts";
import { idealContent, metricLed } from "../src/tailor/ideal.ts";
import type { ResumeContent } from "../src/tailor/ideal.ts";

// Engine tests from the m3-notes skill (engine-algorithm.md §8), on a fake resume only.

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
