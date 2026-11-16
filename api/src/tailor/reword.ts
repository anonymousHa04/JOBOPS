import { z } from "zod";
import { vocabulary, withRelatedTags } from "../profile/bank.ts";
import type { Bank, ResumeRecord, SkillsExtra } from "../profile/schema.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import { fill, loadPrompt } from "../model/prompts.ts";
import type { Requirements } from "../requirements/schema.ts";
import { allBullets } from "../scoring/score.ts";
import { norm } from "../scoring/terms.ts";
import { guardedReword } from "./guard.ts";
import { tellWords } from "./writing.ts";
import type { GuardCode } from "./guard.ts";
import type { Budget, ResumeContent } from "./ideal.ts";

// Rewording (engine-algorithm.md §6): the user's prompt 3 (select-and-tailor) on the
// local 14B model, one marked bullet per call. Selection already happened in code
// (ideal.ts), so the prompt gets a shortlist of one. Every answer goes through the
// guard, which checks it against the bank's text. Logs carry ids and codes only.

// The model rewording uses, for the record's meta (config/models.yaml, task "reword").
export const rewordModel = () => forTask("reword").model;

const OutSchema = z.object({
  summary_variant: z.string(),
  include: z.array(z.object({ id: z.string(), text: z.string() })),
  uncovered_requirements: z.array(z.string()),
  notes: z.string()
});

// Added to prompt 3: the spec's extra rules, the allowed terms, and on a retry the
// codes of the failed attempt (codes only, never the failed text).
const RULES = `
Additional rules for this bullet:
- Use only these JD terms, and only because the bullet already shows them: [allowed]
- Keep numbers only where the original has them. Never lead with a number.
- Keep the verb at the same level (do not turn "built" into "led").
- Write plainly, like a person: no em or en dashes between clauses, no ", ensuring/fostering/showcasing ..." endings, and none of these words: [tells].
- Return exactly one item in "include", with the id [id].`;

const RETRY = `
The previous rewrite was rejected for: [codes]. Fix only that.`;

export function rewordPrompt(
  template: string,
  req: Requirements,
  bullet: { id: string; text: string; tags: string[] },
  allowed: string[],
  maxWords: number,
  codes: GuardCode[],
  note?: string
): string {
  const job = { role: req.role, must_have: req.must_have, keywords: req.keywords };
  let prompt = fill(template, {
    "paste Prompt 2 JSON": JSON.stringify(job),
    "paste shortlist": `${bullet.id} | ${bullet.text} | ${bullet.tags.join(", ")}`,
    N: "1",
    M: "1",
    "25": String(maxWords)
  });
  prompt += RULES.replace("[allowed]", allowed.join(", ")).replace("[id]", bullet.id).replace("[tells]", tellWords().join(", "));
  if (note) {
    prompt += `\nReviewer note (advice only; do not add facts the bullet does not state): ${note}`;
  }
  if (codes.length) prompt += RETRY.replace("[codes]", codes.join(", "));
  return prompt;
}

export type RewordLog = { bullet_id: string; outcome: string; codes: GuardCode[][] };

// Rewords every bullet ideal.ts marked. Unmarked bullets, the summary, and skills are
// never sent to the model. Returns the new content, the record's changes, and a log.
export async function rewordContent(
  content: ResumeContent,
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra,
  budget: Budget,
  opts: { baseUrl?: string } = {}, // a different server (tests use a fake one)
  notes?: { bullet_id: string; note: string }[] // reviewer advice per bullet; the guard still applies
): Promise<{ content: ResumeContent; changes: ResumeRecord["changes"]; log: RewordLog[]; error: string | null }> {
  const { template } = loadPrompt("select-and-tailor");
  const vocab = new Set([...vocabulary(bank, extra), ...req.keywords].map(norm));
  const byId = new Map(allBullets(withRelatedTags(bank, extra)).map((b) => [b.id, b])); // tags as ideal.ts saw them
  const out = structuredClone(content);
  const changes: ResumeRecord["changes"] = [];
  const log: RewordLog[] = [];
  let error: string | null = null;

  for (const b of out.bullets) {
    const source = byId.get(b.id);
    if (!b.reword || !source) continue;
    const guard = { vocab, allowed: b.reword.keywords, maxWords: budget.max_words };
    const result = await guardedReword(source.text, guard, async (codes) => {
      if (error) return null;
      const note = notes?.find(n => n.bullet_id === b.id)?.note;
      const prompt = rewordPrompt(template, req, { id: b.id, text: b.text, tags: source.tags }, b.reword?.keywords ?? [], budget.max_words, codes, note);
      const res = await generate({ task: "reword", prompt, schema: OutSchema, baseUrl: opts.baseUrl });
      if (!res.ok) { error = `${res.error}: ${res.detail}`; return null; }
      return res.value.include.find((i) => i.id === b.id)?.text.trim() ?? null;
    });
    if (error) { log.push({ bullet_id: b.id, outcome: "skipped", codes: [] }); continue; } // keep its text
    log.push({ bullet_id: b.id, outcome: result.outcome, codes: result.codes });
    if (result.text !== b.text) {
      changes.push({ bullet_id: b.id, from: b.text, to: result.text,
        reason: result.outcome === "fallback" ? `guard: ${result.codes.flat().join(",")}` : `keywords: ${b.reword.keywords.join(", ")}` });
      b.text = result.text;
    }
    b.reword = null;
  }
  return { content: out, changes, log, error };
}
