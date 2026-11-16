import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generate } from "../src/model/llm.ts";
import { ensureModel, forTask, ModelDownError } from "../src/model/registry.ts";

// Milestone 5: general7 on the laptop needs an API key. A fake model server only; nothing here
// sends a request to the laptop (its address is only a value forTask reads).
process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-m5-"));
process.env.JOBOPS_MODEL_LOG = join(process.env.JOBOPS_PROFILE_DIR, "calls.jsonl");
process.env.JOBOPS_LIST_RECHECK_MS = "0";
const KEY = "test-key-123";

// Records each request's authorization header; answers with `status` (200: a valid judge answer).
async function fakeModel(status = 200) {
  const auth: (string | undefined)[] = [];
  const server = createServer((rq, rs) => {
    auth.push(rq.headers.authorization);
    rq.resume();
    rq.on("end", () => {
      rs.statusCode = status;
      rs.setHeader("content-type", "application/json");
      rs.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }) : "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, auth, close: () => server.close() };
}

// Sets env vars for one case and restores them afterwards.
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const schema = z.object({ ok: z.boolean() });

test("model key: sent as a Bearer header when set, no header without it", async () => {
  const fake = await fakeModel();
  try {
    await withEnv({ LLM_GENERAL7_URL: fake.url, LLM_GENERAL7_KEY: KEY }, async () => {
      const r = await generate({ task: "judge", prompt: "p", schema });
      assert.equal(r.ok, true);
    });
    await withEnv({ LLM_GENERAL7_URL: fake.url, LLM_GENERAL7_KEY: undefined }, async () => {
      await generate({ task: "judge", prompt: "p", schema });
    });
    assert.equal(fake.auth[0], `Bearer ${KEY}`);
    assert.equal(fake.auth[1], undefined);
  } finally {
    fake.close();
  }
});

test("model key: a 401 names the key setting, never the key", async () => {
  const fake = await fakeModel(401);
  try {
    await withEnv({ LLM_GENERAL7_URL: fake.url, LLM_GENERAL7_KEY: KEY }, async () => {
      const r = await generate({ task: "judge", prompt: "p", schema });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.error, "unavailable");
      assert.match(r.detail, /LLM_GENERAL7_KEY/);
      assert.doesNotMatch(r.detail, new RegExp(KEY));
      await assert.rejects(ensureModel("judge"), (err: unknown) =>
        err instanceof ModelDownError && /refused the API key/.test(err.message) && /LLM_GENERAL7_KEY/.test(err.message) &&
        !err.message.includes(KEY));
    });
  } finally {
    fake.close();
  }
});

test("remote model: the laptop address gets the start-server hint, a local one does not", async () => {
  await withEnv({ LLM_GENERAL7_URL: "http://" + "10.10.10.1:8084" + "/v1" }, () => {
    assert.match(forTask("jd_parse").remoteStart ?? "", /start-server\.cmd/);
  });
  await withEnv({ LLM_GENERAL7_URL: "http://" + "127.0.0.1:8084" + "/v1" }, () => {
    assert.equal(forTask("jd_parse").remoteStart, undefined);
  });
});

test("reword timeout is 120 s", () => {
  assert.equal(forTask("reword").timeoutMs, 120_000);
});
