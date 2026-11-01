import { ensureCollection, embed, query, cosine, upsert } from "../vector/qdrant.ts";

const COLLECTION = "jd_seen";
const SIMILAR = 0.97;

export type JobText = { id: string; title: string; company: string; description: string };
export type SeenVectors = { a: number[]; b: number[] };

// Lower case, every run of non letters/digits as one space.
const normTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Company boilerplate sits at the start and end of a JD: compare two chunks from the middle.
function chunks(text: string): [string, string] {
  const description = text.replace(/\s+/g, " ").trim();
  const L = description.length;
  if (L >= 2400) {
    const start = Math.floor(L * 0.25);
    const end = Math.floor(L * 0.55);
    return [description.slice(start, start + 1200), description.slice(end, end + 1200)];
  } else {
    const mid = Math.floor(L / 2);
    return [description.slice(0, mid), description.slice(mid)];
  }
}

export async function findSeen(job: JobText, promptVersion: string): Promise<{ match: string | null; vectors: SeenVectors }> {
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
    if (typeof other === "string" && other !== job.id && point.score >= SIMILAR && point.vector.b && cosine(b, point.vector.b) >= SIMILAR) {
      return { match: other, vectors: { a, b } };
    }
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
