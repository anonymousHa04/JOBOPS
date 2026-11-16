// Reposts and near-copies of a JD already parsed, so its parse can be reused. Qdrant finds
// candidates (same company, title and prompt version, similar middle chunks); the full texts
// confirm. Measured on the stored jobs (2026-11-03): reposts have text overlap >= 0.99 and chunk
// scores 0.93-1.0; different jobs with the same title overlap <= 0.74 and score <= 0.89.
import { ensureCollection, embed, query, cosine, upsert } from "../vector/qdrant.ts";

const COLLECTION = "jd_seen";
const CANDIDATE = 0.9; // chunk similarity to look closer
const SAME_TEXT = 0.9; // word-shingle overlap of the full texts to count as the same JD

export type JobText = { id: string; title: string; company: string; description: string };
export type SeenVectors = { a: number[]; b: number[] };

// Lower case, every run of non letters/digits as one space.
const normTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Two chunks at fixed offsets past the usual company intro (text added at the end does not
// move them); a short JD is one chunk, used twice. 1200 characters fit the embedder's window.
function chunks(text: string): [string, string] {
  const d = text.replace(/\s+/g, " ").trim();
  return d.length >= 2400 ? [d.slice(600, 1800), d.slice(1800, 3000)] : [d.slice(0, 1200), d.slice(0, 1200)];
}

// Jaccard overlap of the texts' 3-word shingles: about 1 for a repost, far lower for another job.
export function textOverlap(x: string, y: string): number {
  const shingles = (t: string) => {
    const w = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return new Set(w.slice(0, Math.max(w.length - 2, 1)).map((_, i) => w.slice(i, i + 3).join(" ")));
  };
  const a = shingles(x), b = shingles(y);
  let both = 0;
  for (const s of a) if (b.has(s)) both++;
  return a.size + b.size ? both / (a.size + b.size - both) : 1;
}

// textOf gives an earlier job's description (from the jobs table) for the confirming check.
export async function findSeen(job: JobText, promptVersion: string, textOf: (jobId: string) => string | null): Promise<{ match: string | null; vectors: SeenVectors }> {
  await ensureCollection(COLLECTION, { a: 1024, b: 1024 });
  const [a, b] = await embed(chunks(job.description));
  const filter = {
    must: [
      { key: "company", match: { value: job.company } },
      { key: "title_norm", match: { value: normTitle(job.title) } },
      { key: "prompt_version", match: { value: promptVersion } }
    ]
  };
  const results = await query(COLLECTION, "a", a, 5, filter);
  for (const point of results) {
    const other = point.payload.job_id;
    if (typeof other !== "string" || other === job.id || point.score < CANDIDATE) continue;
    if (!point.vector.b || cosine(b, point.vector.b) < CANDIDATE) continue;
    const earlier = textOf(other);
    if (earlier !== null && textOverlap(job.description, earlier) >= SAME_TEXT) return { match: other, vectors: { a, b } };
  }
  return { match: null, vectors: { a, b } };
}

export async function rememberSeen(job: JobText, promptVersion: string, vectors: SeenVectors): Promise<void> {
  const point = {
    id: job.id,
    vector: vectors,
    payload: {
      job_id: job.id,
      company: job.company,
      title_norm: normTitle(job.title),
      prompt_version: promptVersion
    }
  };
  await upsert(COLLECTION, [point]);
}
