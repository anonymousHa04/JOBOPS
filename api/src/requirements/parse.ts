import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { forTask } from "../model/registry.ts";
import { fill, loadPrompt } from "../model/prompts.ts";
import { loadBank } from "../profile/bank.ts";
import { RequirementsSchema, StoredRequirementsSchema } from "./schema.ts";
import { canonicalKeywords } from "./canonical.ts";
import { findSeen, rememberSeen } from "./seen.ts";
import type { SeenVectors } from "./seen.ts";
import { vectorsOn } from "../vector/qdrant.ts";
import type { StoredRequirements } from "./schema.ts";

export type ParseSummary = {
  job_id: string;
  keywords: number;
  must_have: number;
  dropped_keywords: number;
  cached: boolean;
  reused_from?: string;
};

function summary(r: StoredRequirements, cached: boolean): ParseSummary {
  return {
    job_id: r.job_id,
    keywords: r.keywords.length,
    must_have: r.must_have.length,
    dropped_keywords: r.dropped_keywords.length,
    cached,
    ...(r.reused_from ? { reused_from: r.reused_from } : {})
  };
}

function readRow(db: Db, sql: string, ...args: string[]): StoredRequirements | null {
  const row = db.prepare(sql).get(...args) as { data: string } | undefined;
  return row ? StoredRequirementsSchema.parse(JSON.parse(row.data)) : null;
}

export function loadRequirements(db: Db, jobId: string): StoredRequirements | null {
  return readRow(db, "SELECT data FROM job_requirements WHERE job_id = ? ORDER BY created_at DESC LIMIT 1", jobId);
}

// Extract requirements from a stored job with the local model. Cached per prompt version.
export async function parseJob(db: Db, jobId: string): Promise<ParseSummary> {
  const job = db.prepare("SELECT title, company, description FROM jobs WHERE id = ?").get(jobId) as
    | { title: string; company: string; description: string }
    | undefined;
  if (!job) throw new Error("job not found");

  const { template, version } = loadPrompt("parse-job-descripton");
  const cached = readRow(db, "SELECT data FROM job_requirements WHERE job_id = ? AND prompt_version = ?", jobId, version);
  if (cached) return summary(cached, true);

  // Qdrant (optional): a repost of a JD parsed before reuses that parse. Vector errors never
  // stop the parse; only the message is printed, never the JD.
  const on = await vectorsOn();
  const text = { id: jobId, title: job.title, company: job.company, description: job.description };
  let seen: SeenVectors | null = null;
  if (on) {
    try {
      const s = await findSeen(text, version, (other) =>
        (db.prepare("SELECT description FROM jobs WHERE id = ?").get(other) as { description: string } | undefined)?.description ?? null);
      seen = s.vectors;
      const earlier = s.match ? readRow(db, "SELECT data FROM job_requirements WHERE job_id = ? AND prompt_version = ?", s.match, version) : null;
      if (earlier) {
        const copy: StoredRequirements = { ...earlier, job_id: jobId, reused_from: earlier.job_id, created_at: new Date().toISOString() };
        insert(db, copy);
        await rememberSeen(text, version, seen);
        return summary(copy, false);
      }
    } catch (err) {
      skipped(err);
    }
  }

  const variants = [...new Set(loadBank()?.summaries.map((s) => s.variant) ?? [])];
  const jdText = `${job.title}\n\n${job.description}`;
  const model = forTask("jd_parse").model;
  const result = await generate({
    task: "jd_parse",
    prompt: fill(template, {
      "paste JD": jdText,
      "list your variants": variants.length ? variants.join(", ") : "general"
    }),
    schema: RequirementsSchema
  });
  if (!result.ok) throw new Error(`model ${result.error}: ${result.detail}`);

  // ATS matching is literal: keep only keywords that appear in the JD text.
  const haystack = jdText.toLowerCase();
  let keywords = result.value.keywords.filter((k) => haystack.includes(k.toLowerCase()));
  const dropped = result.value.keywords.filter((k) => !haystack.includes(k.toLowerCase()));

  let renamed: Record<string, string> = {};
  if (on) {
    try {
      const c = await canonicalKeywords(keywords, jdText);
      keywords = c.keywords;
      renamed = c.renamed;
    } catch (err) {
      skipped(err);
    }
  }

  const stored: StoredRequirements = StoredRequirementsSchema.parse({
    ...result.value,
    keywords,
    ...(Object.keys(renamed).length ? { renamed_keywords: renamed } : {}),
    job_id: jobId,
    model,
    prompt_version: version,
    created_at: new Date().toISOString(),
    dropped_keywords: dropped
  });
  insert(db, stored);
  if (on && seen) {
    try {
      await rememberSeen(text, version, seen);
    } catch (err) {
      skipped(err);
    }
  }
  return summary(stored, false);
}

function insert(db: Db, r: StoredRequirements): void {
  db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, ?, ?, ?)").run(
    r.job_id,
    r.prompt_version,
    JSON.stringify(r),
    r.created_at
  );
}

const skipped = (err: unknown) => process.stderr.write(`vectors skipped: ${err instanceof Error ? err.message : String(err)}\n`);
