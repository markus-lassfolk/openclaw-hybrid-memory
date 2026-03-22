/**
 * Explicit/deep retrieval owner.
 *
 * This module owns the richer retrieval path used for explicit tools and deeper
 * analysis. It may spend more latency budget on HyDE, query expansion, RRF,
 * graph expansion, multi-model semantic search, and reranking.
 */

import type { DatabaseSync } from "node:sqlite";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";
import { searchFts } from "./fts-search.js";
import {
  fuseResults,
  applyPostRrfAdjustments,
  RRF_K_DEFAULT,
  type RankedResult,
  type FusedResult,
  type FactMetadata,
} from "./rrf-fusion.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  type HybridMemoryConfig,
  type RetrievalConfig,
  type ClustersConfig,
  type RerankingConfig,
} from "../config.js";
import { rerankResults, type ScoredFact } from "./reranker.js";
import type { QueryExpander } from "./query-expander.js";
import { searchAliasStrategy, type AliasDB } from "./retrieval-aliases.js";
import { detectClusters, type ClusterFactLookup } from "./topic-clusters.js";
import { expandGraph, type GraphFactLookup } from "./graph-retrieval.js";
import type { EmbeddingRegistry } from "./embedding-registry.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { AllEmbeddingProvidersFailed } from "./embeddings.js";
import { capturePluginError, addOperationBreadcrumb } from "./error-reporter.js";
import { chatCompleteWithRetry, type PendingLLMWarnings } from "./chat.js";
import { is500Like, is404Like, isOllamaOOM } from "./chat.js";
import { resolveExplicitDeepRetrievalPolicy, type ExplicitDeepRetrievalPolicy } from "./retrieval-mode-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from the orchestrator, ready for context injection. */
export interface OrchestratorResult {
  /** Fused and adjusted results, sorted by finalScore descending. */
  fused: FusedResult[];
  /** Serialized fact strings packed into the token budget, highest scored first. */
  packed: string[];
  /** factIds of the facts included in packed (same order as packed). */
  packedFactIds: string[];
  /** Total tokens used by the packed results (approximate: chars / 4). */
  tokensUsed: number;
  /** Resolved MemoryEntry objects for each fused result (same order as fused array). */
  entries: MemoryEntry[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface ExplicitRetrievalLogger {
  warn: (msg: string) => void;
}

export interface BuildExplicitSemanticQueryVectorDeps {
  query: string;
  cfg: Pick<HybridMemoryConfig, "retrieval" | "queryExpansion" | "llm">;
  embeddings: Pick<EmbeddingProvider, "embed">;
  openai: import("openai").default;
  pendingLLMWarnings: PendingLLMWarnings;
  logger: ExplicitRetrievalLogger;
  policy?: ExplicitDeepRetrievalPolicy;
}

export async function buildExplicitSemanticQueryVector({
  query,
  cfg,
  embeddings,
  openai,
  pendingLLMWarnings,
  logger,
  policy = resolveExplicitDeepRetrievalPolicy(cfg.retrieval),
}: BuildExplicitSemanticQueryVectorDeps): Promise<{ queryVector: number[] | null; warning: string | null }> {
  if (!cfg.retrieval.strategies.includes("semantic")) {
    return { queryVector: null, warning: null };
  }

  try {
    addOperationBreadcrumb("retrieval", `${policy.mode}-vector-recall`);
    let textToEmbed = query;

    if (policy.allowHyde && cfg.queryExpansion.enabled) {
      try {
        const cronCfg = getCronModelConfig(cfg as Parameters<typeof getCronModelConfig>[0]);
        const pref = getLLMModelPreference(cronCfg, "nano");
        const hydeModel = cfg.queryExpansion.model ?? pref[0];
        const fallbackModels = cfg.queryExpansion.model ? [] : pref.slice(1);
        const hydeContent = await chatCompleteWithRetry({
          model: hydeModel,
          fallbackModels,
          content: `Write a short factual statement (1-2 sentences) that answers: ${query}

Output only the statement, no preamble.`,
          temperature: 0.3,
          maxTokens: 150,
          openai,
          label: "HyDE",
          timeoutMs: cfg.queryExpansion.timeoutMs,
          pendingWarnings: pendingLLMWarnings,
        });
        const hydeText = hydeContent.trim();
        if (hydeText.length > 10) textToEmbed = hydeText;
      } catch (err) {
        const hydeErr = err instanceof Error ? err : new Error(String(err));
        const isTransient =
          isOllamaOOM(hydeErr) ||
          is500Like(hydeErr) ||
          is404Like(hydeErr) ||
          /timed out|llm request timeout|request was aborted|econnrefused/i.test(hydeErr.message);
        if (!isTransient) {
          capturePluginError(hydeErr, { subsystem: "retrieval", operation: "explicit-hyde-generation" });
        }
        logger.warn(`memory-hybrid: HyDE generation failed, using raw query: ${err}`);
      }
    }

    return { queryVector: await embeddings.embed(textToEmbed), warning: null };
  } catch (err) {
    if (!(err instanceof AllEmbeddingProvidersFailed)) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "retrieval",
        operation: "explicit-vector-embed",
      });
    }
    logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
    return { queryVector: null, warning: "Semantic search unavailable due to embedding failure; results may be incomplete." };
  }
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  strategies: ["semantic", "fts5", "graph"],
  rrf_k: RRF_K_DEFAULT,
  ambientBudgetTokens: 2000,
  explicitBudgetTokens: 4000,
  graphWalkDepth: 2,
  semanticTopK: 20,
  fts5TopK: 20,
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Approximate token count from character count (chars / 4). */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Fact serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a MemoryEntry as a compact string for context injection.
 *
 * Format:
 * ```
 * [entity: X | category: Y | confidence: 0.95 | stored: 2026-02-15]
 * Fact text here.
 * ```
 *
 * When `options.isContradicted` is true, a warning line is prepended so the
 * consumer knows the fact has an unresolved contradiction.
 */
