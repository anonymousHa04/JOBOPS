import { test } from "node:test";
import assert from "node:assert/strict";
import { withFocus } from "../src/tools.ts";
import { rewordPrompt } from "../src/tailor/reword.ts";
import { loadPrompt } from "../src/model/prompts.ts";
import { checkRewrite } from "../src/tailor/guard.ts";
import type { GuardCode } from "../src/tailor/guard.ts";
import type { Requirements } from "../src/requirements/schema.ts";

test("withFocus adds focus terms without duplicates", () => {
  const result = withFocus({ must_have: ["Kubernetes"] }, ["Go"]);
  assert.deepEqual(result.must_have, ["Kubernetes", "Go"]);
});

test("withFocus handles case-insensitive duplicates", () => {
  const result = withFocus({ must_have: ["Kubernetes"] }, ["kubernetes"]);
  assert.deepEqual(result.must_have, ["Kubernetes"]);
});

test("withFocus returns the same object if no focus terms are added", () => {
  const req = { must_have: ["Kubernetes"] };
  const result = withFocus(req);
  assert.equal(result, req);
});

const req = {
  role: "Backend Engineer",
  seniority: "senior",
  must_have: ["Go"],
  nice_to_have: [],
  keywords: [],
  themes: [],
  summary_variant: "backend"
} as Requirements;

test("rewordPrompt includes reviewer note if provided", () => {
  const bullet = { id: "b1", text: "Wrote a billing service", tags: [] };
  const allowed: string[] = [];
  const maxWords = 25;
  const codes: GuardCode[] = [];
  const note = "Say what improved";
  const promptWithNote = rewordPrompt(loadPrompt("select-and-tailor").template, req, bullet, allowed, maxWords, codes, note);
  assert.match(promptWithNote, /Reviewer note/);
});

test("rewordPrompt does not include reviewer note if not provided", () => {
  const bullet = { id: "b1", text: "Wrote a billing service", tags: [] };
  const allowed: string[] = [];
  const maxWords = 25;
  const codes: GuardCode[] = [];
  const promptWithoutNote = rewordPrompt(loadPrompt("select-and-tailor").template, req, bullet, allowed, maxWords, codes);
  assert.doesNotMatch(promptWithoutNote, /Reviewer note/);
});

test("checkRewrite detects added numbers", () => {
  const source = "Wrote a billing service";
  const rewrite = "Wrote 3 billing services";
  const opts = { vocab: new Set<string>(), allowed: [], maxWords: 25 };
  const codes = checkRewrite(source, rewrite, opts);
  assert.ok(codes.includes("number_added"), `codes: ${codes.join(", ")}`);
});
