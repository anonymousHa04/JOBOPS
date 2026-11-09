// Qdrant (REST, 1.19) and the local embedding server (llm.sh embed, mxbai-embed-large).
// Optional: with QDRANT_URL unset (tests never set it) every caller skips the vector steps.
import { createHash } from "node:crypto";

const qdrantUrl = () => process.env.QDRANT_URL;
const embedUrl = () => process.env.LLM_EMBED_URL ?? "http://127.0.0.1:8082/v1";

export type Point = { id: string; score: number; payload: Record<string, unknown>; vector: Record<string, number[]> };

export async function vectorsOn(): Promise<boolean> {
  if (!qdrantUrl()) return false;
  try {
    const [q, e] = await Promise.all([
      fetch(`${qdrantUrl()}/collections`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${embedUrl()}/models`, { signal: AbortSignal.timeout(2000) })
    ]);
    return q.ok && e.ok;
  } catch {
    return false;
  }
}

async function call(method: string, path: string, body?: unknown, timeoutMs = 5000): Promise<Response> {
  return fetch(`${qdrantUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

// Embeddings in input order, at most 16 texts per request.
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const res = await fetch(`${embedUrl()}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts.slice(i, i + 16), model: "mxbai-embed-large" }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`embed: status ${res.status}`);
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    out.push(...[...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

const checked = new Set<string>();

export async function ensureCollection(name: string, vectors: Record<string, number>): Promise<void> {
  if (checked.has(name)) return;
  const res = await call("GET", `/collections/${name}`);
  if (res.status === 404) {
    const spec = Object.fromEntries(Object.entries(vectors).map(([v, size]) => [v, { size, distance: "Cosine" }]));
    const made = await call("PUT", `/collections/${name}`, { vectors: spec });
    if (!made.ok) throw new Error(`qdrant create ${name}: status ${made.status}`);
  } else if (!res.ok) {
    throw new Error(`qdrant ${name}: status ${res.status}`);
  }
  checked.add(name);
}

export async function upsert(name: string, points: { id: string; vector: Record<string, number[]>; payload: Record<string, unknown> }[]): Promise<void> {
  const res = await call("PUT", `/collections/${name}/points?wait=true`, { points });
  if (!res.ok) throw new Error(`qdrant upsert ${name}: status ${res.status}`);
}

// Delete every point that matches a filter (stale copies of a changed bank).
export async function deleteWhere(name: string, filter: unknown): Promise<void> {
  const res = await call("POST", `/collections/${name}/points/delete?wait=true`, { filter });
  if (!res.ok) throw new Error(`qdrant delete ${name}: status ${res.status}`);
}

export async function query(name: string, using: string, vector: number[], limit: number, filter?: unknown): Promise<Point[]> {
  const res = await call("POST", `/collections/${name}/points/query`,
    { query: vector, using, limit, ...(filter === undefined ? {} : { filter }), with_payload: true, with_vector: true });
  if (!res.ok) throw new Error(`qdrant query ${name}: status ${res.status}`);
  const data = (await res.json()) as { result: { points: Point[] } };
  return data.result.points.map((p) => ({ ...p, id: String(p.id), payload: p.payload ?? {}, vector: p.vector ?? {} }));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Qdrant ids must be UUIDs or integers: a UUID-shaped sha1 of the text.
export function pointId(text: string): string {
  const h = createHash("sha1").update(text).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