export function serializeFactForContext(entry: MemoryEntry, options?: { isContradicted?: boolean }): string {
  const parts: string[] = [];

  if (entry.entity) parts.push(`entity: ${entry.entity}`);
  parts.push(`category: ${entry.category}`);
  parts.push(`confidence: ${entry.confidence.toFixed(2)}`);

  const storedSec = entry.sourceDate ?? entry.createdAt;
  const storedDate = new Date(storedSec * 1000).toISOString().slice(0, 10);
  parts.push(`stored: ${storedDate}`);

  const header = `[${parts.join(" | ")}]`;
  const body = `${header}\n${entry.text}`;
  if (options?.isContradicted) {
    return `[WARNING: CONTRADICTED — verify before use]\n${body}`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Token budget packing
// ---------------------------------------------------------------------------

/**
 * Pack serialized facts into a token budget, highest-scored first.
 *
 * @param entries - Ordered list of (factId, entry) pairs, best-scored first.
 * @param budgetTokens - Maximum token budget.
 * @param options - Optional: set of fact IDs that are contradicted (marked with warning).
 * @returns Object with packed strings and total tokens used.
 */
export function packIntoBudget(
  entries: Array<{ factId: string; entry: MemoryEntry }>,
  budgetTokens: number,
  options?: { contradictedIds?: Set<string> },
): { packed: string[]; tokensUsed: number } {
  const packed: string[] = [];
  let tokensUsed = 0;

  for (const { factId, entry } of entries) {
    const isContradicted = options?.contradictedIds?.has(factId) ?? false;
    const serialized = serializeFactForContext(entry, { isContradicted });
    const tokens = estimateTokenCount(serialized);
    if (tokensUsed + tokens > budgetTokens) break;
    packed.push(serialized);
    tokensUsed += tokens;
  }

  return { packed, tokensUsed };
}

// ---------------------------------------------------------------------------
// Individual strategy runners
// ---------------------------------------------------------------------------

/**
 * Run FTS5 full-text search strategy.
 * Returns ranked results (best = rank 1).
 */
function runFts5Strategy(
  db: DatabaseSync,
  query: string,
  limit: number,
  tagFilter?: string,
  includeSuperseded?: boolean,
  asOf?: number,
): RankedResult[] {
  const results = searchFts(db, query, { limit, tagFilter, includeSuperseded, asOf });
  return results.map((r, i) => ({
    factId: r.factId,
    rank: i + 1,
    source: "fts5" as const,
  }));
}

/**
 * Run semantic (vector) search strategy.
 * Returns ranked results (best = rank 1).
 */
async function runSemanticStrategy(vectorDb: VectorDB, queryVector: number[], topK: number): Promise<RankedResult[]> {
  const results: SearchResult[] = await vectorDb.search(queryVector, topK, 0.3);
  return results.map((r, i) => ({
    factId: r.entry.id,
    rank: i + 1,
    source: "semantic" as const,
  }));
}

/**
 * Run multi-model semantic search using EmbeddingRegistry (Issue #158).
 * Queries the fact_embeddings SQLite table for each additional model via cosine
 * similarity approximation, then returns per-model ranked results.
 *
 * This returns a Map from strategy label → RankedResult[], so each model
 * participates as a separate RRF strategy (same pattern as "semantic", "fts5").
 */
async function runMultiModelSemanticStrategies(
  factsDbWithEmbeddings: FactsDbWithEmbeddings,
  registry: EmbeddingRegistry,
  queryText: string,
  topK: number,
): Promise<Map<string, RankedResult[]>> {
  const result = new Map<string, RankedResult[]>();
  const models = registry.getModels();
  if (models.length === 0) return result;

  // Embed query with all additional models in parallel
  const embedTasks = models.map(async (cfg) => {
    const queryVec = await registry.embed(queryText, cfg.name);
    return { name: cfg.name, queryVec };
  });

  const settled = await Promise.allSettled(embedTasks);
  for (const s of settled) {
    if (s.status === "rejected") {
      capturePluginError(s.reason instanceof Error ? s.reason : new Error(String(s.reason)), {
        subsystem: "retrieval",
        operation: "multi-model-embed",
      });
      continue;
    }
    const { name, queryVec } = s.value;
    const maxCandidatesPerModel = Math.max(topK * 10, 500);
    const candidates = factsDbWithEmbeddings.getEmbeddingsByModel(name, maxCandidatesPerModel);
    if (candidates.length === 0) continue;

    // Compute cosine similarity for the bounded candidate set (already limited at DB with ORDER BY id DESC)
    const scored = candidates
      .map(({ factId, embedding }) => ({
        factId,
        score: cosineSimilarity(queryVec, embedding),
      }))
      .filter((r) => r.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (scored.length > 0) {
      result.set(
        `semantic:${name}`,
        scored.map((r, i) => ({
          factId: r.factId,
          rank: i + 1,
          source: `semantic:${name}` as const,
        })),
      );
    }
  }
  return result;
}

/** Compute cosine similarity between two Float32Arrays. Returns [-1, 1]. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Minimal interface for fact_embeddings access (satisfied by FactsDB). */
export interface FactsDbWithEmbeddings {
  getEmbeddingsByModel(model: string, limit?: number): Array<{ factId: string; embedding: Float32Array }>;
}

/**
 * Graph walk strategy using GraphRAG expansion (Issue #152).
 * Expands from seed facts found by other strategies.
 */
function runGraphStrategy(
  factsDb: FactLookup,
  seeds: Array<{ factId: string; score: number; entry: MemoryEntry }>,
  maxDepth: number,
  scopeFilter?: unknown,
  asOf?: number,
): RankedResult[] {
  if (maxDepth <= 0 || seeds.length === 0 || !hasGraphLookup(factsDb)) return [];
  const expanded = expandGraph(factsDb, seeds, { maxDepth, scopeFilter, asOf });
  const bestById = new Map<string, number>();
  for (const e of expanded) {
    if (e.expansionSource !== "graph") continue;
    const existing = bestById.get(e.factId);
    if (existing === undefined || e.score > existing) {
      bestById.set(e.factId, e.score);
    }
  }
  const sorted = Array.from(bestById.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.map(([factId], i) => ({
    factId,
    rank: i + 1,
    source: "graph" as const,
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Minimal interface for fact lookup during orchestration.
 * Satisfied by FactsDB.
 */
export interface FactLookup {
  getById(id: string, options?: { asOf?: number; scopeFilter?: unknown }): MemoryEntry | null;
  /** Optional: check whether a fact has an unresolved CONTRADICTS link targeting it. */
  isContradicted?(factId: string): boolean;
  /** Optional: batch check — returns the subset of factIds involved in unresolved contradictions. */
  getContradictedIds?(factIds: string[]): Set<string>;
  /** Optional: cluster detection helpers (FactsDB implements these). */
  getAllLinkedFactIds?(): string[];
  getAllLinks?(): Array<{ sourceFactId: string; targetFactId: string }>;
  /** Optional: count of links for cache invalidation (FactsDB implements this). */
  linksCount?(): number;
  /** Optional: graph traversal helpers (FactsDB implements these). */
  getLinksFrom?(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }>;
  getLinksTo?(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>;
}

function hasClusterLookup(factsDb: FactLookup): factsDb is FactLookup & ClusterFactLookup {
  return typeof factsDb.getAllLinkedFactIds === "function" && typeof factsDb.getAllLinks === "function";
}

function hasGraphLookup(factsDb: FactLookup): factsDb is FactLookup & GraphFactLookup {
  return (
    typeof factsDb.getLinksFrom === "function" &&
    typeof factsDb.getLinksTo === "function" &&
    typeof (factsDb as GraphFactLookup).getByIds === "function"
  );
}

type ClusterCacheEntry = { clusters: Map<string, string>; timestamp: number; minClusterSize: number | undefined };

class ClusterCache {
  private clusterCache: ClusterCacheEntry | null = null;
  private clusterCacheLinkCount: number | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  getClusterMap(factsDb: FactLookup & ClusterFactLookup, minClusterSize?: number): Map<string, string> {
    const now = Date.now();
    const linkCount = typeof factsDb.linksCount === "function" ? factsDb.linksCount() : null;
    if (this.clusterCache && now - this.clusterCache.timestamp < this.ttlMs) {
      if (
        (linkCount == null || linkCount === this.clusterCacheLinkCount) &&
        this.clusterCache.minClusterSize === minClusterSize
      ) {
        return this.clusterCache.clusters;
      }
    }

    const clusterResult = detectClusters(factsDb, { minClusterSize });
    const clusterByFact = new Map<string, string>();
    for (const cluster of clusterResult.clusters) {
      for (const id of cluster.factIds) {
        clusterByFact.set(id, cluster.id);
      }
    }

    this.clusterCache = { clusters: clusterByFact, timestamp: now, minClusterSize };
    this.clusterCacheLinkCount = linkCount;
    return clusterByFact;
  }

  invalidate(): void {
    this.clusterCache = null;
    this.clusterCacheLinkCount = null;
  }
}

const clusterCache = new ClusterCache();

export function invalidateClusterCache(): void {
  clusterCache.invalidate();
}

/**
 * Options bag for `runExplicitDeepRetrieval` (also exported as `runRetrievalPipeline`).
 *
 * All fields are optional. Required inputs (`query`, `queryVector`, `db`,
 * `vectorDb`, `factsDb`) are kept as positional parameters because they are
 * always needed; everything else lives here so callers can pass only what they
 * actually use — without placeholder nulls — and new strategies can be added
 * without touching every call site.
 */
export interface RetrievalPipelineOptions {
  /** Explicit/deep retrieval policy. Defaults to `resolveExplicitDeepRetrievalPolicy(config)`. */
  policy?: ExplicitDeepRetrievalPolicy;
  /** Retrieval pipeline configuration. Defaults to `DEFAULT_RETRIEVAL_CONFIG`. */
  config?: RetrievalConfig;
  /** Token budget for packing. Defaults to `config.explicitBudgetTokens`. */
  budgetTokens?: number;
  /** Current time as epoch seconds. Defaults to `Math.floor(Date.now() / 1000)`. */
  nowSec?: number;
  /** Optional tag constraint propagated into the FTS5 strategy. */
  tagFilter?: string;
  /** When true, superseded/expired facts are included. Default false. */
  includeSuperseded?: boolean;
  /** Scope constraints applied when resolving fused fact IDs. */
  scopeFilter?: unknown;
  /** Temporal filter applied when resolving fused fact IDs. */
  asOf?: number;
  /** Alias DB for alias-search RRF strategy (Issue #149). */
  aliasDb?: AliasDB | null;
  /** Cluster sibling-boost configuration (Issue #146). */
  clustersConfig?: ClustersConfig;
  /** Multi-model embedding registry (Issue #158). Each registered model adds its own RRF strategy. */
  embeddingRegistry?: EmbeddingRegistry | null;
  /** Access to the fact_embeddings table (Issue #158). When `embeddingRegistry` is set but this is omitted/null, multi-model strategies are silently skipped (graceful degradation). */
  factsDbForEmbeddings?: FactsDbWithEmbeddings | null;
  /** Query expander for variant-query strategies (Issue #160). */
  queryExpander?: QueryExpander | null;
  /** Embed function used to vectorise expanded query variants (Issue #160). */
  embedFn?: ((text: string) => Promise<number[]>) | null;
  /** Recent conversation context passed to the LLM query expander. */
  queryExpansionContext?: string;
  /** Re-ranking configuration (Issue #161). */
  rerankingConfig?: RerankingConfig | null;
  /** OpenAI-compatible client for re-ranking LLM calls (Issue #161). */
  rerankingOpenai?: import("openai").default | null;
}

/**
 * Run the explicit/deep retrieval pipeline and return fused, ranked results.
 * `runRetrievalPipeline` remains as a backward-compatible alias.
 *
 * Steps:
 * 1. Run configured strategies in parallel (semantic, fts5) and optional graph expansion.
 * 2. Fuse via RRF.
 * 3. Look up fact metadata for post-RRF adjustments (applying scope + asOf filters).
 * 4. Apply post-RRF adjustments (recency, confidence, access frequency).
 * 5. Pack into token budget.
 *
 * @param query - Raw search query string.
 * @param queryVector - Pre-computed embedding vector for semantic search.
 *   Pass null to skip semantic strategy.
 * @param db - node:sqlite DatabaseSync instance for FTS5 queries.
 * @param vectorDb - LanceDB VectorDB instance for semantic queries.
 * @param factsDb - FactsDB for metadata lookup.
 * @param options - Optional settings; see `RetrievalPipelineOptions`.
 */
export async function runExplicitDeepRetrieval(
  query: string,
  queryVector: number[] | null,
  db: DatabaseSync,
  vectorDb: VectorDB,
  factsDb: FactLookup,
  options: RetrievalPipelineOptions = {},
): Promise<OrchestratorResult> {
  const config = options.config ?? DEFAULT_RETRIEVAL_CONFIG;
  const policy = options.policy ?? resolveExplicitDeepRetrievalPolicy(config);
  const budgetTokens = options.budgetTokens ?? policy.budgetTokens;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const {
    tagFilter,
    includeSuperseded,
    scopeFilter,
    asOf,
    aliasDb,
    clustersConfig,
    embeddingRegistry,
    factsDbForEmbeddings,
    queryExpander,
    embedFn,
    queryExpansionContext,
    rerankingConfig,
    rerankingOpenai,
  } = options;
  const runOnce = async (expansion: {
    useLlm: boolean;
    variants: string[] | null;
    skipReranking?: boolean;
  }): Promise<OrchestratorResult> => {
    const k = config.rrf_k;
    const { strategies, semanticTopK, fts5TopK } = config;

    // --- Run strategies in parallel ---
    const strategyPromises: Array<Promise<[string, RankedResult[]]>> = [];

    // Helper: wrap each strategy in try/catch so a synchronous throw or rejection
    // is captured by allSettled rather than aborting the pipeline.
    const safeStrategy = (
      name: string,
      fn: () => RankedResult[] | Promise<RankedResult[]>,
    ): Promise<[string, RankedResult[]]> =>
      (async () => {
        try {
          return [name, await fn()] as [string, RankedResult[]];
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "retrieval",
            operation: `strategy:${name}`,
          });
          return [name, []] as [string, RankedResult[]];
        }
      })();

    if (strategies.includes("fts5")) {
      strategyPromises.push(
        safeStrategy("fts5", () => runFts5Strategy(db, query, fts5TopK, tagFilter, includeSuperseded, asOf)),
      );
    }

    if (strategies.includes("semantic") && queryVector) {
      strategyPromises.push(safeStrategy("semantic", () => runSemanticStrategy(vectorDb, queryVector, semanticTopK)));
    }

    // Issue #149: alias search — participates in RRF fusion as "aliases" strategy
    if (policy.allowAliasExpansion && aliasDb && queryVector) {
      strategyPromises.push(safeStrategy("aliases", () => searchAliasStrategy(aliasDb, queryVector, semanticTopK)));
    }

    // Issue #160: query expansion — generate variant queries, embed each, run semantic search.
    // Only runs when semantic strategy is active, expander is provided, and embedFn is available.
    if (policy.allowQueryExpansion && strategies.includes("semantic") && queryVector && queryExpander && embedFn) {
      try {
        let additionalVariants: string[] = [];
        if (expansion.useLlm) {
          const variants = await queryExpander.expandQuery(query, queryExpansionContext);
          // variants[0] is always the original query (already handled above); expand from index 1.
          additionalVariants = variants.slice(1);
        } else if (expansion.variants && expansion.variants.length > 0) {
          additionalVariants = expansion.variants;
        }

        for (let i = 0; i < additionalVariants.length; i++) {
          const variantQuery = additionalVariants[i];
          const strategyName = `semantic:qe:${i}`;
          strategyPromises.push(
            safeStrategy(strategyName, async () => {
              const variantVector = await embedFn(variantQuery);
              return runSemanticStrategy(vectorDb, variantVector, semanticTopK);
            }),
          );
        }
      } catch (_err) {
        // Graceful degradation — expansion failure never blocks retrieval
      }
    }

    // Issue #158: start multi-model semantic strategies in parallel with other strategies.
    let multiModelPromise: Promise<Map<string, RankedResult[]>> | null = null;
    if (
      policy.allowMultiModelSemantic &&
      strategies.includes("semantic") &&
      embeddingRegistry &&
      embeddingRegistry.isMultiModel() &&
      factsDbForEmbeddings
    ) {
      multiModelPromise = runMultiModelSemanticStrategies(factsDbForEmbeddings, embeddingRegistry, query, semanticTopK);
    }

    const strategySettledResults = await Promise.allSettled(strategyPromises);

    // Build strategy map — rejected/empty strategies are skipped so the rest can still contribute.
    const strategyMap = new Map<string, RankedResult[]>();
    for (const settled of strategySettledResults) {
      if (settled.status === "rejected") continue;
      const [name, results] = settled.value;
      if (results.length > 0) {
        strategyMap.set(name, results);
      }
    }

    if (multiModelPromise) {
      try {
        const multiModelResults = await multiModelPromise;
        for (const [strategyName, results] of multiModelResults) {
          if (results.length > 0) {
            strategyMap.set(strategyName, results);
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "multi-model-semantic",
        });
      }
    }

    // Graph walk strategy (Issue #152) — expand from semantic/FTS5 seeds
    if (policy.allowGraphExpansion && strategies.includes("graph")) {
      const seedScores = new Map<string, number>();
      const seedEntries = new Map<string, MemoryEntry>();
      const getByIdOpts = scopeFilter || asOf != null ? { scopeFilter, asOf } : undefined;

      for (const results of strategyMap.values()) {
        for (const r of results) {
          const entry = factsDb.getById(r.factId, getByIdOpts);
          if (!entry) continue;
          const score = 1 / (k + r.rank);
          const existing = seedScores.get(r.factId) ?? 0;
          seedScores.set(r.factId, existing + score);
          if (!seedEntries.has(r.factId)) seedEntries.set(r.factId, entry);
        }
      }

      const seeds = Array.from(seedScores.entries()).map(([factId, score]) => ({
        factId,
        score,
        entry: seedEntries.get(factId)!,
      }));
      const graphResults = runGraphStrategy(factsDb, seeds, config.graphWalkDepth, scopeFilter, asOf);
      if (graphResults.length > 0) {
        strategyMap.set("graph", graphResults);
      }
    }

    // --- RRF Fusion ---
    const fused = policy.allowRrfFusion ? fuseResults(strategyMap, k) : [];

    if (fused.length === 0) {
      return { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] };
    }

    // --- Build metadata map for post-RRF adjustments ---
    // Apply scope and asOf filters when resolving fused fact IDs to prevent returning
    // facts from outside the caller's scope (scope/session/agent boundary enforcement).
    const getByIdOpts = scopeFilter || asOf != null ? { scopeFilter, asOf } : undefined;

    const factMetaMap = new Map<string, FactMetadata>();
    const orderedEntries: Array<{ factId: string; entry: MemoryEntry }> = [];

    // Effective timestamp for superseded/expired checks: prefer asOf, fall back to nowSec.
    const effectiveNow = asOf ?? nowSec;

    for (const result of fused) {
      const entry = factsDb.getById(result.factId, getByIdOpts);
      if (entry) {
        // When not including superseded/expired facts, filter them out here so that
        // semantic results (which lack SQL-level filtering) are held to the same standard
        // as FTS5 results. This is the single enforcement point for all strategies.
        if (!includeSuperseded) {
          if (entry.supersededAt != null) continue;
          if (entry.expiresAt != null && entry.expiresAt <= effectiveNow) continue;
        }
        factMetaMap.set(result.factId, {
          id: entry.id,
          confidence: entry.confidence,
          lastAccessed: entry.lastAccessed ?? null,
          recallCount: entry.recallCount ?? 0,
        });
        orderedEntries.push({ factId: result.factId, entry });
      }
    }

    // Filter fused array to remove out-of-scope or superseded/expired facts not resolved above.
    const scopedFused = fused.filter((result) => factMetaMap.has(result.factId));

    // --- Post-RRF adjustments ---
    applyPostRrfAdjustments(scopedFused, factMetaMap, nowSec);

    // --- Cluster sibling boost (Issue #146) ---
    if (clustersConfig?.enabled && hasClusterLookup(factsDb)) {
      try {
        const clusterByFact = clusterCache.getClusterMap(factsDb, clustersConfig.minClusterSize);
        if (clusterByFact.size > 0) {
          const clusterToIndices = new Map<string, number[]>();
          for (let i = 0; i < scopedFused.length; i++) {
            const clusterId = clusterByFact.get(scopedFused[i].factId);
            if (!clusterId) continue;
            const list = clusterToIndices.get(clusterId) ?? [];
            list.push(i);
            clusterToIndices.set(clusterId, list);
          }

          const BOOST_MULTIPLIER = 1.1;
          for (const indices of clusterToIndices.values()) {
            if (indices.length < 2) continue;
            let bestIndex = indices[0];
            for (const idx of indices) {
              if (scopedFused[idx].finalScore > scopedFused[bestIndex].finalScore) {
                bestIndex = idx;
              }
            }
            for (const idx of indices) {
              if (idx === bestIndex) continue;
              scopedFused[idx].finalScore *= BOOST_MULTIPLIER;
            }
          }

          scopedFused.sort((a, b) => b.finalScore - a.finalScore);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "cluster-boost",
        });
      }
    }

    // Re-sort entries to match final order
    const finalOrder = new Map<string, number>(scopedFused.map((r, i) => [r.factId, i]));
    orderedEntries.sort((a, b) => (finalOrder.get(a.factId) ?? 0) - (finalOrder.get(b.factId) ?? 0));

    // --- LLM Re-ranking (Issue #161) ---
    // After RRF fusion (and cluster boost), optionally re-rank the top candidates via LLM.
    // On any failure or timeout, falls back to the original RRF order (no behavior change).
    // Skip re-ranking if explicitly requested (e.g., conditional mode first pass).
    if (rerankingConfig?.enabled && rerankingOpenai && !expansion.skipReranking) {
      try {
        const rrfScoreMap = new Map<string, number>(scopedFused.map((r) => [r.factId, r.finalScore]));
        const scoredFacts: ScoredFact[] = orderedEntries.map(({ factId, entry }) => {
          const storedSec = entry.sourceDate ?? entry.createdAt;
          return {
            factId,
            text: entry.text,
            confidence: entry.confidence,
            storedDate: new Date(storedSec * 1000).toISOString().slice(0, 10),
            finalScore: rrfScoreMap.get(factId) ?? 0,
          };
        });

        const reranked = await rerankResults(query, scoredFacts, rerankingConfig, rerankingOpenai);

        // Rebuild orderedEntries in the new order.
        const rerankedOrder = new Map(reranked.map((f, i) => [f.factId, i]));
        orderedEntries.sort(
          (a, b) =>
            (rerankedOrder.get(a.factId) ?? Number.POSITIVE_INFINITY) -
            (rerankedOrder.get(b.factId) ?? Number.POSITIVE_INFINITY),
        );
        // Trim to the outputCount returned by the reranker.
        if (orderedEntries.length > reranked.length) {
          orderedEntries.length = reranked.length;
        }
        // Also reorder scopedFused to stay consistent with orderedEntries.
        scopedFused.sort(
          (a, b) =>
            (rerankedOrder.get(a.factId) ?? Number.POSITIVE_INFINITY) -
            (rerankedOrder.get(b.factId) ?? Number.POSITIVE_INFINITY),
        );
        if (scopedFused.length > reranked.length) {
          scopedFused.length = reranked.length;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "reranking",
        });
      }
    }

    // --- Token budget packing ---
    // Build contradicted set so contradicted facts are marked with a warning in the packed output.
    // Prefer the batch method (single query) over per-entry isContradicted calls (N queries).
    const contradictedIds = new Set<string>();
    if (factsDb.getContradictedIds) {
      const allIds = orderedEntries.map((e) => e.factId);
      const batch = factsDb.getContradictedIds(allIds);
      for (const id of batch) contradictedIds.add(id);
    } else if (factsDb.isContradicted) {
      for (const { factId } of orderedEntries) {
        if (factsDb.isContradicted(factId)) contradictedIds.add(factId);
      }
    }
    const { packed, tokensUsed } = packIntoBudget(orderedEntries, budgetTokens, { contradictedIds });
    const packedFactIds = orderedEntries.slice(0, packed.length).map((e) => e.factId);

    // Extract resolved entries in final order for caller (avoids double lookup)
    const resolvedEntries = orderedEntries.map((e) => e.entry);

    return { fused: scopedFused, packed, packedFactIds, tokensUsed, entries: resolvedEntries };
  };

  const expanderMode =
    queryExpander && typeof (queryExpander as QueryExpander).getMode === "function"
      ? queryExpander.getMode()
      : queryExpander
        ? "always"
        : "off";

  if (expanderMode === "conditional") {
    const alias =
      queryExpander && typeof (queryExpander as QueryExpander).getRuleBasedAlias === "function"
        ? queryExpander.getRuleBasedAlias(query)
        : null;
    const initial = await runOnce({ useLlm: false, variants: alias ? [alias] : [], skipReranking: true });
    const threshold =
      queryExpander && typeof (queryExpander as QueryExpander).getThreshold === "function"
        ? queryExpander.getThreshold()
        : 0.03;
    const topScore = initial.fused[0]?.finalScore ?? 0;
    if (topScore < threshold) {
      return runOnce({ useLlm: true, variants: null, skipReranking: false });
    }
    // When above threshold we skipped LLM expansion but must still apply reranking if enabled.
    if (policy.allowReranking && rerankingConfig?.enabled && rerankingOpenai) {
      try {
        const rrfScoreMap = new Map(initial.fused.map((r) => [r.factId, r.finalScore]));
        // Build factId→entry map from fused results (same length/order as entries) to avoid
        // fragile positional index alignment between initial.entries and initial.fused.
        const fusedEntryMap = new Map<string, MemoryEntry>(
          initial.fused
            .map((r, i) => [r.factId, initial.entries[i]] as [string, MemoryEntry])
            .filter(([, e]) => e != null),
        );
        const scoredFacts: ScoredFact[] = initial.fused.flatMap((r) => {
          const entry = fusedEntryMap.get(r.factId);
          if (!entry) return [];
          const storedSec = entry.sourceDate ?? entry.createdAt;
          return [
            {
              factId: r.factId,
              text: entry.text,
              confidence: entry.confidence,
              storedDate: new Date(storedSec * 1000).toISOString().slice(0, 10),
              finalScore: rrfScoreMap.get(r.factId) ?? 0,
            },
          ];
        });
        const reranked = await rerankResults(query, scoredFacts, rerankingConfig, rerankingOpenai);
        const rerankedOrder = new Map(reranked.map((f, i) => [f.factId, i]));
        const orderedEntriesReranked = reranked
          .map((f) => ({ factId: f.factId, entry: fusedEntryMap.get(f.factId)! }))
          .filter((x) => x.entry);
        const fusedReranked = orderedEntriesReranked
          .map(({ factId }) => initial.fused.find((r) => r.factId === factId)!)
          .filter(Boolean);
        const contradictedIds = new Set<string>();
        if (factsDb.getContradictedIds) {
          const allIds = orderedEntriesReranked.map((e) => e.factId);
          const batch = factsDb.getContradictedIds(allIds);
          for (const id of batch) contradictedIds.add(id);
        } else if (factsDb.isContradicted) {
          for (const { factId } of orderedEntriesReranked) {
            if (factsDb.isContradicted(factId)) contradictedIds.add(factId);
          }
        }
        const { packed, tokensUsed } = packIntoBudget(orderedEntriesReranked, budgetTokens, { contradictedIds });
        const packedFactIdsReranked = orderedEntriesReranked.slice(0, packed.length).map((e) => e.factId);
        return {
          fused: fusedReranked,
          packed,
          packedFactIds: packedFactIdsReranked,
          tokensUsed,
          entries: orderedEntriesReranked.map((e) => e.entry),
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "reranking-conditional",
        });
      }
    }
    return initial;
  }

  if (expanderMode === "always") {
    return runOnce({ useLlm: true, variants: null });
  }

  return runOnce({ useLlm: false, variants: [] });
}

export const runRetrievalPipeline = runExplicitDeepRetrieval;
