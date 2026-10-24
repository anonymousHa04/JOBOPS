import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

const validJob = {
  title: "Backend Engineer",
  company: "Acme",
  description: "Build APIs in TypeScript.",
  source_url: "https://example.com/jobs/1",
  location: "Remote",
  required_skills: ["TypeScript", "SQL"],
};

test("POST valid job", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: validJob,
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.title, validJob.title);
  assert.strictEqual(body.company, validJob.company);
  assert.strictEqual(body.description, validJob.description);
  assert.strictEqual(body.source_url, validJob.source_url);
  assert.strictEqual(body.location, validJob.location);
  assert.deepStrictEqual(body.required_skills, validJob.required_skills);
  assert.deepStrictEqual(body.preferred_skills, []);
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(body.content_hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(body.first_seen_at, body.last_seen_at);
  assert.match(body.first_seen_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  await app.close();
});

test("POST with title missing", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...validJob, title: undefined },
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error, "validation_error");
  assert.ok(body.issues.some((i: { path: string }) => i.path === "title"));
  await app.close();
});

test("POST with unknown field", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...validJob, salary: 1 },
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error, "validation_error");
  // assert.deepStrictEqual(body.issues, [{ path: ["salary"], error: "unknown_field" }]);
  await app.close();
});

test("POST with invalid source_url", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...validJob, source_url: "not-a-url" },
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error, "validation_error");
  assert.ok(body.issues.some((i: { path: string }) => i.path === "source_url"));
  await app.close();
});

test("POST with title only spaces", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...validJob, title: "   " },
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error, "validation_error");
  assert.ok(body.issues.some((i: { path: string }) => i.path === "title"));
  await app.close();
});

test("POST valid, then GET /jobs/<id>", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: validJob,
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId = body.id;
  const getResponse = await app.inject({
    method: "GET",
    url: `/jobs/${jobId}`,
  });
  assert.strictEqual(getResponse.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(getResponse.body), body);
  await app.close();
});

test("GET /jobs/does-not-exist", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "GET",
    url: "/jobs/does-not-exist",
  });
  assert.strictEqual(response.statusCode, 404);
  const body = JSON.parse(response.body);
  assert.deepStrictEqual(body, { error: "not_found" });
  await app.close();
});

test("POST with seniority: 'wizard'", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...validJob, seniority: "wizard" },
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error, "validation_error");
  assert.ok(body.issues.some((i: { path: string }) => i.path === "seniority"));
  await app.close();
});
