/**
 * Per-content-type half-life defaults (Issue #1914).
 */

export type ContentTypeHalfLife = {
  halfLifeDays: number | null;
  baseline: number;
  accessReinforcementMax: number;
};

/** null halfLifeDays = infinite (no decay). */
export const CONTENT_TYPE_HALF_LIVES: Record<string, ContentTypeHalfLife> = {
  decision: { halfLifeDays: null, baseline: 0.85, accessReinforcementMax: 1 },
  preference: { halfLifeDays: null, baseline: 0.8, accessReinforcementMax: 1 },
  edict: { halfLifeDays: null, baseline: 0.95, accessReinforcementMax: 1 },
  hub: { halfLifeDays: null, baseline: 0.8, accessReinforcementMax: 1 },
  antipattern: { halfLifeDays: null, baseline: 0.75, accessReinforcementMax: 1 },
  problem: { halfLifeDays: 60, baseline: 0.75, accessReinforcementMax: 3 },
  milestone: { halfLifeDays: 60, baseline: 0.7, accessReinforcementMax: 3 },
  research: { halfLifeDays: 90, baseline: 0.7, accessReinforcementMax: 3 },
  project: { halfLifeDays: 120, baseline: 0.65, accessReinforcementMax: 3 },
  handoff: { halfLifeDays: 30, baseline: 0.6, accessReinforcementMax: 3 },
  conversation: { halfLifeDays: 45, baseline: 0.55, accessReinforcementMax: 3 },
  progress: { halfLifeDays: 45, baseline: 0.5, accessReinforcementMax: 3 },
  note: { halfLifeDays: 60, baseline: 0.5, accessReinforcementMax: 3 },
  diary: { halfLifeDays: 60, baseline: 0.5, accessReinforcementMax: 3 },
  fact: { halfLifeDays: 60, baseline: 0.5, accessReinforcementMax: 3 },
};

export function getHalfLifeForContentType(contentType: string | undefined): ContentTypeHalfLife {
  const key = (contentType ?? "fact").toLowerCase();
  return CONTENT_TYPE_HALF_LIVES[key] ?? CONTENT_TYPE_HALF_LIVES.fact;
}

/** Effective half-life with access reinforcement (up to 3×). */
export function effectiveHalfLifeDays(
  contentType: string | undefined,
  daysSinceAccess: number,
  recallCount: number,
): number | null {
  const spec = getHalfLifeForContentType(contentType);
  if (spec.halfLifeDays == null) return null;
  const accessFactor = Math.min(
    spec.accessReinforcementMax,
    1 + Math.min(recallCount, 10) * 0.1 * Math.max(0, 1 - daysSinceAccess / 90),
  );
  return spec.halfLifeDays * accessFactor;
}
