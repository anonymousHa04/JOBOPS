import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bank } from "./fixtures.ts";
import { saveBank } from "../src/profile/bank.ts";
import { draftBullet } from "../src/ui/gap-model.ts";

// Gaps "Draft a bullet" (user, 2026-11-08): the local model wrote "ensuring" and "adhering",
// the writing check blocked the draft (model_wording, ai_tell_added), and the retry only said
// "rejected for: model_wording", so it repeated them. Now the prompt lists the words to avoid,
// the retry names the words that failed, and a draft still blocked says which words to remove.
// Fake bank, fake model.

process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-draft-"));
process.env.JOBOPS_MODEL_LOG = join(process.env.JOBOPS_PROFILE_DIR, "model-calls.jsonl");
saveBank(bank);

const STORY = "Wrote unit and integration tests for the api, checked code quality with SonarQube";
const BAD = "Wrote unit and integration tests for the API, ensuring code quality with SonarQube";
const GOOD = "Wrote unit and integration tests for the API and checked code quality with SonarQube";

// Answers BAD until a prompt names "ensuring" as a word to avoid; then GOOD (or BAD forever).
async function fakeModel(learns: boolean) {
  const prompts: string[] = [];
  const server = createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
      prompts.push(prompt);
      const told = /do not use[^\n]*ensuring/i.test(prompt.split("rejected for")[1] ?? "");
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: learns && told ? GOOD : BAD, tags: ["testing"], skills: [] }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, prompts, close: () => server.close() };
}

const input = { requirement: "Testing", kind: "theme" as const, entry_id: "cur", story: STORY };

test("draft: the first prompt lists the words to avoid", async () => {
  const m = await fakeModel(true);
  try {
    await draftBullet(input, { baseUrl: m.url });
    assert.match(m.prompts[0], /ensuring/i, "the avoid-list is in the first prompt");
  } finally { m.close(); }
});

test("draft: the retry names the words that failed, and the fixed draft passes", async () => {
  const m = await fakeModel(true);
  try {
    const r = await draftBullet(input, { baseUrl: m.url });
    assert.equal(m.prompts.length, 2);
    assert.match(m.prompts[1].split("rejected for")[1] ?? "", /do not use[^\n]*ensuring/i);
    assert.deepEqual(r.codes, []);
    assert.equal(r.text, GOOD);
  } finally { m.close(); }
});

test("draft: a draft still blocked says which words to remove", async () => {
  const m = await fakeModel(false);
  try {
    const r = await draftBullet(input, { baseUrl: m.url });
    assert.ok(r.codes.length > 0);
    assert.deepEqual(r.words, ["ensuring"]);
  } finally { m.close(); }
});
