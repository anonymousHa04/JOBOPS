import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import { vocabulary } from "../profile/bank.ts";
import type { Bank, Bullet, SkillsExtra } from "../profile/schema.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import type { Requirements } from "../requirements/schema.ts";
import { allBullets, bulletRecency, buildIndex, evidence, needsJudge, scoreRequirements } from "./score.ts";
import { TAILORED_BANDS } from "./config.ts";
import type { Verdict, Verdicts } from "./score.ts";
import { norm } from "./terms.ts";

// LLM judge for requirements the index cannot settle alone (engine-algorithm.md §2):
// qualified requirements ("production Kubernetes") are judged on the bullets the index
// found; index misses on the bullets that overlap the requirement most. One local model
// call per requirement (a few at once), skipped when the job's decision is already settled, cached by requirement + prompt version + bank hash, so scoring a
// stored record never calls the model again. Logs and results carry ids, never text.

// The judge's model, stored with each cached verdict (config/models.yaml, task "judge").
export const judgeModel = () => forTask("judge").model;
const MAX_CANDIDATES = 6;

const PROMPT = `You judge whether a candidate's resume bullets show one job requirement.

Requirement: [requirement]

Candidate bullets (id | text):
[bullets]

Rules:
- "supported": a bullet clearly shows the requirement, including any qualifier in it
  (for example "production", "led", "at scale", "owned"). Name those bullets.
- "partial": related or transferable evidence, but not the requirement as stated.
- "not_demonstrated": no bullet shows it. Do not guess.
- Use only the ids listed above. Judge only what the bullets say.

Return JSON: {"label": "supported" | "partial" | "not_demonstrated", "bullet_ids": [...]}`;

// Bump CANDIDATE_LOGIC when candidate selection changes: cached verdicts made with the
// old logic must not be reused (they are part of the cache key via this version).
const CANDIDATE_LOGIC = "v2: stems, recent high-impact fallback, always a model call";
export const JUDGE_PROMPT_VERSION = createHash("sha256").update(PROMPT + CANDIDATE_LOGIC).digest("hex").slice(0, 8);

const VerdictSchema = z.object({
  label: z.enum(["supported", "partial", "not_demonstrated"]),
  bullet_ids: z.array(z.string()).max(MAX_CANDIDATES)
});

export function bankHash(bank: Bank): string {
  const content = allBullets(bank).map((b) => [b.id, b.text, b.tags.join(",")]);
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

function cacheKey(requirement: string, hash: string): string {
  return createHash("sha256").update(`${requirement}|${JUDGE_PROMPT_VERSION}|${hash}`).digest("hex");
}

// Word stem for loose overlap: "mentorship", "mentored", "mentoring" -> "mento".
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 3).map(stem);

// Candidates for one requirement: index hits first; otherwise the bullets sharing the
// most word stems with it; otherwise the most recent, highest-impact bullets. The model
// always decides: an index miss is never turned into not_demonstrated without it.
function candidates(r: string, bullets: Bullet[], hits: string[], recency: Map<string, number>): Bullet[] {
  if (hits.length) return bullets.filter((b) => hits.includes(b.id)).slice(0, MAX_CANDIDATES);
  const want = new Set(words(r));
  const overlap = (b: Bullet) => words(`${b.text} ${b.tags.join(" ")}`).filter((w) => want.has(w)).length;
  const scored = bullets.map((b) => ({ b, n: overlap(b) })).filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || x.b.id.localeCompare(y.b.id));
  if (scored.length) return scored.slice(0, MAX_CANDIDATES).map((x) => x.b);
  const impact = { high: 3, medium: 2, low: 1 } as const;
  return [...bullets]
    .sort((x, y) => (recency.get(y.id) ?? 1) - (recency.get(x.id) ?? 1) || impact[y.impact] - impact[x.impact] || x.id.localeCompare(y.id))
    .slice(0, MAX_CANDIDATES);
}

export type JudgeStats = {
  needed: number; cached: number; judged: number; failed: number; error: string | null;
  // Why the judge did not run for this job (its decision is already settled), or null.
  skipped: string | null;
};

// Calls at once; the model server needs as many slots (llm.sh: LLM_GENERAL7_SLOTS).
const PARALLEL = Math.max(1, Number(process.env.JOBOPS_JUDGE_PARALLEL ?? 3));

