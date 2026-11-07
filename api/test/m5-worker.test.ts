import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { failureCode, GROUPS } from "../src/queue/worker.ts";
import { done, fail, lease, queueUp, startBatch, QueueDownError } from "../src/queue/client.ts";

// Milestone 5: the worker's failure codes and groups, and the queue client against a fake queue
// server (no Go queue, no model).

test("worker: failure codes from error messages", () => {
  assert.equal(failureCode(new Error("model timeout: no answer in 60000 ms")), "timeout");
  assert.equal(failureCode(new Error("model unavailable: fetch failed")), "unavailable");
  assert.equal(failureCode(new Error("qwen2.5:7b (judge) refused the API key (status 401). Set LLM_GENERAL7_KEY in .env.")), "unavailable");
  assert.equal(failureCode(new Error("model invalid_output: must_have")), "invalid_output");
  assert.equal(failureCode(new Error("parse the JD first: jd parse <job_id>")), "job_error");
});

test("worker: laptop serves score then parse, mac serves gap help then tailor", () => {
  assert.deepEqual(GROUPS.laptop, ["score", "parse"]);
  assert.deepEqual(GROUPS.mac, ["gap_help", "tailor"]); // gap help joined the Mac queue (2026-11-07)
});

// Records method, path and JSON body; /lease answers 204 the first time, then a task.
async function fakeQueue() {
  const calls: { method: string; url: string; body: any }[] = [];
  let leases = 0;
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      calls.push({ method: rq.method!, url: rq.url!, body: raw ? JSON.parse(raw) : null });
      rs.setHeader("content-type", "application/json");
      if (rq.url === "/batches") { rs.statusCode = 201; rs.end(JSON.stringify({ batch_id: 4 })); return; }
      if (rq.url === "/lease") {
        if (leases++ === 0) { rs.statusCode = 204; rs.end(); return; }
        rs.end(JSON.stringify({ id: 7, batch_id: 4, job_id: "job-1", stage: "parse", attempts: 1, prompt_version: "v1" }));
        return;
      }
      rs.statusCode = 204;
      rs.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

test("queue client: requests to the queue server", async () => {
  const q = await fakeQueue();
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = q.url;
  try {
    assert.deepEqual(await startBatch(5, "v1"), { batch_id: 4 });
    assert.deepEqual(q.calls[0], { method: "POST", url: "/batches", body: { limit: 5, parse_version: "v1" } });
    assert.equal(await lease(["parse"], "w"), null);
    const task = await lease(["parse"], "w");
    assert.equal(task?.id, 7);
    assert.equal(task?.job_id, "job-1");
    assert.deepEqual(q.calls[1].body, { stages: ["parse"], worker: "w" });
    await done(7, { score: 70 });
    assert.deepEqual(q.calls[3], { method: "POST", url: "/tasks/7/done", body: { result: { score: 70 } } });
    await fail(7, "timeout", "x".repeat(400));
    assert.equal(q.calls[4].url, "/tasks/7/fail");
    assert.equal(q.calls[4].body.code, "timeout");
    assert.equal(q.calls[4].body.detail.length, 300);
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
    q.close();
  }
});

test("queue client: a stopped queue says how to start it", async () => {
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = "http://" + "127.0.0.1:1"; // nothing listens on port 1
  try {
    assert.equal(await queueUp(), false);
    await assert.rejects(startBatch(5, "v1"), (err: unknown) =>
      err instanceof QueueDownError && err.message.includes("go run -C queue ./cmd/queue"));
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
});
