import type { Db } from "../db.ts";
import { generate } from "../model/llm.ts";
import { fill, loadPrompt } from "../model/prompts.ts";
import { loadBank } from "../profile/bank.ts";
import { RequirementsSchema, StoredRequirementsSchema } from "./schema.ts";
import type { StoredRequirements } from "./schema.ts";

export type ParseSummary = {
  job_id: string;
  keywords: number;
  must_have: number;
  dropped_keywords: number;
  cached: boolean;
};

function summary(r: StoredRequirements, cached: boolean): ParseSummary {
  return {
    job_id: r.job_id,
    keywords: r.keywords.length,
    must_have: r.must_have.length,
    dropped_keywords: r.dropped_keywords.length,
    cached
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
  const job = db.prepare("SELECT title, description FROM jobs WHERE id = ?").get(jobId) as
    | { title: string; description: string }
    | undefined;
  if (!job) throw new Error("job not found");

  const { template, version } = loadPrompt("parse-job-descripton");
  const cached = readRow(db, "SELECT data FROM job_requirements WHERE job_id = ? AND prompt_version = ?", jobId, version);
  if (cached) return summary(cached, true);

  const variants = [...new Set(loadBank()?.summaries.map((s) => s.variant) ?? [])];
  const jdText = `${job.title}\n\n${job.description}`;
  const model = process.env.JOBOPS_JD_MODEL ?? "qwen2.5:7b";
  const result = await generate({
    model,
    prompt: fill(template, {
      "paste JD": jdText,
      "list your variants": variants.length ? variants.join(", ") : "general"
    }),
    schema: RequirementsSchema
  });
  if (!result.ok) throw new Error(`model ${result.error}: ${result.detail}`);

  // ATS matching is literal: keep only keywords that appear in the JD text.
  const haystack = jdText.toLowerCase();
  const keywords = result.value.keywords.filter((k) => haystack.includes(k.toLowerCase()));
  const dropped = result.value.keywords.filter((k) => !haystack.includes(k.toLowerCase()));

  const stored: StoredRequirements = StoredRequirementsSchema.parse({
    ...result.value,
    keywords,
    job_id: jobId,
    model,
    prompt_version: version,
    created_at: new Date().toISOString(),
    dropped_keywords: dropped
  });
  db.prepare("INSERT INTO job_requirements (job_id, prompt_version, data, created_at) VALUES (?, ?, ?, ?)").run(
    jobId,
    version,
    JSON.stringify(stored),
    stored.created_at
  );
  return summary(stored, false);
}
