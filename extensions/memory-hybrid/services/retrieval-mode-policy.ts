import type { AutoRecallConfig, RetrievalConfig, HybridMemoryConfig } from "../config.js";

export type RetrievalMode = "interactive-recall" | "explicit-deep";

/** @deprecated Use string literals directly or InteractiveRecallPolicy / ExplicitDeepRetrievalPolicy types */
export const RETRIEVAL_MODE = {
  INTERACTIVE_RECALL: "interactive-recall" as const,
  EXPLICIT_DEEP: "explicit-deep" as const,
};

export interface InteractiveRecallPolicy {
  mode: "interactive-recall";
  ownerModule: "lifecycle/stage-recall.ts";
  contract: "latency-bounded chat-turn recall";
  stageTimeoutMs: number;
  vectorStepTimeoutMs: number;
  contextBudgetTokens: number;
  degradationQueueDepth: number;
  degradationMaxLatencyMs: number;
  allowHyde: boolean;
  allowAmbientMultiQuery: boolean;
  notes: string[];
}

export interface ExplicitDeepRetrievalPolicy {
  mode: "explicit-deep";
  ownerModule: "services/retrieval-orchestrator.ts";
  contract: "richer retrieval for explicit tools and deeper analysis";
  budgetTokens: number;
  allowHyde: boolean;
  allowRrfFusion: boolean;
  allowQueryExpansion: boolean;
  allowReranking: boolean;
  allowGraphExpansion: boolean;
  allowAliasExpansion: boolean;
  allowMultiModelSemantic: boolean;
  notes: string[];
}

export const INTERACTIVE_RECALL_STAGE_TIMEOUT_MS = 35_000;
export const INTERACTIVE_RECALL_VECTOR_TIMEOUT_MS = 30_000;
export const DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH = 10;
export const DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS = 5_000;

/**
 * Resolve the latency-bounded chat-turn policy owned by `lifecycle/stage-recall.ts`.
 *
 * Interactive recall is intentionally conservative: it keeps a fixed stage timeout,
 * a bounded vector step, and does not run HyDE unless a future caller opts in by
 * explicitly overriding this policy.
 */
export const DEFAULT_INTERACTIVE_RECALL_POLICY: InteractiveRecallPolicy = {
  mode: "interactive-recall",
  ownerModule: "lifecycle/stage-recall.ts",
  contract: "latency-bounded chat-turn recall",
  stageTimeoutMs: INTERACTIVE_RECALL_STAGE_TIMEOUT_MS,
  vectorStepTimeoutMs: INTERACTIVE_RECALL_VECTOR_TIMEOUT_MS,
  contextBudgetTokens: 0,
  degradationQueueDepth: DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH,
  degradationMaxLatencyMs: DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS,
  allowHyde: false,
  allowAmbientMultiQuery: true,
  notes: [
    "Owns the hot path for chat turns.",
    "Falls back to bounded FTS-only/HOT recall under pressure.",
    "Advanced enrichment stays off unless a caller opts in explicitly.",
  ],
};

export function resolveInteractiveRecallPolicy(
  cfg: AutoRecallConfig,
  queryExpansion?: { enabled: boolean; skipForInteractiveTurns: boolean },
  retrieval?: { ambientBudgetTokens: number },
): InteractiveRecallPolicy {
  // When queryExpansion.skipForInteractiveTurns is false, allow HyDE on interactive turns
  const allowHyde = queryExpansion?.enabled && !queryExpansion.skipForInteractiveTurns;
  // Enforce retrieval.ambientBudgetTokens as a hard total-token cap.
  // autoRecall.maxTokens is a user preference; ambientBudgetTokens is the architectural
  // ceiling — the injected context must not exceed either.
  const contextBudgetTokens = retrieval ? Math.min(cfg.maxTokens, retrieval.ambientBudgetTokens) : cfg.maxTokens;
  return {
    ...DEFAULT_INTERACTIVE_RECALL_POLICY,
    contextBudgetTokens,
    degradationQueueDepth: cfg.degradationQueueDepth ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH,
    degradationMaxLatencyMs: cfg.degradationMaxLatencyMs ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS,
    allowAmbientMultiQuery: cfg.enabled ?? false,
    allowHyde: allowHyde ?? false,
  };
}

/**
 * Resolve the richer explicit retrieval policy owned by `services/retrieval-orchestrator.ts`.
 */
export function resolveExplicitDeepRetrievalPolicy(cfg: RetrievalConfig): ExplicitDeepRetrievalPolicy {
  return {
    mode: "explicit-deep",
    ownerModule: "services/retrieval-orchestrator.ts",
    contract: "richer retrieval for explicit tools and deeper analysis",
    budgetTokens: cfg.explicitBudgetTokens,
    allowHyde: true,
    allowRrfFusion: true,
    allowQueryExpansion: true,
    allowReranking: true,
    allowGraphExpansion: true,
    allowAliasExpansion: true,
    allowMultiModelSemantic: true,
    notes: [
      "Owns explicit memory tools and deeper retrieval work.",
      "May spend more latency budget on fusion, expansion, and reranking.",
      "Uses retrieval.explicitBudgetTokens as its packing budget.",
    ],
  };
}

/**
 * Resolve the interactive recall budget tokens, capping to the minimum of
 * autoRecall.maxTokens and retrieval.ambientBudgetTokens.
 */
export function resolveInteractiveRecallBudgetTokens(cfg: HybridMemoryConfig): number {
  return Math.min(cfg.autoRecall.maxTokens, cfg.retrieval.ambientBudgetTokens);
}

/**
 * Resolve orchestrator budget tokens for a given retrieval mode.
 * For interactive recall mode, caps to ambientBudgetTokens.
 * For explicit deep mode, uses explicitBudgetTokens.
 */
export function resolveOrchestratorBudgetTokens(
  mode: RetrievalMode,
  retrievalCfg: RetrievalConfig,
  requestedBudget?: number,
): number {
  if (mode === RETRIEVAL_MODE.INTERACTIVE_RECALL) {
    return requestedBudget !== undefined
      ? Math.min(requestedBudget, retrievalCfg.ambientBudgetTokens)
      : retrievalCfg.ambientBudgetTokens;
  }
  return requestedBudget !== undefined ? requestedBudget : retrievalCfg.explicitBudgetTokens;
}

/**
 * Determine if HyDE should be skipped for a given retrieval mode.
 */
export function shouldSkipHydeForMode(mode: RetrievalMode, skipForInteractiveTurns: boolean): boolean {
  return mode === RETRIEVAL_MODE.INTERACTIVE_RECALL && skipForInteractiveTurns;
}
