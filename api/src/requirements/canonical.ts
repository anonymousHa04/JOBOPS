// Same skill, same name across JDs. ATS matching stays literal: a keyword is renamed only to a
// canonical name that appears in the JD as a whole word (similarity alone merges siblings such
// as PostgreSQL and MySQL, so NEAR also needs whole-word containment).
import { embed, ensureCollection, upsert, query, pointId } from "../vector/qdrant.ts";
import { hasTerm, norm } from "../scoring/terms.ts";

const COLLECTION = "skills";
const SAME = 0.95;
const NEAR = 0.8;

function same(k: string, name: string, score: number): boolean {
  return score >= SAME || (score >= NEAR && (hasTerm(k, name) || hasTerm(name, k)));
}

export async function canonicalKeywords(keywords: string[], jdText: string): Promise<{ keywords: string[]; renamed: Record<string, string> }> {
  if (keywords.length === 0) {
    return { keywords, renamed: {} };
  }

  await ensureCollection(COLLECTION, { v: 1024 });
  const vectors = await embed(keywords);

  const renamed: Record<string, string> = {};
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i];
    const hits = await query(COLLECTION, "v", vectors[i], 1);
    const hit = hits[0];
    const name = typeof hit?.payload.name === "string" ? hit.payload.name : "";
    let use = k;
    if (hit && name && same(k, name, hit.score) && name !== k && hasTerm(jdText, name)) {
      use = name;
      renamed[k] = name;
    } else if (!hit || !name || !same(k, name, hit.score)) {
      await upsert(COLLECTION, [{ id: pointId(norm(k)), vector: { v: vectors[i] }, payload: { name: k } }]);
    }
    if (!seen.has(norm(use))) {
      seen.add(norm(use));
      out.push(use);
    }
  }
  return { keywords: out, renamed };
}
