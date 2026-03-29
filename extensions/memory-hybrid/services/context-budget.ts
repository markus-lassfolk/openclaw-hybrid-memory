/**
 * Plugin-visible token budget hints until OpenClaw SDK #274 exposes native context APIs (issue #908).
 */

import type { HybridMemoryConfig } from "../config.js";

export function getHybridMemoryContextBudgetHint(cfg: HybridMemoryConfig): {
  autoRecallMaxTokens: number;
  proceduresMaxInjectionTokens: number;
  retrievalAmbientBudgetTokens: number;
  retrievalExplicitBudgetTokens: number;
} {
  return {
    autoRecallMaxTokens: cfg.autoRecall.maxTokens,
    proceduresMaxInjectionTokens: cfg.procedures.maxInjectionTokens,
    retrievalAmbientBudgetTokens: cfg.retrieval.ambientBudgetTokens,
    retrievalExplicitBudgetTokens: cfg.retrieval.explicitBudgetTokens,
  };
}
