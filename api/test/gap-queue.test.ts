import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { bank as baseBank, bullet, setup } from "./fixtures.ts";
import type { Bank } from "../src/profile/schema.ts";
import type { Db } from "../src/db.ts";
import { saveBank } from "../src/profile/bank.ts";
import { gapHelp } from "../src/ui/gap-model.ts";
import { gapKey, MAX_RELATED, relatedBullets } from "../src/ui/gap-related.ts";
import { gapList } from "../src/ui/gaps.ts";
import { GROUPS, runStage } from "../src/queue/worker.ts";

// Gap help (Gaps tab, "Explain"):
// 1. The model gets the few bullets that may show the requirement (word match plus Qdrant's
//    nearest bullets), never the whole bank: the whole bank made each call ~1,770 tokens.
// 2. It runs through the queue (stage gap_help, the Mac worker, one at a time), so "Explain all"
//    no longer times out waiting behind other calls to the one-slot 14B.
// Fake bank, fake model, fake queue: no Qdrant, no real model.

// 20 bullets: one about Terraform, one about Kubernetes, the rest unrelated.
const bigBank: Bank = {
  ...baseBank,
  roles: [{
    ...baseBank.roles[0],
    bullets: [
      bullet("cur-1", "Moved 20 services to Kubernetes", ["kubernetes"]),
      bullet("cur-2", "Wrote Terraform modules for the staging network", ["terraform"]),
      ...Array.from({ length: 18 }, (_, i) => bullet(`cur-${i + 3}`, `Ran the weekly sales review number ${i + 1}`, ["sales"]))
    ]
  }, baseBank.roles[1]]
};

// A fake OpenAI-style model server: records each prompt, answers gap help JSON.
async function fakeModel() {
  const prompts: string[] = [];
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      if (rq.url?.endsWith("/models")) { rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
      prompts.push((JSON.parse(raw) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n"));
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        meaning: "Infrastructure written as code.", similar_terms: ["Pulumi"],
        related: [{ bullet_id: "cur-2", why: "Terraform modules" }], questions: ["Where did you use it?"]
      }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, prompts, close: () => server.close() };
}

// A fake queue server: records POST /gap-help bodies and answers a batch.
async function fakeQueue() {
  const calls: { url: string; body: any }[] = [];
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      calls.push({ url: rq.url!, body: raw ? JSON.parse(raw) : null });
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ batch_id: 9, queued: (JSON.parse(raw || "{}").keys ?? []).length }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

const bulletLines = (prompt: string) => prompt.split("\n").filter((l) => /^\s*cur-\d+ \| |^\s*old-\d+ \| /.test(l));
const noVectors = async () => { throw new Error("qdrant down"); };

async function jobWithGap(mustHave: string[]) {
  const s = await setup({ must_have: mustHave });
  saveBank(bigBank);
  process.env.JOBOPS_MODEL_LOG = join(s.dir, "model-calls.jsonl");
  return s;
}

test("gap help: the prompt holds at most 5 related bullets, not the whole bank", async () => {
  const s = await jobWithGap(["Terraform"]);
  const m = await fakeModel();
  try {
    await gapHelp(s.db, s.id, "must", "Terraform", { baseUrl: m.url, search: noVectors });
    const lines = bulletLines(m.prompts[0]);
    assert.ok(lines.length <= MAX_RELATED, `prompt had ${lines.length} bullets`);
    assert.ok(lines.some((l) => l.includes("cur-2 |")), "the Terraform bullet is in the prompt");
  } finally { m.close(); }
});

test("gap help: Qdrant's nearest bullets come in when the words differ", async () => {
  const r = await relatedBullets(bigBank, new Set(), "infrastructure as code", async () => ["cur-2"]);
  assert.deepEqual(r.bullets.map((b) => b.id), ["cur-2"]);
  assert.equal(r.source, "vector");
});

test("gap help: word matches and nearest bullets are merged, at most 5, no repeats", async () => {
  const r = await relatedBullets(bigBank, new Set(["kubernetes"]), "Kubernetes", async () => ["cur-1", "cur-3", "cur-4", "cur-5", "cur-6", "cur-7"]);
  const ids = r.bullets.map((b) => b.id);
  assert.equal(ids[0], "cur-1");
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, MAX_RELATED);
  assert.equal(r.source, "both");
});

test("gap help: nothing found and Qdrant down, the whole bank is sent as before", async () => {
  const r = await relatedBullets(bigBank, new Set(), "quantum annealing", noVectors);
  assert.equal(r.source, "all");
  assert.equal(r.bullets.length, 21);
});

