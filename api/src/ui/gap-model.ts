import { z } from "zod";
import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { loadBank, loadSkillsExtra, vocabulary } from "../profile/bank.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { bankHasTerm } from "../scoring/score.ts";
import { checkRewrite } from "../tailor/guard.ts";
import type { GuardCode } from "../tailor/guard.ts";
import { cachedHelp, saveHelp } from "./gaps.ts";
import { relatedBullets } from "./gap-related.ts";
import type { VectorSearch } from "./gap-related.ts";
import type { GapHelp, GapKind } from "./gaps.ts";

const MAX_WORDS = 25;
const KIND_LABEL: Record<GapKind, string> = { must: "must-have requirement", theme: "responsibility", nice: "nice-to-have", keyword: "keyword" };
const HelpSchema = z.object({
  meaning: z.string(),
  similar_terms: z.array(z.string()),
  related: z.array(z.object({ bullet_id: z.string(), why: z.string() })),
  questions: z.array(z.string())
});
const DraftSchema = z.object({ text: z.string(), tags: z.array(z.string()), skills: z.array(z.string()).default([]) });

export async function gapHelp(db: Db, jobId: string, kind: GapKind, requirement: string, opts: { refresh?: boolean; baseUrl?: string; search?: VectorSearch } = {}): Promise<GapHelp> {
  if (!opts.refresh) {
    const cached = cachedHelp(db, jobId, requirement);
    if (cached) return cached;
  }

  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");

  const role = loadRequirements(db, jobId)?.role ?? "";
  // Only the bullets that may show it (word match plus Qdrant's nearest), not the whole bank.
  const related = await relatedBullets(bank, vocabulary(bank, loadSkillsExtra()), requirement, opts.search);
  const list = related.bullets.map((b) => b.id + " | " + b.text).join("\n");

  const prompt = `
    A job (role: ${role}) asks for this ${KIND_LABEL[kind]}: "${requirement}".
    Help the candidate find out whether they already have it. Their resume bullets, one per line as "id | text":
    ${list}

    Return JSON with:
    - meaning: what the requirement means, in plain words a non-expert understands, at most 2 sentences.
    - similar_terms: other names, tools or practices that count as the same or close experience, at most 6.
    - related: bullets above that may already show it or something close, at most 3, each with its id exactly as given and one sentence on why. Only ids from the list; [] if none.
    - questions: at most 3 short questions that would bring out real experience of it: where they used it, what they did, what changed. Ask; never assume.
    Do not invent experience; only point at what the bullets say.
  `;

  const res = await generate({ task: "gap_help", prompt, schema: HelpSchema, baseUrl: opts.baseUrl });
  if (!res.ok) throw new Error("gap help: " + res.error);

  const ids = new Set(related.bullets.map((b) => b.id));
  const help: GapHelp = {
    meaning: res.value.meaning.trim().slice(0, 400),
    similar_terms: res.value.similar_terms.filter(term => term.trim() !== "").slice(0, 6),
    related: res.value.related.filter(item => ids.has(item.bullet_id)).map(item => ({
      bullet_id: item.bullet_id,
      why: item.why.trim().slice(0, 200)
    })).slice(0, 3),
    questions: res.value.questions.filter(question => question.trim() !== "").slice(0, 3)
  };

  saveHelp(db, jobId, kind, requirement, help);
  return help;
}

export async function draftBullet(input: { requirement: string; kind: GapKind; entry_id: string; story: string; proof?: string }, opts: { baseUrl?: string } = {}): Promise<{ text: string; tags: string[]; codes: GuardCode[]; skills: string[] }> {
  const bank = loadBank();
  if (!bank) throw new Error("no bank; run bank build first");

  const entry = [...bank.roles, ...bank.projects].find((e) => e.id === input.entry_id);
  if (!entry) throw new Error("unknown entry " + input.entry_id);

  const vocab = vocabulary(bank, loadSkillsExtra());
  const source = input.story + " " + (input.proof ?? "");

  const prompt = `
    Write one resume bullet from the candidate's own account below, for their role "${entry.title}"${entry.company ? ` at ${entry.company}` : ""}.
    It should show this job requirement: "${input.requirement}".
    Candidate's account: """${input.story}"""
    ${input.proof ? `Proof they mentioned: """${input.proof}"""` : ""}
    Rules:
    - Use only facts in the account: no new numbers, tools, team sizes or results.
    - A past-tense verb true to what they did (assisted < built < designed < led); never raise it.
    - Action, then what was built or decided, then scope or outcome. At most ${MAX_WORDS} words. Do not start with a number.
    - Plain words: no dashes between clauses, no ", ensuring ..." endings.
    - tags: 2 to 6 lowercase skill or topic words the bullet shows, including the requirement's key term.
    - skills: 0 to 6 tools, technologies or practices the account itself names, written exactly as
      in the account (for example a tool's name). Not the requirement itself, nothing the account does not say.
    Return JSON {"text": "...", "tags": ["..."], "skills": ["..."]}
  `;

  let res = await generate({ task: "gap_help", prompt, schema: DraftSchema, baseUrl: opts.baseUrl });
  if (!res.ok) throw new Error("draft: " + res.error);

  let text = res.value.text.trim().replace(/\s+/g, " ");
  let tags = res.value.tags.map(tag => tag.toLowerCase().trim()).filter(tag => tag !== "").slice(0, 6);
  if (input.kind === "keyword" && !tags.includes(input.requirement.toLowerCase())) {
    tags.unshift(input.requirement.toLowerCase());
  }

  // Suggested skills: only words the story really contains, not the requirement, not ones the
  // bank already has. The user ticks the ones to add.
  const extra = loadSkillsExtra();
  const story = input.story.toLowerCase();
  const named = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter((s) => s && story.includes(s.toLowerCase())
    && s.toLowerCase() !== input.requirement.toLowerCase() && !bankHasTerm(bank, extra, s)))].slice(0, 6);
  let skills = named(res.value.skills);

  let codes = checkRewrite(source, text, { vocab, allowed: [input.requirement], maxWords: MAX_WORDS });
  if (codes.length === 0) {
    return { text, tags, codes, skills };
  }

  const retryPrompt = `${prompt}\nThe previous draft was rejected for: ${codes.join(", ")}. Fix only that.`;
  res = await generate({ task: "gap_help", prompt: retryPrompt, schema: DraftSchema, baseUrl: opts.baseUrl });
  if (!res.ok) throw new Error("draft: " + res.error);

  text = res.value.text.trim().replace(/\s+/g, " ");
  tags = res.value.tags.map(tag => tag.toLowerCase().trim()).filter(tag => tag !== "").slice(0, 6);
  if (input.kind === "keyword" && !tags.includes(input.requirement.toLowerCase())) {
    tags.unshift(input.requirement.toLowerCase());
  }

  codes = checkRewrite(source, text, { vocab, allowed: [input.requirement], maxWords: MAX_WORDS });
  skills = named([...skills, ...res.value.skills]);
  return { text, tags, codes, skills };
}
