/**
 * A/B arm configs for the composite-score v1 vs v2(+MMR) comparison (living-memory B3).
 * The measured flip criterion (owner decision 2026-07-11): flip defaults ON only when arm B
 * scores ≥ arm A on BOTH nDCG@10 and P@5 over the deterministic gold set (R@10 is saturated
 * at 1.0 in this fixture and carries no signal).
 */
import type { RetrievalV2Config } from "../../services/retrieval-v2.js";

const COMMON = {
  intentRouter: { enabled: true, llmRefinement: false, heuristicThreshold: 0.8 },
  bypass: { enabled: false, bm25MinScore: 0.85, bm25MinGap: 0.15 },
};

/** Arm A: shipped v1 baseline (composite v1, diversity off). */
export const ARM_A: RetrievalV2Config = {
  ...COMMON,
  compositeScore: { version: 1, pinBoostDefault: 0.3, pinBoostCap: 1.0 },
  diversity: { enabled: false, maxSimilarity: 0.6 },
};

/** Arm B: staged candidate (composite v2 + MMR diversity, λ 0.7). */
export const ARM_B: RetrievalV2Config = {
  ...COMMON,
  compositeScore: { version: 2, pinBoostDefault: 0.3, pinBoostCap: 1.0 },
  diversity: { enabled: true, maxSimilarity: 0.6, mode: "mmr", mmrLambda: 0.7 },
};
