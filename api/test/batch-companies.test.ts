// Batch company view (.claude/specs/bt-04-api-retry-test.md): retry one company of a batch and
// turn skip words off for one batch. The queue server is a fake on 127.0.0.1 (port 0); the profile
// is a temp dir (JOBOPS_PROFILE_DIR), never the real profile/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadPreferences } from "../src/profile/bank.ts";
import { setup } from "./fixtures.ts";

const PREFS = `compensation: { currency: INR, unit: year, min: 1, target: 2, keep_if_unlisted: true }
roles:
  - title: SDE 3
    aliases: [SDE III]
seniority:
  include: [senior]
  exclude: [intern]
location: { cities: [Bengaluru], remote: true, hybrid: true, onsite: true }
visa_sponsorship_needed: false
companies:
  include: [{ name: Rippling, slug: rippling-old, ats: auto }]
  exclude: []
tailoring: { bullets_per_role: 4, bullets_total: 12, max_words: 25 }
skip_keywords: [sales, recruiter]
`;

const FETCHED = {
  name: "Rippling", board: "ashby", slug: "rippling", status: "fetched", error: "",
  postings: 3, matched: 1, created: 1, duplicates: 0, titles: ["SDE 3"]
};

type Seen = { method?: string; url?: string; body: unknown };
type Reply = { status: number; body: unknown };

async function withQueueUrl(url: string, fn: () => Promise<void>) {
  const old = process.env.JOBOPS_QUEUE_URL;
  process.env.JOBOPS_QUEUE_URL = url;
  try {
    await fn();
  } finally {
    old === undefined ? delete process.env.JOBOPS_QUEUE_URL : (process.env.JOBOPS_QUEUE_URL = old);
  }
}

// A fake queue server: records each request and answers with the current `reply`.
async function fakeQueue(reply: Reply) {
  const seen: Seen[] = [];
  const state = { reply };
  const server: Server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      seen.push({ method: rq.method, url: rq.url, body: JSON.parse(raw || "{}") });
      rs.statusCode = state.reply.status;
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify(state.reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, seen, state, url };
}

// The app from setup(), then a temp profile dir of our own with PREFS (setup() makes its own dir).
async function appWithPrefs(): Promise<{ app: FastifyInstance; prefsPath: string }> {
  const { app } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "jobops-batch-companies-"));
  process.env.JOBOPS_PROFILE_DIR = dir;
  const prefsPath = join(dir, "preferences.yaml");
  writeFileSync(prefsPath, PREFS);
  return { app, prefsPath };
}

test("retry saves the slug only after the search works", async () => {
  const q = await fakeQueue({ status: 200, body: FETCHED });
  const { app } = await appWithPrefs();
  try {
    const payload = { name: "Rippling", slug: "rippling", ats: "ashby" };
    await withQueueUrl(q.url, async () => {
      const res = await app.inject({ method: "POST", url: "/batches/7/companies/retry", payload });
      assert.equal(res.statusCode, 200);
      const saved = res.json().saved;
      assert.ok(Array.isArray(saved) && saved.length > 0, `saved should be non-empty: ${JSON.stringify(saved)}`);
    });
    assert.deepEqual(q.seen, [{ method: "POST", url: "/batches/7/companies/retry", body: payload }]);
    const rippling = loadPreferences().companies.include.find((c) => c.name === "Rippling");
    assert.equal(rippling?.slug, "rippling");
    assert.equal(rippling?.ats, "ashby");
  } finally {
    await app.close();
    q.server.close();
  }
});

test("a failed retry changes nothing", async () => {
  const q = await fakeQueue({ status: 200, body: {} });
  const { app, prefsPath } = await appWithPrefs();
  const retry = (payload: Record<string, string>) => app.inject({ method: "POST", url: "/batches/7/companies/retry", payload });
  try {
    await withQueueUrl(q.url, async () => {
      // (a) the search ran but found no board
      let before = readFileSync(prefsPath, "utf8");
      q.state.reply = { status: 200, body: { ...FETCHED, status: "unreachable", error: "no board found", postings: 0, matched: 0, created: 0, titles: [] } };
      let res = await retry({ name: "Rippling", slug: "rippling", ats: "ashby" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().saved, []);
      assert.equal(readFileSync(prefsPath, "utf8"), before);

      // (b) the queue itself failed
      before = readFileSync(prefsPath, "utf8");
      q.state.reply = { status: 502, body: { error: "jd-search failed" } };
      res = await retry({ name: "Rippling", slug: "rippling", ats: "ashby" });
      assert.equal(res.statusCode, 500);
      assert.equal(readFileSync(prefsPath, "utf8"), before);

      // (c) the search worked, but the request sent an empty slug
      before = readFileSync(prefsPath, "utf8");
      q.state.reply = { status: 200, body: FETCHED };
      res = await retry({ name: "Rippling", slug: "" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().saved, []);
      assert.equal(readFileSync(prefsPath, "utf8"), before);
    });
  } finally {
    await app.close();
    q.server.close();
  }
});

test("a batch can turn skip words off", async () => {
  const q = await fakeQueue({ status: 201, body: { batch_id: 9 } });
  const { app } = await appWithPrefs();
  try {
    await withQueueUrl(q.url, async () => {
      const res = await app.inject({ method: "POST", url: "/batches", payload: { limit: 3, unskip: ["java"] } });
      assert.equal(res.statusCode, 201);
      assert.equal(q.seen.length, 1);
      assert.equal(q.seen[0].method, "POST");
      assert.equal(q.seen[0].url, "/batches");
      const body = q.seen[0].body as { limit: number; parse_version: unknown; unskip: string[] };
      assert.equal(body.limit, 3);
      assert.equal(typeof body.parse_version, "string");
      assert.deepEqual(body.unskip, ["java"]);

      const bad = await app.inject({ method: "POST", url: "/batches", payload: { limit: 3, unskip: [""] } });
      assert.equal(bad.statusCode, 400);
      assert.equal(q.seen.length, 1, "bad input never reaches the queue");
    });
  } finally {
    await app.close();
    q.server.close();
  }
});
