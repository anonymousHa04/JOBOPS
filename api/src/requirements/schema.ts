import { z } from "zod";

const item = z.string().trim().min(1).max(120);
const items = z.array(item).max(40);

export const RequirementsSchema = z.object({
  role: z.string().trim().max(120),
  seniority: z.string().trim().max(120),
  must_have: items,
  nice_to_have: items,
  keywords: items,
  themes: items,
  summary_variant: z.string().trim().max(120)
});

export const StoredRequirementsSchema = RequirementsSchema.extend({
  job_id: z.string(),
  model: z.string(),
  prompt_version: z.string(),
  created_at: z.string(),
  dropped_keywords: z.array(z.string()),
  reused_from: z.string().optional(),
  renamed_keywords: z.record(z.string(), z.string()).optional()
});

export type Requirements = z.infer<typeof RequirementsSchema>;
export type StoredRequirements = z.infer<typeof StoredRequirementsSchema>;
