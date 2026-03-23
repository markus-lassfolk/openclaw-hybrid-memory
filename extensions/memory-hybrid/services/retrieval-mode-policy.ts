/**
 * Retrieval mode policy contracts (Issue #639).
 *
 * Retrieval ownership is intentionally split into two explicit paths:
 * 1) interactive recall path (hot user-facing turn path)
 * 2) explicit/deep retrieval path (tooling + deeper analysis path)
 *
 * Keep policy decisions here so timeout/budget/feature gates are named once and
 * consumed by owning modules (`lifecycle/stage-recall.ts`, `services/retrieval-orchestrator.ts`).
 */

import type { HybridMemoryConfig, RetrievalConfig } from "../config.js";

export const RETRIEVAL_MODE = {
  INTERACTIVE_RECALL: "interactive-recall-path",
  EXPLICIT_DEEP: "explicit-deep-retrieval-path",
} as const;

export type RetrievalMode = (typeof RETRIEVAL_MODE)[keyof typeof RETRIEVAL_MODE];

interface RetrievalModePolicyBase {
  mode: RetrievalMode;
  owner: "lifecycle/stage-recall.ts" | "services/retrieval-orchestrator.ts";
  allowGraphStrategy: boolean;
  allowQueryExpansion: boolean;
  allowReranking: boolean;
}

export interface InteractiveRecallPolicy extends RetrievalModePolicyBase {
  mode: typeof RETRIEVAL_MODE.INTERACTIVE_RECALL;
  stageTimeoutMs: number;
  vectorStepTimeoutMs: number;
}

export interface ExplicitDeepRetrievalPolicy extends RetrievalModePolicyBase {
  mode: typeof RETRIEVAL_MODE.EXPLICIT_DEEP;
  vectorStepTimeoutMs: number;
}

export const INTERACTIVE_RECALL_POLICY: InteractiveRecallPolicy = {
  mode: RETRIEVAL_MODE.INTERACTIVE_RECALL,
  owner: "lifecycle/stage-recall.ts",
  stageTimeoutMs: 35_000,
  vectorStepTimeoutMs: 30_000,
  allowGraphStrategy: false,
  allowQueryExpansion: true,
  allowReranking: false,
};

export const EXPLICIT_DEEP_RETRIEVAL_POLICY: ExplicitDeepRetrievalPolicy = {
  mode: RETRIEVAL_MODE.EXPLICIT_DEEP,
  owner: "services/retrieval-orchestrator.ts",
  vectorStepTimeoutMs: 30_000,
  allowGraphStrategy: true,
  allowQueryExpansion: true,
  allowReranking: true,
};

export function getRetrievalModePolicy(mode: RetrievalMode): InteractiveRecallPolicy | ExplicitDeepRetrievalPolicy {
  return mode === RETRIEVAL_MODE.INTERACTIVE_RECALL ? INTERACTIVE_RECALL_POLICY : EXPLICIT_DEEP_RETRIEVAL_POLICY;
}

/**
 * Interactive recall contract: injection stays within both user-facing autoRecall cap
 * and architectural ambient cap.
 */
export function resolveInteractiveRecallBudgetTokens(cfg: HybridMemoryConfig): number {
  return Math.min(cfg.autoRecall.maxTokens, cfg.retrieval.ambientBudgetTokens);
}

/**
 * Retrieval-orchestrator contract: explicit/deep path uses explicit budget; interactive
 * mode clamps to ambient budget even if a larger override is requested.
 */
export function resolveOrchestratorBudgetTokens(
  mode: RetrievalMode,
  retrievalConfig: RetrievalConfig,
  budgetOverride?: number,
): number {
  const defaultBudget =
    mode === RETRIEVAL_MODE.INTERACTIVE_RECALL
      ? retrievalConfig.ambientBudgetTokens
      : retrievalConfig.explicitBudgetTokens;
  const requested = budgetOverride ?? defaultBudget;
  if (mode === RETRIEVAL_MODE.INTERACTIVE_RECALL) {
    return Math.min(requested, retrievalConfig.ambientBudgetTokens);
  }
  return requested;
}

/**
 * HyDE/query-expansion on interactive turns is allowed only when explicitly configured.
 */
export function shouldSkipHydeForMode(mode: RetrievalMode, skipForInteractiveTurns: boolean): boolean {
  return mode === RETRIEVAL_MODE.INTERACTIVE_RECALL && skipForInteractiveTurns;
}
