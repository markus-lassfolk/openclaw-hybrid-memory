import type { AutoRecallConfig, RetrievalConfig } from "../config.js";

export type RetrievalMode = "interactive-recall" | "explicit-deep";

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
): InteractiveRecallPolicy {
  // When queryExpansion.skipForInteractiveTurns is false, allow HyDE on interactive turns
  const allowHyde = queryExpansion !== undefined && queryExpansion.enabled && !queryExpansion.skipForInteractiveTurns;
  return {
    ...DEFAULT_INTERACTIVE_RECALL_POLICY,
    contextBudgetTokens: cfg.maxTokens,
    degradationQueueDepth: cfg.degradationQueueDepth ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH,
    degradationMaxLatencyMs: cfg.degradationMaxLatencyMs ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS,
    allowAmbientMultiQuery: cfg.enabled,
    allowHyde,
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
