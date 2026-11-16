import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generate } from "../src/model/llm.ts";
import { ensureModel, forTask, ModelDownError } from "../src/model/registry.ts";
import { openDb } from "../src/db.ts";
import { createJobRepository } from "../src/jobs/repository.ts";
import { jdParse, jdParseAll, modelStats } from "../src/tools.ts";

// Milestone 4: the model registry, preflight checks, the call log, and how a call ends
// (ok, retried, invalid, timeout, down). A fake model server only; no real model.
const fresh = () => {
  process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-m4-"));
  process.env.JOBOPS_MODEL_LOG = join(process.env.JOBOPS_PROFILE_DIR, "calls.jsonl");
  process.env.JOBOPS_LIST_RECHECK_MS = "0";
};
fresh();
const DOWN = "http://127.0.0.1:9/v1"; // nothing listens on port 9
const log = () => existsSync(process.env.JOBOPS_MODEL_LOG!)
  ? readFileSync(process.env.JOBOPS_MODEL_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

// Answers each call with the next answer in the list (an object is sent as JSON), after
// an optional delay; records request bodies.
async function fakeModel(answers: (unknown | ((body: string) => unknown))[], opts: { delayMs?: number } = {}) {
  const bodies: string[] = [];
  const server = createServer((rq, rs) => {
    if (rq.url?.endsWith("/models")) { rs.end("{}"); return; }
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      bodies.push(body);
      const a = answers[Math.min(bodies.length - 1, answers.length - 1)];
      const content = typeof a === "function" ? (a as (b: string) => unknown)(body) : a;
      setTimeout(() => {
        rs.setHeader("content-type", "application/json");
        rs.end(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      }, opts.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies, close: () => server.close() };
}

test("registry: defaults from config/models.yaml; profile/models.yaml replaces a task; an env var wins", () => {
  fresh();
  assert.deepEqual([forTask("judge").model, forTask("judge").role, forTask("judge").timeoutMs], ["qwen2.5:7b", "general7", 60_000]);
  assert.deepEqual([forTask("reword").model, forTask("bank_build").maxTokens], ["qwen2.5:14b", 8000]);
  writeFileSync(join(process.env.JOBOPS_PROFILE_DIR!, "models.yaml"), "tasks:\n  judge: { model: qwen2.5:14b, env: JOBOPS_JUDGE_MODEL, timeout_s: 90 }\n");
  assert.deepEqual([forTask("judge").model, forTask("judge").timeoutMs], ["qwen2.5:14b", 90_000]);
  process.env.JOBOPS_JUDGE_MODEL = "qwen2.5:7b";
  try {
    assert.equal(forTask("judge").model, "qwen2.5:7b", "the env var wins");
  } finally {
    delete process.env.JOBOPS_JUDGE_MODEL;
  }
  process.env.JOBOPS_JUDGE_MODEL = "llama:70b";
  try {
    assert.throws(() => forTask("judge"), /uses "llama:70b", which is not under models/);
  } finally {
    delete process.env.JOBOPS_JUDGE_MODEL;
  }
});

const Schema = z.object({ label: z.enum(["yes", "no"]), ids: z.array(z.string()) });

test("call: ok, with token counts in the log and never the prompt or the answer", async () => {
  fresh();
  const m = await fakeModel([{ label: "yes", ids: ["a-1"] }]);
  try {
    const r = await generate({ task: "judge", prompt: "SECRET RESUME TEXT", schema: Schema, baseUrl: m.url });
    assert.ok(r.ok && r.value.label === "yes");
    const [row] = log();
    assert.deepEqual([row.task, row.model, row.outcome, row.attempts, row.prompt_tokens, row.completion_tokens], ["judge", "qwen2.5:7b", "ok", 1, 100, 20]);
    const text = readFileSync(process.env.JOBOPS_MODEL_LOG!, "utf8");
    assert.ok(!text.includes("SECRET") && !text.includes("a-1"), "no prompt or answer text in the log");
  } finally {
    m.close();
  }
});

test("call: an invalid answer is retried once, and the retry names the failing field, not the answer", async () => {
  fresh();
  const m = await fakeModel([{ label: "maybe", ids: ["a-1"] }, { label: "no", ids: [] }]);
  try {
    const r = await generate({ task: "judge", prompt: "p", schema: Schema, baseUrl: m.url });
    assert.ok(r.ok && r.value.label === "no");
    const retry = JSON.parse(m.bodies[1]) as { messages: { content: string }[] };
    assert.equal(retry.messages.length, 2);
    assert.match(retry.messages[1].content, /did not match the required JSON at: label\./);
    assert.ok(!retry.messages[1].content.includes("maybe"), "the bad answer is not sent back");
    assert.deepEqual([log()[0].outcome, log()[0].attempts, log()[0].prompt_tokens], ["retry_ok", 2, 200]);
  } finally {
    m.close();
  }
});

test("call: invalid twice, a timeout, and a server that is down each end with their own outcome", async () => {
  fresh();
  const bad = await fakeModel(["not json at all"]);
  try {
    const r = await generate({ task: "judge", prompt: "p", schema: Schema, baseUrl: bad.url });
    assert.deepEqual(r.ok ? null : [r.error, r.detail], ["invalid_output", "(not JSON)"]);
  } finally {
    bad.close();
  }
  writeFileSync(join(process.env.JOBOPS_PROFILE_DIR!, "models.yaml"), "tasks:\n  judge: { model: qwen2.5:7b, timeout_s: 0.2 }\n");
  const slow = await fakeModel([{ label: "yes", ids: [] }], { delayMs: 1000 });
  try {
    const r = await generate({ task: "judge", prompt: "p", schema: Schema, baseUrl: slow.url });
    assert.deepEqual(r.ok ? null : r.error, "timeout");
  } finally {
    slow.close();
  }
  const r = await generate({ task: "judge", prompt: "p", schema: Schema, baseUrl: DOWN });
  assert.ok(!r.ok && r.error === "unavailable" && /llm\.sh start general7/.test(r.detail));
  assert.deepEqual(log().map((x) => x.outcome), ["invalid_output", "timeout", "unavailable"]);
  const stats = modelStats();
  assert.deepEqual([stats.calls, stats.tasks[0].task, stats.tasks[0].outcomes], [3, "judge", { invalid_output: 1, timeout: 1, unavailable: 1 }]);
});

test("preflight: a command whose model is down stops before any work, with the commands to switch", async () => {
  fresh();
  process.env.LLM_GENERAL7_URL = DOWN;
  try {
    await assert.rejects(ensureModel("judge", "3 requirements need the judge"), (err: unknown) =>
      err instanceof ModelDownError &&
      err.message === "qwen2.5:7b (judge) is not running: 3 requirements need the judge. Switch to it with: .claude/bin/llm.sh stop all && .claude/bin/llm.sh start general7");
    const db = openDb(":memory:");
    const repo = createJobRepository(db);
    for (const n of [1, 2]) repo.upsert({ title: `SDE ${n}`, company: "Acme", description: "Build things.", source_url: `https://example.com/jobs/${n}`, required_skills: [], preferred_skills: [] });
    await assert.rejects(jdParseAll(db, 10), /qwen2\.5:7b \(jd_parse\) is not running: 2 jobs to parse/);
    assert.equal(log().length, 0, "no model call was attempted");
  } finally {
    delete process.env.LLM_GENERAL7_URL;
  }
});

test("preflight: a parse that is already done needs no model; a batch stops when the server goes down midway", async () => {
  fresh();
  const parsed = { role: "SDE", seniority: "senior", must_have: ["Go"], nice_to_have: [], keywords: ["Go"], themes: [], summary_variant: "backend" };
  let calls = 0;
  const m = await fakeModel([parsed]);
  const db = openDb(":memory:");
  const repo = createJobRepository(db);
  const ids = [1, 2, 3].map((n) => repo.upsert({ title: `SDE ${n}`, company: "Acme", description: "Go services.", source_url: `https://example.com/jobs/${n}`, required_skills: [], preferred_skills: [] }).job.id);
  process.env.LLM_GENERAL7_URL = m.url;
  try {
    await jdParse(db, ids[0]);
    calls = m.bodies.length;
    process.env.LLM_GENERAL7_URL = DOWN;
    await jdParse(db, ids[0]); // already parsed: no preflight, no call
    assert.equal(m.bodies.length, calls);
    // Server up for the preflight, down for the calls: the batch stops at the first failure.
    const flaky = createServer((rq, rs) => {
      if (rq.url?.endsWith("/models")) { rs.end("{}"); return; }
      rs.statusCode = 503; rs.end("down");
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    process.env.LLM_GENERAL7_URL = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/v1`;
    try {
      const r = await jdParseAll(db, 10);
      assert.equal(r.parsed, 0);
      assert.equal(r.failed.length, 1, "stopped after the first failure, not one per job");
      assert.match(r.stopped ?? "", /went down after 0 of 2/);
    } finally {
      flaky.close();
    }
  } finally {
    m.close();
    delete process.env.LLM_GENERAL7_URL;
  }
});
