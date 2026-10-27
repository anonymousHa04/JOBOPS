// Matching configuration. Values come from the m3-notes skill
// (.agents/skills/m3-notes/references/engine-algorithm.md §3); they are starting
// points to calibrate on real JDs, so they live here and nowhere else.

// Points per part of the score; a part with no requirements gives its points to the
// others in proportion.
export const PARTS = { must: 55, resp: 15, nice: 10, keywords: 20 } as const;
export type Part = keyof typeof PARTS;

// Credit per requirement label (times recency of the best evidence).
export const CREDIT = {
  supported_metric: 0.9,
  supported: 0.85,
  partial: 0.5,
  skill_list_only: 0.3,
  learnable: 0,
  not_demonstrated: 0,
  unknown: 0
} as const;

// Recency of a bullet's role or project: current or ended within 12 months 1.0,
// within 36 months 0.9, older 0.75.
export function recency(monthsSinceEnd: number): number {
  return monthsSinceEnd <= 12 ? 1 : monthsSinceEnd <= 36 ? 0.9 : 0.75;
}

// Literal keyword hits: keywords that also appear in a must-have count double.
export const MUST_KEYWORD_WEIGHT = 2;

// A must-have is missing when its credit is below this. One missing caps the score,
// two or more cap it lower.
export const MUST_MISSING_BELOW = 0.5;
export const CAP_ONE_MISSING = 84.9;
export const CAP_TWO_MISSING = 74.9;

// Words that make a requirement need judgement beyond a term match ("production
// Kubernetes", "led a team"): the index finds candidates, a judge decides.
export const QUALIFIERS = /\b(production|prod|at scale|large[- ]scale|led|lead|leading|owned|ownership|architect(ed|ing)?)\b/i;

// Lower bound of each fit band; a score falls in the first band it reaches.
export const BANDS = [
  { band: "excellent", min: 95 },
  { band: "strong", min: 85 },
  { band: "moderate", min: 75 },
  { band: "poor", min: 60 },
  { band: "very_poor", min: 0 }
] as const;

export type Band = (typeof BANDS)[number]["band"];

// Only these bands get a tailored resume (and only when the years gate passes).
export const TAILORED_BANDS: readonly Band[] = ["excellent", "strong", "moderate"];

// Reuse an existing resume as is when content equivalence reaches this (percent).
export const REUSE_EQUIVALENCE = 95;

export function bandOf(score: number): Band {
  return (BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1]).band;
}
