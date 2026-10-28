import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Db } from "../db.ts";
import { ResumeRecordSchema } from "../profile/schema.ts";
import type { Bank, ResumeRecord } from "../profile/schema.ts";
import * as config from "../scoring/config.ts";
import { JUDGE_PROMPT_VERSION } from "../scoring/judge.ts";
import type { StoredRecord } from "./decide.ts";
import type { ResumeContent } from "./ideal.ts";

// Resume records (engine-algorithm.md §7): one YAML per JD in profile/records/, never
// overwritten. The YAML is the source of truth; SQLite resume_records is an index that
// can always be rebuilt from it. Hashes tell when a record no longer matches its content
// (hand-edited), the bank, or the engine that made it.

export const recordsDir = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "records");

// Bump when selection or decision logic changes in a way config does not show.
const ENGINE_LOGIC = "v1: ideal/equivalence/decide (engine-algorithm 4-5)";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// JSON with sorted keys, so the hash does not depend on key order in the YAML.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// Only what the resume shows counts: reword marks are working state, not content.
export function storedContent(c: ResumeContent): ResumeRecord["content"] {
  return {
    summary_variant: c.summary_variant,
    summary_text: c.summary_text,
    bullets: c.bullets.map((b) => ({ id: b.id, entry_id: b.entry_id, text: b.text })),
    skills: [...c.skills]
  };
}

export const contentHash = (c: ResumeRecord["content"] | ResumeContent) => sha(canonical(storedContent(c as ResumeContent)));
export const recordBankHash = (bank: Bank) => sha(canonical(bank));

// Config values (functions and regexes as source text), judge prompt, and logic version.
export function engineVersion(): string {
  const values = Object.entries(config).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, typeof v === "function" || v instanceof RegExp ? String(v) : v]);
  return sha(canonical(values) + JUDGE_PROMPT_VERSION + ENGINE_LOGIC).slice(0, 8);
}

// The original resume as the first record: every bullet in bank order, all skills,
// the first summary variant.
export function originalContent(bank: Bank): ResumeContent {
  const summary = bank.summaries[0];
  return {
    summary_variant: summary?.variant ?? "",
    summary_text: summary?.text ?? "",
    bullets: [...bank.roles, ...bank.projects].flatMap((e) =>
      e.bullets.map((b) => ({ id: b.id, entry_id: e.id, text: b.text, reword: null }))),
    skills: [...new Set(Object.values(bank.skills).flat())]
  };
}

export type NewRecord = Omit<ResumeRecord, "resume_id" | "created_at" | "content" | "hashes"> & { content: ResumeContent };

function index(db: Db, r: ResumeRecord, path: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO resume_records (resume_id, jd_id, path, source_resume_id, decision, band, score,
       equivalence, flags, content_hash, bank_hash, engine_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.resume_id, r.jd_id, path, r.source_resume_id, r.decision, r.band, r.score, r.equivalence,
    JSON.stringify(r.flags), r.hashes.content, r.hashes.bank, r.hashes.engine, r.created_at);
}

// Write a record and index it. The id is the JD plus the content hash, so the same
// content for the same JD is the same record: it is returned as is, never rewritten.
export function writeRecord(db: Db, bank: Bank, rec: NewRecord, now = new Date()): { record: ResumeRecord; path: string; created: boolean } {
  const content = storedContent(rec.content);
  const hashes = { content: contentHash(content), bank: recordBankHash(bank), engine: engineVersion() };
  const resume_id = rec.decision === "original" ? "original" : `${rec.jd_id}-${hashes.content.slice(0, 8)}`;
  const path = join(recordsDir(), `${resume_id}.yaml`);
  if (existsSync(path)) {
    const record = ResumeRecordSchema.parse(parse(readFileSync(path, "utf8")));
    index(db, record, path);
    return { record, path, created: false };
  }
  const record = ResumeRecordSchema.parse({ ...rec, resume_id, created_at: now.toISOString(), content, hashes });
  mkdirSync(recordsDir(), { recursive: true });
  writeFileSync(path, stringify(record), { flag: "wx" }); // fails rather than overwrite
  index(db, record, path);
  return { record, path, created: true };
}

export type RecordCheck = { resume_id: string; path: string; edited: boolean; stale_bank: boolean; stale_engine: boolean };

// Read every record from YAML (the truth), check its hashes, and rebuild the index.
// Hand-edited records are reported and left out of the index; stale ones stay in it
// with their old hashes so callers can decide to rescore them.
export function loadRecords(db: Db, bank: Bank): { records: ResumeRecord[]; checks: RecordCheck[] } {
  const dir = recordsDir();
  const records: ResumeRecord[] = [];
  const checks: RecordCheck[] = [];
  const bankHash = recordBankHash(bank);
  const engine = engineVersion();
  db.prepare("DELETE FROM resume_records").run();
  if (!existsSync(dir)) return { records, checks };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const path = join(dir, f);
    const r = ResumeRecordSchema.parse(parse(readFileSync(path, "utf8")));
    const check = { resume_id: r.resume_id, path, edited: contentHash(r.content) !== r.hashes.content,
      stale_bank: r.hashes.bank !== bankHash, stale_engine: r.hashes.engine !== engine };
    checks.push(check);
    if (check.edited) continue;
    records.push(r);
    index(db, r, path);
  }
  return { records, checks };
}

// What the engine compares against (decide.ts): content with no reword marks.
// A stored record as a starting point, with each bullet's text taken from the bank as it
// is now: a bullet edited in the bank since the record was made must not come back with
// its old text on reuse. A rewording stays only while the bank still has the text it was
// made from. Bullets no longer in the bank are dropped.
export const toStored = (r: ResumeRecord, bank: Bank): StoredRecord => {
  const current = new Map([...bank.roles, ...bank.projects].flatMap((e) => e.bullets.map((b) => [b.id, b.text] as const)));
  const bullets = r.content.bullets.flatMap((b) => {
    const now = current.get(b.id);
    if (now === undefined) return [];
    const reworded = r.changes.find((c) => c.bullet_id === b.id && c.to === b.text && c.from === now);
    return [{ ...b, text: reworded ? b.text : now, reword: null }];
  });
  return { resume_id: r.resume_id, content: { ...r.content, bullets } };
};
