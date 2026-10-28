import { z } from 'zod';

// Define Bullet schema
export const BulletSchema = z.object({
  // <entry-id>-<n> from the resume, or <entry-id>-<topic> for bullets the user adds.
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)+$/),
  text: z.string(),
  short: z.string(),
  tags: z.array(z.string().toLowerCase()).min(1).max(12),
  impact: z.enum(['high', 'medium', 'low']),
  source: z.enum(['resume', 'user']).default('resume'),
  // For source: user, the user's answer the bullet is written from ("answer YYYY-MM-DD: ...").
  evidence: z.string().optional(),
});

// Define Entry schema
export const EntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string().optional(),
  location: z.string().optional(),
  dates: z.string(),
  // A career break sits in the timeline (it explains the gap) but is not employment:
  // it adds no years of experience and no tenure, and shows as one line without bullets.
  kind: z.enum(['job', 'break']).optional(),
  bullets: z.array(BulletSchema),
});

// Define BankSchema
export const BankSchema = z.object({
  basics: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    links: z.array(z.string()),
  }),
  summaries: z.array(z.object({
    id: z.string(),
    variant: z.string(),
    text: z.string(),
  })),
  roles: z.array(EntrySchema),
  projects: z.array(EntrySchema),
  education: z.array(z.object({
    id: z.string(),
    degree: z.string(),
    school: z.string(),
    dates: z.string(),
    details: z.array(z.string()),
  })),
  skills: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    tools: z.array(z.string()),
    domains: z.array(z.string()),
  }),
  approved: z.boolean().default(false),
  meta: z.object({
    model: z.string().optional(),
    prompt_version: z.string().optional(),
    created_at: z.string().optional(),
  }).optional(),
});

// Define SkillsExtraSchema
export const SkillsExtraSchema = z.object({
  skills: z.array(z.object({
    name: z.string().toLowerCase(),
    status: z.enum(['have', 'dont_have']),
    evidence: z.string().optional(),
    added_at: z.string(),
  })),
  dismissed: z.array(z.string()).default([]),
  // Learnable-skill answers, kept per JD so earlier answers can be shown again.
  learnable: z.array(z.object({
    skill: z.string().toLowerCase(),
    learnable: z.boolean(),
    job_id: z.string(),
    answered_at: z.string(),
  })).default([]),
});

// Define PreferencesSchema
export const PreferencesSchema = z.object({
  compensation: z.object({
    currency: z.string(),
    unit: z.string(),
    min: z.number(),
    target: z.number(),
    keep_if_unlisted: z.boolean(),
  }),
  roles: z.array(z.object({
    title: z.string(),
    aliases: z.array(z.string()).default([]),
    suggested: z.boolean().optional(),
  })),
  seniority: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  location: z.object({
    cities: z.array(z.string()),
    remote: z.boolean(),
    hybrid: z.boolean(),
    onsite: z.boolean(),
  }),
  visa_sponsorship_needed: z.boolean(),
  companies: z.object({
    include: z.array(z.object({
      name: z.string(),
      slug: z.string(),
      // careers: no job board API; jd-search crawls the slug (a careers page URL) in a browser.
      ats: z.enum(['auto', 'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'careers']),
    })),
    exclude: z.array(z.string()),
  }),
  tailoring: z.object({
    bullets_per_role: z.number().positive(),
    bullets_total: z.number().positive(),
    max_words: z.number().positive(),
  }),
});

// One tailored resume per JD (engine-algorithm.md §7): the YAML in profile/records/ is the
// source of truth; SQLite resume_records only indexes it. The original resume is the
// first record (decision "original").
export const ResumeRecordSchema = z.object({
  resume_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  jd_id: z.string(),
  source_resume_id: z.string().nullable(),
  created_at: z.string(),
  decision: z.enum(["original", "reuse", "adapt", "not_tailored"]),
  reason: z.string(),
  band: z.string().nullable(),
  score: z.number().min(0).max(100).nullable(),
  equivalence: z.number().min(0).max(100).nullable(),
  flags: z.object({
    unsupported_must_haves: z.array(z.string()),
    risks: z.array(z.string()),
  }),
  // Ids and statuses only, never the review text (engine-algorithm.md §4 step 9).
  review_findings: z.array(z.object({
    id: z.string(),
    status: z.enum(["addressed", "open", "needs_facts"]),
  })),
  changes: z.array(z.object({
    bullet_id: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    reason: z.string(),
  })),
  evidence_refs: z.array(z.object({
    requirement: z.string(),
    bullet_ids: z.array(z.string()),
  })),
  content: z.object({
    summary_variant: z.string(),
    summary_text: z.string(),
    bullets: z.array(z.object({ id: z.string(), entry_id: z.string(), text: z.string() })),
    skills: z.array(z.string()),
  }),
  hashes: z.object({ content: z.string(), bank: z.string(), engine: z.string() }),
  meta: z.object({
    model: z.string().optional(),
    prompt_version: z.string().optional(),
  }).optional(),
});

// Export types
export type Bank = z.infer<typeof BankSchema>;
export type Bullet = z.infer<typeof BulletSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type SkillsExtra = z.infer<typeof SkillsExtraSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type ResumeRecord = z.infer<typeof ResumeRecordSchema>;
