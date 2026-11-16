// Which bullets may already show a gap's requirement: the few the gap help prompt carries, in
// place of the whole bank (that made each call ~1,770 tokens on the one-slot 14B).
// - Word match: the scoring engine's inverted index (exact names, tags, synonyms' vocabulary).
// - Meaning: Qdrant's nearest bullets (collection bank_bullets, mxbai-embed-large vectors), so
//   "infrastructure as code" finds a Terraform bullet. Re-embedded when the bullets change.
// Up to 3 word matches first, then the nearest bullets, then the rest of the word matches, at
// most MAX_RELATED. Qdrant down or nothing found: word matches only; none at all: the whole
// bank, as before (gap help never fails for want of Qdrant).
import { createHash } from "node:crypto";
import type { Bank, Bullet } from "../profile/schema.ts";
import { allBullets, buildIndex, evidence } from "../scoring/score.ts";
import { terms } from "../scoring/terms.ts";
import { deleteWhere, embed, ensureCollection, pointId, query, upsert, vectorsOn } from "../vector/qdrant.ts";

export const MAX_RELATED = 5;

// A gap's key in the queue (gap_help tasks carry it): short, stable, from the requirement.
export const gapKey = (requirement: string) => createHash("sha1").update(requirement).digest("hex").slice(0, 12);

// Nearest bullet ids for a requirement, best first.
export type VectorSearch = (bullets: Bullet[], requirement: string, k: number) => Promise<string[]>;

export type Related = { bullets: Bullet[]; source: "index" | "vector" | "both" | "all" };

export async function relatedBullets(bank: Bank, vocab: Set<string>, requirement: string, search: VectorSearch = qdrantSearch): Promise<Related> {
  const bullets = allBullets(bank);
  const byId = new Map(bullets.map((b) => [b.id, b]));
  // Word matches, the bullets with the most of the requirement's terms first.
  const want = terms(requirement, vocab);
  const index = buildIndex(bullets, vocab);
  const count = (id: string) => want.filter((t) => index.get(t)?.has(id)).length;
  const words = evidence(requirement, bullets, index, vocab).sort((a, b) => count(b) - count(a));
  let near: string[] = [];
  try {
    near = (await search(bullets, requirement, MAX_RELATED)).filter((id) => byId.has(id));
  } catch {
    // Qdrant or the embedding model is down: word matches only.
  }
  const ids = [...new Set([...words.slice(0, 3), ...near, ...words.slice(3)])].slice(0, MAX_RELATED);
  if (!ids.length) return { bullets, source: "all" };
  const source = !near.length ? "index" : !words.length ? "vector" : "both";
  return { bullets: ids.map((id) => byId.get(id)!), source };
}

const COLLECTION = process.env.JOBOPS_BANK_COLLECTION ?? "bank_bullets"; // a test uses its own
// mxbai-embed-large: a search query gets this prefix; the bullets (passages) do not.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
let synced = ""; // fingerprint of the bullets last stored in Qdrant by this process

async function qdrantSearch(bullets: Bullet[], requirement: string, k: number): Promise<string[]> {
  if (!(await vectorsOn())) throw new Error("vectors off");
  const fp = createHash("sha1").update(bullets.map((b) => `${b.id}|${b.text}`).join("\n")).digest("hex").slice(0, 16);
  const mine = { must: [{ key: "fp", match: { value: fp } }] };
  if (synced !== fp) {
    const vectors = await embed(bullets.map((b) => b.text));
    await ensureCollection(COLLECTION, { text: vectors[0].length });
    await upsert(COLLECTION, bullets.map((b, i) => ({ id: pointId(`${fp}|${b.id}`), vector: { text: vectors[i] }, payload: { bullet_id: b.id, fp } })));
    await deleteWhere(COLLECTION, { must_not: [{ key: "fp", match: { value: fp } }] }); // the old bank
    synced = fp;
  }
  const [q] = await embed([QUERY_PREFIX + requirement]);
  return (await query(COLLECTION, "text", q, k, mine)).map((p) => String(p.payload.bullet_id));
}
