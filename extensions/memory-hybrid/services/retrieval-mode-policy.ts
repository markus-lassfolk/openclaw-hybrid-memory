import type { AutoRecallConfig, HybridMemoryConfig, RetrievalConfig } from "../config.js";

export type RetrievalMode = "interactive-recall" | "explicit-deep" | "constrained-recall";

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
  /** Resolved from `autoRecall.interactiveEnrichment` (default balanced). */
  interactiveEnrichment: "fast" | "balanced" | "full";
  notes: string[];
}

export interface ConstrainedRetrievalPolicy {
  mode: "constrained-recall";
  ownerModule: "services/retrieval-orchestrator.ts";
  contract: "structured filter → semantic rank → hydrate for constrained recall scenarios";
  budgetTokens: number;
  allowHyde: boolean;
  allowRrfFusion: boolean;
  allowQueryExpansion: boolean;
  allowReranking: boolean;
  allowGraphExpansion: boolean;
  allowAliasExpansion: boolean;
  allowMultiModelSemantic: boolean;
  /** Apply structured filters BEFORE ranking rather than after. */
  filterBeforeRank: boolean;
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

/** Wall-clock cap for the whole interactive recall stage (abort + return when exceeded). */
export const INTERACTIVE_RECALL_STAGE_TIMEOUT_MS = 120_000;
/** Per-vector-step cap (HyDE + embed + Lance) inside `runRecallPipelineQuery`. Kept below stage timeout to leave slack for FTS, ambient, directives. */
const INTERACTIVE_RECALL_VECTOR_TIMEOUT_MS = 26_000;
const DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH = 10;
const DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS = 5_000;
const DEFAULT_CONSTRAINED_RETRIEVAL_POLICY: ConstrainedRetrievalPolicy = {
  mode: "constrained-recall",
  ownerModule: "services/retrieval-orchestrator.ts",
  contract: "structured filter → semantic rank → hydrate for constrained recall scenarios",
  budgetTokens: 4000,
  allowHyde: true,
  allowRrfFusion: false,
  allowQueryExpansion: true,
  allowReranking: true,
  allowGraphExpansion: false,
  allowAliasExpansion: true,
  allowMultiModelSemantic: true,
  filterBeforeRank: true,
  notes: [
    "Pre-filters candidate set via structured constraints before semantic ranking.",
    "Use case: 'show facts about project X from the last 30 days', 'search only verified infra memories'.",
    "RRF fusion disabled — ranking is purely semantic within the constrained candidate set.",
    "Hydration includes provenance, graph context, supersession state, and explanation.",
  ],
};

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
  interactiveEnrichment: "balanced",
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
  const enrichment = cfg.interactiveEnrichment ?? "balanced";

  // Baseline (balanced): HyDE on interactive turns only when QE is on and skipForInteractiveTurns is not true.
  let allowHyde = queryExpansion?.enabled === true && queryExpansion.skipForInteractiveTurns !== true;
  // Historically true whenever auto-recall is on; ambient multi-query still requires ambient.enabled && multiQuery in stage-recall.
  let allowAmbientMultiQuery = cfg.enabled === true;

  if (enrichment === "fast") {
    allowHyde = false;
    allowAmbientMultiQuery = false;
  } else if (enrichment === "full") {
    // HyDE whenever query expansion is enabled; ignore skipForInteractiveTurns for the hot path.
    allowHyde = queryExpansion?.enabled === true;
    allowAmbientMultiQuery = cfg.enabled === true;
  }

  // Enforce retrieval.ambientBudgetTokens as a hard total-token cap.
  // autoRecall.maxTokens is a user preference; ambientBudgetTokens is the architectural
  // ceiling — the injected context must not exceed either.
  const contextBudgetTokens = retrieval ? Math.min(cfg.maxTokens, retrieval.ambientBudgetTokens) : cfg.maxTokens;
  return {
    ...DEFAULT_INTERACTIVE_RECALL_POLICY,
    contextBudgetTokens,
    degradationQueueDepth: cfg.degradationQueueDepth ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_QUEUE_DEPTH,
    degradationMaxLatencyMs: cfg.degradationMaxLatencyMs ?? DEFAULT_INTERACTIVE_RECALL_DEGRADATION_MAX_LATENCY_MS,
    allowAmbientMultiQuery,
    allowHyde,
    interactiveEnrichment: enrichment,
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
 * Resolve the constrained retrieval policy for filter-before-rank scenarios.
 * Owned by `services/retrieval-orchestrator.ts`.
 */
export function resolveConstrainedRetrievalPolicy(
  cfg: RetrievalConfig,
  requestedBudget?: number,
): ConstrainedRetrievalPolicy {
  return {
    ...DEFAULT_CONSTRAINED_RETRIEVAL_POLICY,
    budgetTokens: requestedBudget ?? cfg.explicitBudgetTokens,
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
  return requestedBudget ?? retrievalCfg.explicitBudgetTokens;
}

/**
 * Determine if HyDE should be skipped for a given retrieval mode.
 */
export function shouldSkipHydeForMode(mode: RetrievalMode, skipForInteractiveTurns: boolean): boolean {
  return mode === RETRIEVAL_MODE.INTERACTIVE_RECALL && skipForInteractiveTurns;
}
