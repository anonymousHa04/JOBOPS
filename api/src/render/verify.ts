// The verifier: the local 7B model lists each claim and quotes its source; verify-rules
// decides from those quotes. Any model failure blocks the record (verify_not_run).
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import type { Bank, ResumeRecord, SkillsExtra } from "../profile/schema.ts";
import { vocabulary } from "../profile/bank.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import { totalMonths } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import type { Issue } from "./parseback.ts";
import { claimIssues, linkedBulletIds, skillIssue } from "./verify-rules.ts";

export const VERIFY_PROMPT_VERSION = "verify-1";

const CLAIMS_PROMPT = "SOURCE (what the person wrote about their work): [source]\nTEXT (a resume line made from it): [text]\nList every claim the TEXT makes. For each, copy the exact words from SOURCE that support it. If SOURCE does not support a claim, give an empty quote.\nCopy each quote word for word from SOURCE; never write your own words. Answer only with JSON.";
const CLAIMS_SCHEMA = z.object({ claims: z.array(z.object({ claim: z.string(), quote: z.string() })) });

const SKILL_PROMPT = "EVIDENCE (what the person wrote): [evidence]\nSKILL: [skill]\nDoes the EVIDENCE show the person did this skill? Answer supported true or false, and copy the exact words from EVIDENCE that show it (empty if none).\nCopy the quote word for word from EVIDENCE; never write your own words. Answer only with JSON.";
const SKILL_SCHEMA = z.object({ supported: z.boolean(), quote: z.string() });

// synonyms audit (A8): never blocks a PDF by itself; the user decides every pair not "same".
const SYNONYM_PROMPT = "PAIR: \"[alias]\" is listed as another name for \"[term]\".\nIn a resume or a job description, do the two name the same thing (a spelling, abbreviation or alias of each other), related things (they overlap, but having one does not mean having the other), or different things?\nAnswer kind same, related or different, and a reason in one line. Answer only with JSON.";
const SYNONYM_SCHEMA = z.object({ kind: z.enum(["same", "related", "different"]), reason: z.string() });
export type SynonymKind = z.infer<typeof SYNONYM_SCHEMA>;

// Fill a [name] slot. A function replacer, so "$" in resume text is kept as written.
const fill = (prompt: string, slot: string, value: string) => prompt.replace(`[${slot}]`, () => value);

