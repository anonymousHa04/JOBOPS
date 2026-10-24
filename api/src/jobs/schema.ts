import { z } from "zod";

const trimmedString = z.string().trim().min(1).max(100);
const trimmedStringArray = z.array(trimmedString).max(100);

export const JobInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(50000),
  source_url: z.url({ protocol: /^https?$/ }).max(2048),
  source_name: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().max(200).optional(),
  employment_type: z.enum([
    "full_time",
    "part_time",
    "contract",
    "internship",
    "temporary",
    "other"
  ]).optional(),
  seniority: z.enum([
    "intern",
    "junior",
    "mid",
    "senior",
    "staff",
    "principal",
    "lead",
    "manager",
    "director",
    "unknown"
  ]).optional(),
  required_skills: trimmedStringArray.default([]),
  preferred_skills: trimmedStringArray.default([]),
  posted_at: z.iso.datetime().optional()
}).strict();

export type JobInput = z.infer<typeof JobInputSchema>;
export type Job = JobInput & {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
  content_hash: string;
};

export const JobListQuerySchema = z.object({
  company: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().max(200).optional(),
  seniority: JobInputSchema.shape.seniority.unwrap().optional(),
  employment_type: JobInputSchema.shape.employment_type.unwrap().optional(),
  source_name: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

export type JobListQuery = z.infer<typeof JobListQuerySchema>;
