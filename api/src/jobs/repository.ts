import { createHash, randomUUID } from "node:crypto";
import type { JobInput, Job } from "./schema.ts";
import type { Db } from "../db.ts";

export function computeContentHash(input: JobInput): string {
  const normalizedInput = {
    title: input.title.toLowerCase().trim().replace(/\s+/g, ' '),
    company: input.company.toLowerCase().trim().replace(/\s+/g, ' '),
    location: input.location ? input.location.toLowerCase().trim().replace(/\s+/g, ' ') : "",
    description: input.description.toLowerCase().trim().replace(/\s+/g, ' ')
  };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([normalizedInput.title, normalizedInput.company, normalizedInput.location, normalizedInput.description]));
  return hash.digest('hex');
}

function rowToJob(row: any): Job {
  const job: Job = {
    id: row.id,
    title: row.title,
    company: row.company,
    description: row.description,
    source_url: row.source_url,
    source_name: row.source_name ? row.source_name : undefined,
    location: row.location ? row.location : undefined,
    employment_type: row.employment_type ? row.employment_type : undefined,
    seniority: row.seniority ? row.seniority : undefined,
    required_skills: JSON.parse(row.required_skills),
    preferred_skills: JSON.parse(row.preferred_skills),
    posted_at: row.posted_at ? row.posted_at : undefined,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    content_hash: row.content_hash
  };
  return job;
}

export type JobRepository = {
  insert(input: JobInput): Job;
  getById(id: string): Job | undefined;
};

export function createJobRepository(db: Db): JobRepository {
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, title, company, description, source_url, source_name, location, employment_type, seniority, required_skills, preferred_skills, posted_at, first_seen_at, last_seen_at, content_hash)
    VALUES (@id, @title, @company, @description, @source_url, @source_name, @location, @employment_type, @seniority, @required_skills, @preferred_skills, @posted_at, @first_seen_at, @last_seen_at, @content_hash)
  `);
  const getByIdStmt = db.prepare(`
    SELECT * FROM jobs WHERE id = @id
  `);

  return {
    insert(input: JobInput): Job {
      const contentHash = computeContentHash(input);
      const id = randomUUID();
      const now = new Date().toISOString();
      const first_seen_at = now;
      const last_seen_at = now;
      const required_skills = JSON.stringify(input.required_skills);
      const preferred_skills = JSON.stringify(input.preferred_skills);
      const posted_at = input.posted_at ? input.posted_at : null;

      insertStmt.run({
        id,
        title: input.title,
        company: input.company,
        description: input.description,
        source_url: input.source_url,
        source_name: input.source_name ? input.source_name : null,
        location: input.location ? input.location : null,
        employment_type: input.employment_type ? input.employment_type : null,
        seniority: input.seniority ? input.seniority : null,
        required_skills,
        preferred_skills,
        posted_at,
        first_seen_at,
        last_seen_at,
        content_hash: contentHash
      });

      return {
        id,
        title: input.title,
        company: input.company,
        description: input.description,
        source_url: input.source_url,
        source_name: input.source_name,
        location: input.location,
        employment_type: input.employment_type,
        seniority: input.seniority,
        required_skills: input.required_skills,
        preferred_skills: input.preferred_skills,
        posted_at: input.posted_at,
        first_seen_at,
        last_seen_at,
        content_hash: contentHash
      };
    },
    getById(id: string): Job | undefined {
      const row = getByIdStmt.get({ id });
      if (row) {
        return rowToJob(row);
      }
      return undefined;
    }
  };
}
