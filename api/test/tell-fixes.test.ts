// One-click plain wording for AI-tell words in a drafted bullet (2026-11-10): a fixed list,
// offered under the draft's red box; the guard checks the applied text again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftTellFixes, tellFixes } from "../src/tailor/tell-fixes.ts";
import { aiTellsIn } from "../src/tailor/writing.ts";

const DRAFT = "Managed multiple API calls and SSE events to track IoT device charging state, ensuring concurrent service operation.";

test("1: ', ensuring X' gets 'to keep' and a drop of the rider", () => {
  const f = tellFixes(DRAFT, ["ensuring"]);
  assert.deepEqual(f.map((x) => x.label), ["ensuring → to keep", 'drop ", ensuring …"']);
  assert.equal(f[1].text, "Managed multiple API calls and SSE events to track IoT device charging state.");
});

test("2: each listed word or phrase gets its replacement, keeping a capital first letter", () => {
  const f = tellFixes("Leveraged Kafka in order to build robust queues.", ["leveraged", "in order to", "robust"]);
  const by = Object.fromEntries(f.map((x) => [x.label, x.text]));
  assert.equal(by["leveraged → used"], "Used Kafka in order to build robust queues.");
  assert.equal(by["in order to → to"], "Leveraged Kafka to build robust queues.");
  assert.equal(by['drop "robust"'], "Leveraged Kafka in order to build queues.");
});

test("3: an applied fix is checked again: no AI-tell word is left, so nothing more is offered", () => {
  const first = draftTellFixes(DRAFT, "Handled multiple api calls and SSE events", aiTellsIn);
  assert.deepEqual(first.words, ["ensuring"]);
  for (const fix of first.fixes) {
    assert.deepEqual(aiTellsIn(fix.text), [], fix.label);
    assert.deepEqual(draftTellFixes(fix.text, "", aiTellsIn), { words: [], fixes: [] }, fix.label);
  }
  // A tell the user's own story uses is theirs: not flagged, no fix offered.
  assert.deepEqual(draftTellFixes("Leveraged Kafka.", "I leveraged Kafka", aiTellsIn).words, []);
});

test("4: a word not on the list gets no suggestion", () => {
  assert.deepEqual(tellFixes("Built queues for agents.", ["queues", "zzz"]), []);
  assert.deepEqual(tellFixes("Built queues.", ["ensuring"]), []); // no rider in the text
});