async function ask<T>(db: Db, kind: string, prompt: string, schema: z.ZodType<T>, baseUrl?: string): Promise<T> {
  const model = forTask("verify").model;
  const key = createHash("sha256")
    .update(kind + "\n" + VERIFY_PROMPT_VERSION + "\n" + model + "\n" + prompt)
    .digest("hex");

  const row = db.prepare("SELECT answer FROM verify_cache WHERE key = ?").get(key) as { answer: string } | undefined;
  if (row) return schema.parse(JSON.parse(row.answer));

  const result = await generate({ task: "verify", prompt, schema, baseUrl });
  if (!result.ok) throw new Error(result.error);

  db.prepare(
    "INSERT OR REPLACE INTO verify_cache (key, kind, answer, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, kind, JSON.stringify(result.value), result.model, VERIFY_PROMPT_VERSION, new Date().toISOString());
  return result.value;
}

// One reworded line against its source: the model lists claims with quotes, claimIssues decides.
// Throws when the model did not answer (the caller fails closed).
export async function checkClaims(db: Db, id: string, text: string, source: string, vocab: Set<string>, baseUrl?: string, kind = "claims"): Promise<Issue[]> {
  const answer = await ask(db, kind, fill(fill(CLAIMS_PROMPT, "source", source), "text", text), CLAIMS_SCHEMA, baseUrl);
  return claimIssues(id, text, source, answer.claims, vocab);
}

// summary_claims: the summary against the whole bank's bullets (text and evidence, roles and
// projects). Cache kind "summary"; detail "summary". Two derived kinds of line, since "7+ years"
// can never be quoted from a bullet: "Total experience: N years" (whole years of the jobs' dates,
// career breaks left out, "Present" = today) and one "Title at Company, dates" line per job.
export function summarySource(bank: Bank, now = new Date()): string {
  const jobs = bank.roles.filter((r) => r.kind !== "break");
  return [
    `Total experience: ${Math.floor(totalMonths(bank, now) / 12)} years`,
    ...jobs.map((r) => `${r.title}${r.company ? ` at ${r.company}` : ""}, ${r.dates}`),
    ...[...bank.roles, ...bank.projects].flatMap((e) => e.bullets).map((b) => b.text + "\n" + (b.evidence ?? ""))
  ].join("\n");
}
export const checkSummaryText = (db: Db, text: string, source: string, vocab: Set<string>, baseUrl?: string) =>
  checkClaims(db, "summary", text, source, vocab, baseUrl, "summary");

// The record's summary; fails closed on its own (verify_not_run, detail "summary").
export async function checkSummary(db: Db, record: ResumeRecord, bank: Bank, extra: SkillsExtra, opts: { baseUrl?: string } = {}): Promise<Issue[]> {
  try {
    return await checkSummaryText(db, record.content.summary_text, summarySource(bank), vocabulary(bank, extra), opts.baseUrl);
  } catch {
    return [{ code: "verify_not_run", extractor: "verifier", detail: "summary" }];
  }
}

// One skills-line skill against its evidence: the model quotes, skillIssue decides. Throws like checkClaims.
export async function checkSkill(db: Db, index: number, skill: string, evidence: string, baseUrl?: string): Promise<Issue[]> {
  const answer = await ask(db, "skill", fill(fill(SKILL_PROMPT, "evidence", evidence), "skill", skill), SKILL_SCHEMA, baseUrl);
  return skillIssue(index, answer.supported, answer.quote, evidence);
}

// A skill's evidence: the skills-extra answer plus the text of every bank bullet it links.
export function skillEvidence(answer: string, bankText: (id: string) => string | undefined): string {
  const linked = linkedBulletIds(answer).map(bankText).filter((t) => t !== undefined);
  return [answer, ...linked].join("\n");
}

// synonyms audit: same | related | different for one "alias: term" pair. Throws like checkClaims.
export async function classifySynonym(db: Db, alias: string, term: string, baseUrl?: string): Promise<SynonymKind> {
  return ask(db, "synonym", fill(fill(SYNONYM_PROMPT, "alias", alias), "term", term), SYNONYM_SCHEMA, baseUrl);
}

export async function verifyRecord(db: Db, record: ResumeRecord, bank: Bank, extra: SkillsExtra, opts: { baseUrl?: string } = {}): Promise<Issue[]> {
  const issues: Issue[] = [];
  const bankBullets = new Map([...bank.roles, ...bank.projects].flatMap(e => e.bullets).map(b => [b.id, b]));
  const vocab = vocabulary(bank, extra);
  let kind = "claims";
  try {
    // Reworded bullets: the record text differs from the bank bullet with the same id.
    for (const b of record.content.bullets) {
      const orig = bankBullets.get(b.id);
      if (!orig || orig.text === b.text) continue;
      issues.push(...await checkClaims(db, b.id, b.text, orig.text + "\n" + (orig.evidence ?? ""), vocab, opts.baseUrl));
    }

    // Skills the bank lacks that the user said they have (skills-extra).
    kind = "skill";
    const bankSkills = new Set(Object.values(bank.skills).flat().map(norm));
    for (const [i, skill] of record.content.skills.entries()) {
      if (bankSkills.has(norm(skill))) continue;
      const x = extra.skills.find(s => norm(s.name) === norm(skill) && s.status === "have");
      if (!x) continue;
      const evidence = skillEvidence(x.evidence ?? "", (id) => bankBullets.get(id)?.text);
      issues.push(...await checkSkill(db, i, skill, evidence, opts.baseUrl));
    }
  } catch {
    return [{ code: "verify_not_run", extractor: "verifier", detail: kind }];
  }
  if (record.content.summary_text.trim()) {
    const summary = await checkSummary(db, record, bank, extra, opts);
    if (summary.some((i) => i.code === "verify_not_run")) return summary;
    issues.push(...summary);
  }
  return issues;
}

// verify eval (A4): known-good and known-bad items through the same prompts and rules.
export const EvalCases = z.object({
  cases: z.array(z.discriminatedUnion("kind", [
    z.object({ id: z.string(), kind: z.literal("claims"), source: z.string(), text: z.string(), expect: z.enum(["pass", "block"]) }),
    z.object({ id: z.string(), kind: z.literal("skill"), evidence: z.string(), skill: z.string(), expect: z.enum(["pass", "block"]) }),
    z.object({ id: z.string(), kind: z.literal("summary"), source: z.string(), text: z.string(), expect: z.enum(["pass", "block"]) })
  ]))
});
export type EvalCase = z.infer<typeof EvalCases>["cases"][number];

export type EvalResult = {
  model: string;
  model_down: boolean;
  cases: { id: string; kind: string; expect: "pass" | "block"; got: "pass" | "block" | "not_run"; codes: string[] }[];
  false_passes: string[];
  false_blocks: string[];
  a4: { holds: boolean; false_passes: number; good_passed: number; good_total: number; good_pct: number };
  exit_code: 0 | 1;
};

// A model that is down or times out stops the run (model_down); an answer that does not parse
// counts as not_run, which blocks. A4 holds with 0 false passes and >= 80% of good items passed.
export async function verifyEval(db: Db, cases: EvalCase[], vocab: Set<string>, bankText: (id: string) => string | undefined, opts: { baseUrl?: string } = {}): Promise<EvalResult> {
  const out: EvalResult["cases"] = [];
  let modelDown = false;
  for (const c of cases) {
    let codes: string[];
    try {
      const issues = c.kind === "claims" ? await checkClaims(db, c.id, c.text, c.source, vocab, opts.baseUrl)
        : c.kind === "summary" ? await checkSummaryText(db, c.text, c.source, vocab, opts.baseUrl)
        : await checkSkill(db, 0, c.skill, skillEvidence(c.evidence, bankText), opts.baseUrl);
      codes = issues.map((i) => i.code);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (why === "unavailable" || why === "timeout") { modelDown = true; break; }
      codes = ["verify_not_run"];
    }
    const got = codes.includes("verify_not_run") ? "not_run" : codes.length ? "block" : "pass";
    out.push({ id: c.id, kind: c.kind, expect: c.expect, got, codes });
  }
  const falsePasses = out.filter((c) => c.expect === "block" && c.got === "pass").map((c) => c.id);
  const falseBlocks = out.filter((c) => c.expect === "pass" && c.got !== "pass").map((c) => c.id);
  const goodTotal = cases.filter((c) => c.expect === "pass").length;
  const goodPassed = out.filter((c) => c.expect === "pass" && c.got === "pass").length;
  const pct = goodTotal ? Math.round((goodPassed / goodTotal) * 1000) / 10 : 100;
  const holds = !modelDown && falsePasses.length === 0 && goodPassed * 10 >= goodTotal * 8;
  return {
    model: forTask("verify").model, model_down: modelDown, cases: out,
    false_passes: falsePasses, false_blocks: falseBlocks,
    a4: { holds, false_passes: falsePasses.length, good_passed: goodPassed, good_total: goodTotal, good_pct: pct },
    exit_code: holds ? 0 : 1
  };
}
