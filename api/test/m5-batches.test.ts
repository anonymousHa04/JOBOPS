import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setup } from "./fixtures.ts";
import { fill, loadPrompt } from "../src/model/prompts.ts";

// Milestone 5: the /batches routes pass through to the queue server; JD prompt v2.

async function withQueueUrl(url: string, fn: () => Promise<void>) {
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = url;
  try {
    await fn();
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
}

test("/batches: a stopped queue gives 503 with the start command; bad input gives 400", async () => {
  const { app } = await setup();
  await withQueueUrl("http://" + "127.0.0.1:1", async () => { // nothing listens on port 1
    const down = await app.inject({ method: "POST", url: "/batches", payload: { limit: 5 } });
    assert.equal(down.statusCode, 503);
    assert.match(down.json().error, /go run -C queue \.\/cmd\/queue/);
    assert.equal((await app.inject({ method: "POST", url: "/batches", payload: { limit: 101 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/batches/abc" })).statusCode, 400);
  });
  await app.close();
});

test("/batches: starts a batch of 100 with the current parse prompt version", async () => {
  const seen: unknown[] = [];
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      seen.push({ method: rq.method, url: rq.url, body: JSON.parse(raw || "{}") });
      rs.statusCode = 201;
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ batch_id: 9 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { app } = await setup();
  try {
    await withQueueUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => {
      const res = await app.inject({ method: "POST", url: "/batches", payload: {} });
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json(), { batch_id: 9 });
    });
    assert.deepEqual(seen, [{ method: "POST", url: "/batches",
      body: { limit: 100, parse_version: loadPrompt("parse-job-descripton").version } }]);
  } finally {
    await app.close();
    server.close();
  }
});

test("JD prompt v2: placeholders filled, short-phrase rule present", () => {
  const { template } = loadPrompt("parse-job-descripton");
  const prompt = fill(template, { "paste JD": "JD TEXT", "list your variants": "general" });
  assert.match(prompt, /JD TEXT/);
  assert.match(prompt, /Never copy a whole sentence/);
  assert.doesNotMatch(prompt, /\[paste JD\]/);
});
