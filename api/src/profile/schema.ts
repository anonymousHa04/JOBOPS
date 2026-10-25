import { z } from 'zod';

// Define Bullet schema
export const BulletSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+-\d+$/),
  text: z.string(),
  short: z.string(),
  tags: z.array(z.string().toLowerCase()).min(1).max(12),
  impact: z.enum(['high', 'medium', 'low']),
  source: z.enum(['resume', 'user']).default('resume'),
});

// Define Entry schema
export const EntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string().optional(),
  location: z.string().optional(),
  dates: z.string(),
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
      ats: z.enum(['auto', 'greenhouse', 'lever', 'ashby']),
    })),
    exclude: z.array(z.string()),
  }),
  tailoring: z.object({
    bullets_per_role: z.number().positive(),
    bullets_total: z.number().positive(),
    max_words: z.number().positive(),
  }),
});

// Define ResumeRecordSchema
export const ResumeRecordSchema = z.object({
  resume_id: z.string(),
  jd_id: z.string(),
  source_resume_id: z.string().nullable(),
  created_at: z.string(),
  jd_suitability_score: z.number().min(0).max(100),
  content_equivalence_score: z.number().min(0).max(100),
  decision: z.enum(['reuse', 'adapt', 'assemble']),
  flag_gaps: z.boolean(),
  gaps: z.array(z.string()),
  review: z.boolean(),
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
    sections: z.array(z.object({
      entry_id: z.string(),
      bullets: z.array(z.object({
        id: z.string(),
        text: z.string(),
      })),
    })),
  }),
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