test("gap help route: no saved explanation, it is queued (the model is not called)", async () => {
  const s = await jobWithGap(["Terraform"]);
  const q = await fakeQueue();
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = q.url;
  try {
    const res = await s.app.inject({ method: "POST", url: `/ui/jobs/${s.id}/gaps/help`, payload: { kind: "must", requirement: "Terraform" } });
    assert.equal(res.statusCode, 202);
    assert.deepEqual(JSON.parse(res.body), { queued: true, batch_id: 9 });
    assert.deepEqual(q.calls, [{ url: "/gap-help", body: { job_id: s.id, keys: [gapKey("Terraform")] } }]);
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
    q.close();
  }
});

test("gap help route: a saved explanation is returned at once, nothing queued", async () => {
  const s = await jobWithGap(["Terraform"]);
  const help = { meaning: "m", similar_terms: [], related: [], questions: [] };
  s.db.prepare("INSERT INTO gap_notes (job_id, requirement, kind, help, updated_at) VALUES (?, 'Terraform', 'must', ?, 'now')").run(s.id, JSON.stringify(help));
  const q = await fakeQueue();
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = q.url;
  try {
    const res = await s.app.inject({ method: "POST", url: `/ui/jobs/${s.id}/gaps/help`, payload: { kind: "must", requirement: "Terraform" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { help });
    assert.equal(q.calls.length, 0);
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
    q.close();
  }
});

test("explain all: every unexplained gap goes to the queue in one request", async () => {
  const s = await jobWithGap(["Pulumi", "Ansible"]); // neither is in the bank: both red
  const q = await fakeQueue();
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = q.url;
  try {
    const res = await s.app.inject({ method: "POST", url: `/ui/jobs/${s.id}/gaps/help-all` });
    assert.equal(res.statusCode, 202);
    assert.equal(q.calls.length, 1);
    assert.deepEqual([...q.calls[0].body.keys].sort(), [gapKey("Ansible"), gapKey("Pulumi")].sort());
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
    q.close();
  }
});

test("gap help route: the queue is down, it says so (503)", async () => {
  const s = await jobWithGap(["Terraform"]);
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = "http://" + "127.0.0.1:1";
  try {
    const res = await s.app.inject({ method: "POST", url: `/ui/jobs/${s.id}/gaps/help`, payload: { kind: "must", requirement: "Terraform" } });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, "queue_down");
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
});

function queueTable(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS queue_tasks (id INTEGER PRIMARY KEY, batch_id INTEGER, job_id TEXT, stage TEXT,
    prompt_version TEXT, state TEXT, attempts INTEGER DEFAULT 0, worker TEXT, error_code TEXT, error_detail TEXT,
    result TEXT, final INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT, lease_until TEXT, retry_at TEXT)`);
}

test("gap list: a gap whose explanation is queued says so", async () => {
  const s = await jobWithGap(["Pulumi", "Ansible"]);
  queueTable(s.db);
  s.db.prepare("INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, updated_at) VALUES (9, ?, 'gap_help', ?, 'queued', 'now')")
    .run(s.id, `gap-${gapKey("Pulumi")}-9`);
  const gaps = gapList(s.db, s.id).gaps;
  assert.equal(gaps.find((g) => g.requirement === "Pulumi")?.help_queued, true);
  assert.equal(gaps.find((g) => g.requirement === "Ansible")?.help_queued, false);
});

test("worker: the Mac worker takes gap help before tailoring", () => {
  assert.deepEqual(GROUPS.mac, ["gap_help", "tailor"]);
});

test("worker: a gap_help task explains that gap and saves it", async () => {
  const s = await jobWithGap(["Pulumi"]); // red: no Pulumi bullet; Qdrant finds the Terraform one
  const m = await fakeModel();
  const old = process.env.LLM_GENERAL14_URL;
  process.env.LLM_GENERAL14_URL = m.url;
  try {
    const out = await runStage("gap_help", s.id, `gap-${gapKey("Pulumi")}-9`, s.db, { search: async () => ["cur-2"] });
    assert.equal(out.explained, true);
    assert.deepEqual(bulletLines(m.prompts[0]).map((l) => l.trim().split(" ")[0]), ["cur-2"]);
    const saved = gapList(s.db, s.id).gaps.find((g) => g.requirement === "Pulumi");
    assert.equal(saved?.help?.meaning, "Infrastructure written as code.");
  } finally {
    old === undefined ? delete process.env.LLM_GENERAL14_URL : (process.env.LLM_GENERAL14_URL = old);
    m.close();
  }
});

test("worker: a gap that is gone (answered, rescored away) is skipped", async () => {
  const s = await jobWithGap(["Terraform"]);
  const out = await runStage("gap_help", s.id, `gap-${gapKey("Not a gap here")}-9`, s.db, { search: noVectors });
  assert.equal(out.explained, false);
});
