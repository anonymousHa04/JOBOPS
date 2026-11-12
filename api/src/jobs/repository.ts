import { createHash, randomUUID } from "node:crypto";
import type { JobInput, Job, JobListQuery } from "./schema.ts";
import type { Db } from "../db.ts";

type JobRow = { id: string; content_hash: string; [column: string]: unknown };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

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

export type DeletedRow = { source_url: string; deleted_at: string; keywords: string[] };

export type JobRepository = {
  insert(input: JobInput): Job;
  getById(id: string): Job | undefined;
  upsert(input: JobInput): { job: Job; created: boolean };
  // The user deleted this posting earlier (same link or same content): callers skip upsert.
  isDeleted(input: JobInput): boolean;
  // The deleted_jobs rows that match this posting (the same rule as isDeleted), newest first.
  deletedRows(input: JobInput): DeletedRow[];
  // "Add it anyway": forget those rows so the posting can be added again. Returns rows removed.
  removeDeleted(input: JobInput): number;
  list(query: JobListQuery): { items: Job[]; total: number };
};

export function createJobRepository(db: Db): JobRepository {
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, title, company, description, source_url, source_name, location, employment_type, seniority, required_skills, preferred_skills, posted_at, first_seen_at, last_seen_at, content_hash)
    VALUES (@id, @title, @company, @description, @source_url, @source_name, @location, @employment_type, @seniority, @required_skills, @preferred_skills, @posted_at, @first_seen_at, @last_seen_at, @content_hash)
  `);
  const getByIdStmt = db.prepare(`
    SELECT * FROM jobs WHERE id = @id
  `);
  const findByUrlStmt = db.prepare(`
    SELECT * FROM jobs WHERE source_url = @source_url
  `);
  const findByHashStmt = db.prepare(`
    SELECT * FROM jobs WHERE content_hash = @content_hash ORDER BY first_seen_at LIMIT 1
  `);
  const deletedStmt = db.prepare(`
    SELECT 1 FROM deleted_jobs WHERE source_url = @source_url OR content_hash = @content_hash LIMIT 1
  `);
  const deletedRowsStmt = db.prepare(`
    SELECT source_url, deleted_at, keywords FROM deleted_jobs WHERE source_url = @source_url OR content_hash = @content_hash ORDER BY deleted_at DESC
  `);
  const removeDeletedStmt = db.prepare(`
    DELETE FROM deleted_jobs WHERE source_url = @source_url OR content_hash = @content_hash
  `);
  const touchStmt = db.prepare(`
    UPDATE jobs SET last_seen_at = @last_seen_at WHERE id = @id
  `);
  const updateStmt = db.prepare(`
    UPDATE jobs SET title = @title, company = @company, description = @description, source_name = @source_name, location = @location, employment_type = @employment_type, seniority = @seniority, required_skills = @required_skills, preferred_skills = @preferred_skills, posted_at = @posted_at, content_hash = @content_hash, last_seen_at = @last_seen_at WHERE id = @id
  `);

  const repo: JobRepository = {
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
    },
    isDeleted(input: JobInput): boolean {
      return !!deletedStmt.get({ source_url: input.source_url, content_hash: computeContentHash(input) });
    },
    deletedRows(input: JobInput): DeletedRow[] {
      const rows = deletedRowsStmt.all({ source_url: input.source_url, content_hash: computeContentHash(input) }) as
        { source_url: string; deleted_at: string; keywords: string | null }[];
      return rows.map((r) => {
        let keywords: string[] = [];
        try {
          const k = r.keywords ? JSON.parse(r.keywords) : [];
          if (Array.isArray(k)) keywords = k.filter((w): w is string => typeof w === "string");
        } catch {
          // Not JSON: no keywords to report.
        }
        return { source_url: r.source_url, deleted_at: r.deleted_at, keywords };
      });
    },
    removeDeleted(input: JobInput): number {
      return Number(removeDeletedStmt.run({ source_url: input.source_url, content_hash: computeContentHash(input) }).changes);
    },
    upsert(input: JobInput): { job: Job; created: boolean } {
      const now = new Date().toISOString();
      const contentHash = computeContentHash(input);

      return db.transaction(() => {
        const rowByUrl = findByUrlStmt.get({ source_url: input.source_url }) as JobRow | undefined;
        if (rowByUrl && rowByUrl.content_hash === contentHash) {
          touchStmt.run({ id: rowByUrl.id, last_seen_at: now });
          return { job: { ...rowToJob(rowByUrl), last_seen_at: now }, created: false };
        }
        if (rowByUrl) {
          const required_skills = JSON.stringify(input.required_skills);
          const preferred_skills = JSON.stringify(input.preferred_skills);
          const posted_at = input.posted_at ? input.posted_at : null;
          updateStmt.run({
            id: rowByUrl.id,
            title: input.title,
            company: input.company,
            description: input.description,
            source_name: input.source_name ? input.source_name : null,
            location: input.location ? input.location : null,
            employment_type: input.employment_type ? input.employment_type : null,
            seniority: input.seniority ? input.seniority : null,
            required_skills,
            preferred_skills,
            posted_at,
            content_hash: contentHash,
            last_seen_at: now
          });
          return { job: repo.getById(rowByUrl.id)!, created: false };
        }
        const rowByHash = findByHashStmt.get({ content_hash: contentHash }) as JobRow | undefined;
        if (rowByHash) {
          touchStmt.run({ id: rowByHash.id, last_seen_at: now });
          return { job: { ...rowToJob(rowByHash), last_seen_at: now }, created: false };
        }
        return { job: repo.insert(input), created: true };
      })();
    },
    list(query: JobListQuery): { items: Job[]; total: number } {
      const whereClauses: string[] = [];
      const params: Record<string, string> = {};

      if (query.company) {
        whereClauses.push(`lower(company) = lower(@company)`);
        params['company'] = query.company.toLowerCase();
      }
      if (query.q) {
        whereClauses.push(`lower(title) LIKE @q ESCAPE '\\'`);
        params['q'] = "%" + escapeLike(query.q.toLowerCase()) + "%";
      }
      if (query.location) {
        whereClauses.push(`lower(location) LIKE @location ESCAPE '\\'`);
        params['location'] = "%" + escapeLike(query.location.toLowerCase()) + "%";
      }
      if (query.seniority) {
        whereClauses.push(`seniority = @seniority`);
        params['seniority'] = query.seniority;
      }
      if (query.employment_type) {
        whereClauses.push(`employment_type = @employment_type`);
        params['employment_type'] = query.employment_type;
      }
      if (query.source_name) {
        whereClauses.push(`lower(source_name) = lower(@source_name)`);
        params['source_name'] = query.source_name.toLowerCase();
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const countStmt = db.prepare(`
        SELECT count(*) AS total FROM jobs ${whereClause}
      `);
      const total = (countStmt.get(params) as { total: number }).total;

      const listStmt = db.prepare(`
        SELECT * FROM jobs ${whereClause} ORDER BY last_seen_at DESC, id LIMIT @limit OFFSET @offset
      `);
      const rows = listStmt.all({ ...params, limit: query.limit, offset: query.offset });

      return { items: rows.map(rowToJob), total };
    }
  };

  return repo;
}
