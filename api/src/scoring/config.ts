// Matching thresholds (user decisions, 2026-10-26; see M3-NOTES.md). Tune on real JDs.

export const WEIGHTS = { must: 60, nice: 20, keyword: 20 };

// Lower bound of each fit band; a score falls in the first band it reaches.
export const BANDS = [
  { band: "excellent", min: 95 },
  { band: "strong", min: 85 },
  { band: "moderate", min: 75 },
  { band: "poor", min: 60 },
  { band: "very_poor", min: 0 }
] as const;

export type Band = (typeof BANDS)[number]["band"];

// Only these bands get a tailored resume.
export const TAILORED_BANDS: readonly Band[] = ["excellent", "strong", "moderate"];

// Reuse an existing resume as is when content equivalence reaches this (percent).
export const REUSE_EQUIVALENCE = 95;

export function bandOf(score: number): Band {
  return (BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1]).band;
}