export function loadVerdicts(db: Db, req: Requirements, bank: Bank, extra: SkillsExtra): Verdicts {
  const hash = bankHash(bank);
  const out: Verdicts = new Map();
  const get = db.prepare("SELECT label, bullet_ids FROM judge_cache WHERE key = ?");
  for (const r of needsJudge(req, bank, extra)) {
    const row = get.get(cacheKey(r, hash)) as { label: Verdict["label"]; bullet_ids: string } | undefined;
    if (row) out.set(r, { label: row.label, bullet_ids: JSON.parse(row.bullet_ids) as string[] });
  }
  return out;
}

// Judge every requirement that needs it, using the cache first. If the model server is
// unavailable, the remaining requirements keep their index-based labels and the error
// is reported, never hidden.
// Is the judge's answer able to change this job's decision? Not when the JD asks for more
// years than the roles add up to (not_tailored either way), nor when a "supported" on
// every open requirement still leaves the score below the tailorable bands.
export function judgeSettled(req: Requirements, bank: Bank, extra: SkillsExtra, verdicts: Verdicts, open: string[]): string | null {
  const now = scoreRequirements(req, bank, extra, undefined, undefined, verdicts);
  if (!now.hard.pass) return `years: JD asks ${now.hard.years_asked}+, roles add up to ${now.hard.years_have}`;
  const ids = allBullets(bank).map((b) => b.id);
  const best: Verdicts = new Map(verdicts);
  for (const r of open) best.set(r, { label: "supported", bullet_ids: ids });
  const top = scoreRequirements(req, bank, extra, undefined, undefined, best);
  if (!TAILORED_BANDS.includes(top.band)) return `best case ${top.score} (${top.band}) is below moderate`;
  return null;
}

export async function judgeRequirements(
  db: Db,
  req: Requirements,
  bank: Bank,
  extra: SkillsExtra
): Promise<{ verdicts: Verdicts; stats: JudgeStats }> {
  const hash = bankHash(bank);
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const bullets = allBullets(bank);
  const index = buildIndex(bullets, vocab);
  const recency = bulletRecency(bank);
  const verdicts = loadVerdicts(db, req, bank, extra);
  const todo = needsJudge(req, bank, extra);
  const open = todo.filter((r) => !verdicts.has(r));
  const stats: JudgeStats = { needed: todo.length, cached: verdicts.size, judged: 0, failed: 0, error: null, skipped: null };
  if (open.length === 0) return { verdicts, stats };
  stats.skipped = judgeSettled(req, bank, extra, verdicts, open);
  if (stats.skipped) return { verdicts, stats };

  const put = db.prepare(
    `INSERT OR REPLACE INTO judge_cache (key, requirement, label, bullet_ids, model, prompt_version, bank_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const judgeOne = async (r: string) => {
    if (stats.error) { stats.failed++; return; } // server down: do not retry for every requirement
    const cands = candidates(r, bullets, evidence(r, bullets, index, vocab), recency);
    let verdict: Verdict;
    if (cands.length === 0) {
      verdict = { label: "not_demonstrated", bullet_ids: [] }; // the bank has no bullets at all
    } else {
      const prompt = PROMPT.replace("[requirement]", r)
        .replace("[bullets]", cands.map((b) => `${b.id} | ${b.text}`).join("\n"));
      const res = await generate({ task: "judge", prompt, schema: VerdictSchema });
      if (!res.ok) {
        stats.failed++;
        stats.error = `${res.error}: ${res.detail}`;
        return;
      }
      const allowed = new Set(cands.map((b) => b.id));
      const ids = res.value.bullet_ids.filter((id) => allowed.has(id)); // drop invented ids
      verdict = res.value.label !== "not_demonstrated" && ids.length === 0
        ? { label: "not_demonstrated", bullet_ids: [] }
        : { label: res.value.label, bullet_ids: ids };
    }
    put.run(cacheKey(r, hash), r, verdict.label, JSON.stringify(verdict.bullet_ids), judgeModel(),
      JUDGE_PROMPT_VERSION, hash, new Date().toISOString());
    verdicts.set(r, verdict);
    stats.judged++;
  };
  // PARALLEL workers over the open requirements; the server serves them in its slots.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, open.length) }, async () => {
    while (next < open.length) await judgeOne(open[next++]);
  }));
  return { verdicts, stats };
}

// Requirements that still need a judge verdict (no model calls).
export function openRequirements(db: Db, req: Requirements, bank: Bank, extra: SkillsExtra): string[] {
  const verdicts = loadVerdicts(db, req, bank, extra);
  return needsJudge(req, bank, extra).filter((r) => !verdicts.has(r));
}

export function needsJudgeCount(db: Db, req: Requirements, bank: Bank, extra: SkillsExtra): number {
  return openRequirements(db, req, bank, extra).length;
}
