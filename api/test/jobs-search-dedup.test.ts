import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

function job(overrides = {}) {
  return {
    title: "Backend Engineer",
    company: "Acme",
    description: "Build APIs.",
    source_url: "https://example.com/jobs/1",
    location: "Remote",
    seniority: "senior",
    required_skills: ["TypeScript", "SQL"],
    ...overrides,
  };
}

test("POST the same job twice", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId = body.id;
  const firstSeenAt = body.first_seen_at;
  const response2 = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response2.statusCode, 200);
  const body2 = JSON.parse(response2.body);
  assert.strictEqual(body2.id, jobId);
  assert.strictEqual(body2.first_seen_at, firstSeenAt);
  assert.ok(body2.last_seen_at >= firstSeenAt);
  await app.close();
});

test("POST a job, then POST it again with a different source_url but identical title/company/description", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId = body.id;
  const response2 = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...job(), source_url: "https://example.com/jobs/2" },
  });
  assert.strictEqual(response2.statusCode, 200);
  const body2 = JSON.parse(response2.body);
  assert.strictEqual(body2.id, jobId);
  await app.close();
});

test("POST a job, then POST the same source_url with a new description", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId = body.id;
  const response2 = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...job(), description: "Build APIs and more." },
  });
  assert.strictEqual(response2.statusCode, 200);
  const body2 = JSON.parse(response2.body);
  assert.strictEqual(body2.id, jobId);
  assert.notStrictEqual(body2.description, body.description);
  assert.notStrictEqual(body2.content_hash, body.content_hash);
  await app.close();
});

test("POST a job, then POST the same source_url with a different title case and extra spaces", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId = body.id;
  const response2 = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { ...job(), title: "  backend   ENGINEER " },
  });
  assert.strictEqual(response2.statusCode, 200);
  const body2 = JSON.parse(response2.body);
  assert.strictEqual(body2.id, jobId);
  await app.close();
});

test("POST two different jobs", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  const response = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job(),
  });
  assert.strictEqual(response.statusCode, 201);
  const body = JSON.parse(response.body);
  const jobId1 = body.id;
  const response2 = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  assert.strictEqual(response2.statusCode, 201);
  const body2 = JSON.parse(response2.body);
  const jobId2 = body2.id;
  assert.notStrictEqual(jobId1, jobId2);
  await app.close();
});

test("GET /jobs", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.items.length, 3);
  assert.strictEqual(body.limit, 20);
  assert.strictEqual(body.offset, 0);
  await app.close();
});

test("GET /jobs?company=acme", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?company=acme",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].company, "Acme");
  await app.close();
});

test("GET /jobs?q=engineer&location=remote", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?q=engineer&location=remote",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 2);
  await app.close();
});

test("GET /jobs?seniority=senior", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?seniority=senior",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 2); // Updated line
  await app.close();
});

test("GET /jobs?limit=2&offset=2", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?limit=2&offset=2",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.items.length, 1);
  await app.close();
});

test("GET /jobs?limit=0", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?limit=0",
  });
  assert.strictEqual(response.statusCode, 400);
  await app.close();
});

test("GET /jobs?limit=abc", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?limit=abc",
  });
  assert.strictEqual(response.statusCode, 400);
  await app.close();
});

test("GET /jobs?bogus=1", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?bogus=1",
  });
  assert.strictEqual(response.statusCode, 400);
  await app.close();
});

test("GET /jobs?q=%25", async (t) => {
  const app = buildApp({ db: openDb(":memory:") });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Backend Engineer", company: "Acme", source_url: "https://example.com/jobs/1" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Frontend Engineer", company: "Globex", source_url: "https://example.com/jobs/2", location: "Berlin", seniority: "mid" }),
  });
  await app.inject({
    method: "POST",
    url: "/jobs",
    payload: job({ title: "Data Engineer", company: "Initech", source_url: "https://example.com/jobs/3" }),
  });
  const response = await app.inject({
    method: "GET",
    url: "/jobs?q=%25",
  });
  assert.strictEqual(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.total, 0);
  await app.close();
});
