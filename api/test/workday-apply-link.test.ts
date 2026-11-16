// Workday links shared from LinkedIn end in /apply (or /apply/...): the reader asks the
// Workday API for the job without it and stores the link without it. The network is stubbed:
// Workday and the queue server both go through globalThis.fetch. A temp profile dir from
// setup(); never the real profile/ or data/.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchJob } from "../src/jobs/from-url.ts";
import { addByLink } from "../src/ui/add-job.ts";
import { setEventSink } from "../src/log.ts";
import { setup } from "./fixtures.ts";

const QUEUE = "http://queue.test:8090";
process.env.JOBOPS_QUEUE_URL = QUEUE;

const VISA = "https://visa.wd5.myworkdayjobs.com/Visa/job/IN---Bengaluru-India/Sr-SW-Engineer_REF089562W";
const VISA_API = "https://visa.wd5.myworkdayjobs.com/wday/cxs/visa/Visa/job/IN---Bengaluru-India/Sr-SW-Engineer_REF089562W";
const SHARE = "?share_id=LinkedIn_corporate_page";
const POSTING = {
  jobPostingInfo: {
    title: "Sr SW Engineer",
    jobDescription: "<p>Responsibilities: build services.</p><p>Requirements: 5 years of experience with Java.</p>",
    location: "Bengaluru",
    startDate: "2026-11-01"
  }
};

const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  setEventSink({ info: () => {}, warn: () => {} });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(QUEUE)) return json(200, url.endsWith("/add") ? { batch_id: 1, stage: "parse" } : {});
    if (url.includes(".myworkdayjobs.com/wday/cxs/")) {
      calls.push(url);
      return json(200, POSTING);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setEventSink(null);
});

test("workday /apply: the API call and source_url drop /apply; the query string stays", async () => {
  const job = await fetchJob(`${VISA}/apply${SHARE}`);
  assert.deepEqual(calls, [VISA_API]);
  assert.equal(job.source_url, `${VISA}${SHARE}`);
  assert.equal(job.source_name, "workday");
});

test("workday /apply/autofillWithResume and /apply/: everything from /apply on is dropped", async () => {
  for (const tail of ["/apply/autofillWithResume", "/apply/"]) {
    calls = [];
    const job = await fetchJob(`${VISA}${tail}${SHARE}`);
    assert.deepEqual(calls, [VISA_API], tail);
    assert.equal(job.source_url, `${VISA}${SHARE}`, tail);
  }
});

test("workday link without /apply: source_url is the link unchanged (locale and query kept)", async () => {
  const link = "https://target.wd5.myworkdayjobs.com/en-US/targetcareers/job/Tower-02-Manyata-Embassy-Business-Park-Racenahali--Nagawara-Villages-Outer-Ring-Rd-Bangalore-540065/Sr-Engineer---Target-India_R0000453981?source=LinkedIn";
  const job = await fetchJob(link);
  assert.deepEqual(calls, ["https://target.wd5.myworkdayjobs.com/wday/cxs/target/targetcareers/job/Tower-02-Manyata-Embassy-Business-Park-Racenahali--Nagawara-Villages-Outer-Ring-Rd-Bangalore-540065/Sr-Engineer---Target-India_R0000453981"]);
  assert.equal(job.source_url, link);
});

test("workday: a location or title that only contains 'apply' is not touched", async () => {
  const link = "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Applyton-Office/Applying-ML-Engineer_R123";
  const job = await fetchJob(link);
  assert.deepEqual(calls, ["https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Applyton-Office/Applying-ML-Engineer_R123"]);
  assert.equal(job.source_url, link);
});

test("workday: the /apply link and the plain link are one job when added by link", async () => {
  const { app, db } = await setup();
  try {
    const first = await addByLink(db, `${VISA}/apply${SHARE}`);
    const second = await addByLink(db, `${VISA}${SHARE}`);
    assert.equal(first.created, true);
    assert.equal(second.created, false, "the plain link finds the job the /apply link added");
    assert.equal(second.job_id, first.job_id);
    const rows = db.prepare("SELECT source_url FROM jobs WHERE source_name = 'workday'").all() as { source_url: string }[];
    assert.deepEqual(rows.map((r) => r.source_url), [`${VISA}${SHARE}`]);
  } finally {
    await app.close();
  }
});

test("workday without a location segment: /job/<title>/apply drops /apply", async () => {
  const job = await fetchJob("https://visa.wd5.myworkdayjobs.com/Visa/job/Sr-SW-Engineer_REF089562W/apply?x=1");
  assert.deepEqual(calls, ["https://visa.wd5.myworkdayjobs.com/wday/cxs/visa/Visa/job/Sr-SW-Engineer_REF089562W"]);
  assert.equal(job.source_url, "https://visa.wd5.myworkdayjobs.com/Visa/job/Sr-SW-Engineer_REF089562W?x=1");
});
