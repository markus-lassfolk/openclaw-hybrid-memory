/**
 * Unified composite score for Retrieval v2 (Issue #1910).
 *
 * composite = (search × ws + recency × wr + confidence × wc)
 *           × qualityMultiplier × lengthNorm × coActivationBoost
 *           + pinBoost + freqBoost
 */

import type { QueryIntent } from "./intent-classifier.js";

export type CompositeScoreInput = {
  searchScore: number;
  recencyScore: number;
  confidence: number;
  bodyLength: number;
  qualityScore?: number | null;
  coActivationBoost?: number;
  pinBoost?: number;
  freqBoost?: number;
  crossDomainBoost?: number;
  entityMatchBoost?: number;
  intent: QueryIntent;
  /** Focus topic match multiplier (Issue #1917). */
  focusMultiplier?: number;
};

export type IntentWeights = {
  search: number;
  recency: number;
  confidence: number;
};

const DEFAULT_WEIGHTS: Record<QueryIntent, IntentWeights> = {
  WHY: { search: 0.35, recency: 0.15, confidence: 0.5 },
  WHEN: { search: 0.3, recency: 0.5, confidence: 0.2 },
  ENTITY: { search: 0.4, recency: 0.2, confidence: 0.4 },
  WHAT: { search: 0.5, recency: 0.2, confidence: 0.3 },
  GENERAL: { search: 0.45, recency: 0.25, confidence: 0.3 },
};

export function getIntentWeights(intent: QueryIntent): IntentWeights {
  return DEFAULT_WEIGHTS[intent] ?? DEFAULT_WEIGHTS.GENERAL;
}

/** lengthNorm = max(0.3, 1 / (1 + 0.5 × log2(max(bodyLength/500, 1)))) */
export function computeLengthNorm(bodyLength: number): number {
  const ratio = Math.max(bodyLength / 500, 1);
  const norm = 1 / (1 + 0.5 * Math.log2(ratio));
  return Math.max(0.3, norm);
}

/** qualityMultiplier = 0.7 + 0.6 × quality_score (default quality 0.5 → 1.0) */
export function computeQualityMultiplier(qualityScore?: number | null): number {
  const q = qualityScore != null && Number.isFinite(qualityScore) ? Math.max(0, Math.min(1, qualityScore)) : 0.5;
  return 0.7 + 0.6 * q;
}

/**
 * freqBoost = min(0.10, log1p(freqSignal) × 0.03)
 * freqSignal = (revisions - 1) × 2 + (duplicates - 1)
 */
export function computeFrequencyBoost(revisions = 0, duplicates = 0): number {
  const freqSignal = Math.max(0, revisions - 1) * 2 + Math.max(0, duplicates - 1);
  return Math.min(0.1, Math.log1p(freqSignal) * 0.03);
}

export type CompositeScoreConfig = {
  version: 1 | 2;
  pinBoostDefault: number;
  pinBoostCap: number;
};

export const DEFAULT_COMPOSITE_SCORE_CONFIG: CompositeScoreConfig = {
  version: 1,
  pinBoostDefault: 0.3,
  pinBoostCap: 1.0,
};

/** Compute composite score v1 (legacy: search score only) or v2 (full formula). */
export function computeCompositeScore(
  input: CompositeScoreInput,
  config: CompositeScoreConfig = DEFAULT_COMPOSITE_SCORE_CONFIG,
): number {
  const weights = getIntentWeights(input.intent);
  const base =
    input.searchScore * weights.search + input.recencyScore * weights.recency + input.confidence * weights.confidence;

  if (config.version === 1) {
    return base;
  }

  const qualityMult = computeQualityMultiplier(input.qualityScore);
  const lengthNorm = computeLengthNorm(input.bodyLength);
  const coAct = input.coActivationBoost ?? 1;
  const pin = Math.min(config.pinBoostCap, input.pinBoost ?? 0);
  const freq = input.freqBoost ?? 0;
  const crossDomain = input.crossDomainBoost ?? 0;
  const entity = input.entityMatchBoost ?? 0;
  const focus = input.focusMultiplier ?? 1;

  return (base + entity) * qualityMult * lengthNorm * coAct * focus + pin + freq + crossDomain;
}

/** Recency score 0–1 from days since last access (newer = higher). */
export function recencyScoreFromDays(daysSinceAccess: number): number {
  if (!Number.isFinite(daysSinceAccess) || daysSinceAccess <= 0) return 1;
  return Math.max(0.1, 1 / (1 + daysSinceAccess / 30));
}

/** Sort items by composite score; returns new order with scores attached. */
export function rankByCompositeScore<T extends { id: string }>(
  items: T[],
  scoreFn: (item: T) => CompositeScoreInput,
  config: CompositeScoreConfig,
): Array<T & { compositeScore: number; compositeScoreV1: number }> {
  const v1Config = { ...config, version: 1 as const };
  const scored = items.map((item) => {
    const input = scoreFn(item);
    return {
      ...item,
      compositeScore: computeCompositeScore(input, config),
      compositeScoreV1: computeCompositeScore(input, v1Config),
    };
  });
  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}
