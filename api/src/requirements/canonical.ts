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
  const seen = new Set<string>();

  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i];
    const v = vectors[i];

    const hits = await query(COLLECTION, "v", v, 1);
    const name = hits[0]?.payload.name as string;

    if (hits[0] && same(k, name, hits[0].score) && name !== k && hasTerm(jdText, name)) {
      renamed[k] = name;
      keywords[i] = name;
    } else if (!hits[0] || !same(k, name, hits[0].score)) {
      const id = pointId(norm(k));
      await upsert(COLLECTION, [{ id, vector: { v }, payload: { name: k } }]);
    }

    const normalized = norm(keywords[i]);
    if (seen.has(normalized)) {
      keywords.splice(i, 1);
      i--;
    } else {
      seen.add(normalized);
    }
  }

  return { keywords, renamed };
}
