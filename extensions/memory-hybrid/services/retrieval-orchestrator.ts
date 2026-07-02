/**
 * Multi-Strategy Retrieval Orchestrator (Issue #152).
 *
 * Runs configured retrieval strategies in parallel, fuses results via RRF,
 * applies post-RRF score adjustments, and packs results into a token budget.
 *
 * Strategies:
 *   - semantic: LanceDB vector similarity search
 *   - fts5: SQLite FTS5 full-text search (Issue #151)
 *   - graph: Graph-walk spreading activation (GraphRAG expansion)
 */

import type { DatabaseSync } from "node:sqlite";
import { parseFactProvenanceJson, resolveProvenanceSourceFacts } from "../backends/facts-db/provenance-json.js";
import { getCandidateIdsByStructuredFilters, hasActiveFilters } from "../backends/facts-db/search.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ClustersConfig, RerankingConfig, RetrievalConfig } from "../config.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";
import { formatDateUtc } from "../utils/dates.js";
import { pluginLogger } from "../utils/logger.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { isTierAllowedForWarmSearch } from "../utils/tier-filter.js";
import { DocumentGrader } from "./document-grader.js";
import type { EmbeddingRegistry } from "./embedding-registry.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { searchFts } from "./fts-search.js";
import { expandGraph, type GraphFactLookup } from "./graph-retrieval.js";
import { expandQueryWithHyde } from "./hyde-helper.js";
import { getCriticalOpenIssueFactIds, runIssueRetrievalStrategy } from "./issue-retrieval.js";
import type { QueryExpander } from "./query-expander.js";
import { type QueryValidationResult, validateQueryForMemoryLookup } from "./query-validator.js";
import { rerankResults, type ScoredFact } from "./reranker.js";
import { type AliasDB, searchAliasStrategy } from "./retrieval-aliases.js";
import {
  type ConstrainedRetrievalPolicy,
  DEFAULT_INTERACTIVE_RECALL_POLICY,
  type ExplicitDeepRetrievalPolicy,
  type InteractiveRecallPolicy,
  resolveConstrainedRetrievalPolicy,
  resolveExplicitDeepRetrievalPolicy,
} from "./retrieval-mode-policy.js";
import { packIntoBudget } from "./retrieval-orchestrator/packing.js";
import {
  applyPostRrfAdjustments,
  type FactMetadata,
  type FusedResult,
  fuseResults,
  type RankedResult,
  RRF_K_DEFAULT,
} from "./rrf-fusion.js";
import { sanitizePromptInjection } from "./skill-prompt-injection.js";
import { type ClusterFactLookup, detectClusters } from "./topic-clusters.js";

export { estimateTokenCount, packIntoBudget, serializeFactForContext } from "./retrieval-orchestrator/packing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from the orchestrator, ready for context injection. */
interface OrchestratorResult {
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

interface BuildExplicitSemanticQueryVectorDeps {
  query: string;
  cfg: Pick<
    import("../config.js").HybridMemoryConfig,
    "retrieval" | "queryExpansion" | "llm" | "embedding" | "distill" | "reflection"
  >;
  embeddings: import("./embeddings.js").EmbeddingProvider;
  openai: import("openai").default | null;
  pendingLLMWarnings: import("./chat.js").PendingLLMWarnings;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void };
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
    void import("./error-reporter.js")
      .then(({ addOperationBreadcrumb }) => addOperationBreadcrumb("retrieval", `${policy.mode}-vector-recall`))
      .catch((error: unknown) => {
        logger.debug?.(`memory-hybrid: failed to record retrieval breadcrumb: ${String(error)}`);
      });
    let textToEmbed = query;

    if (policy.allowHyde && cfg.queryExpansion.enabled) {
      textToEmbed = await expandQueryWithHyde({
        query,
        rawCfg: cfg as Parameters<typeof import("../config/index.js").getCronModelConfig>[0],
        model: cfg.queryExpansion.model,
        timeoutMs: cfg.queryExpansion.timeoutMs,
        openai: openai as any,
        label: "HyDE",
        pendingWarnings: pendingLLMWarnings,
        logger,
        subsystem: "retrieval",
        operation: "explicit-hyde-generation",
      });
    }

    return { queryVector: await embeddings.embed(textToEmbed), warning: null };
  } catch (err) {
    if (!shouldSuppressEmbeddingError(err)) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "retrieval",
        operation: "explicit-vector-embed",
      });
    }
    logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
    return {
      queryVector: null,
      warning: "Semantic search unavailable due to embedding failure; results may be incomplete.",
    };
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
  defaultRecallMode: "hybrid",
  recallLatencyWarnMs: 150,
  episodeCausalLatencyWarnMs: 30,
  contradictionLatencyWarnMs: 20,
};

// ---------------------------------------------------------------------------
// Individual strategy runners
// ---------------------------------------------------------------------------

/**
 * Run FTS5 full-text search strategy.
 * When candidateIds is provided (constrained-recall mode), only results within
 * that candidate set are returned and ranks are reassigned within that filtered set.
 * Returns ranked results (best = rank 1).
 */
function runFts5Strategy(
  db: DatabaseSync,
  query: string,
  limit: number,
  tagFilter?: string,
  includeSuperseded?: boolean,
  asOf?: number,
  candidateIds?: Set<string> | null,
): RankedResult[] {
  const effectiveLimit = candidateIds ? Math.max(limit * 5, 200) : limit;
  const results = searchFts(db, query, { limit: effectiveLimit, tagFilter, includeSuperseded, asOf });
  const filtered = candidateIds ? results.filter((r) => candidateIds.has(r.factId)) : results;
  return filtered.slice(0, limit).map((r, i) => ({
    factId: r.factId,
    rank: i + 1,
    source: "fts5" as const,
  }));
}

/**
 * Run semantic (vector) search strategy.
 * When candidateIds is provided (constrained-recall mode), only results within
 * that candidate set are returned and ranks are reassigned within that filtered set.
 * Returns ranked results (best = rank 1).
 */
async function runSemanticStrategy(
  vectorDb: VectorDB,
  queryVector: number[],
  topK: number,
  candidateIds?: Set<string> | null,
  nowSec?: number,
): Promise<RankedResult[]> {
  // Use a larger topK when filtering to account for candidates being filtered out
  const effectiveTopK = candidateIds ? Math.max(topK * 5, 200) : topK;
  const results: SearchResult[] = await vectorDb.search(queryVector, effectiveTopK, 0.3);
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const filtered = results.filter((r) => {
    if (candidateIds && !candidateIds.has(r.entry.id)) return false;
    if (r.entry.snoozedUntil != null && r.entry.snoozedUntil > now) return false;
    return true;
  });
  return filtered.slice(0, topK).map((r, i) => ({
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
  candidateIds?: Set<string> | null,
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
    const effectiveTopK = candidateIds ? Math.max(topK * 5, 200) : topK;
    const maxCandidatesPerModel = Math.max(effectiveTopK * 10, 500);
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
      .slice(0, effectiveTopK);

    const filtered = candidateIds ? scored.filter((r) => candidateIds.has(r.factId)) : scored;
    const finalResults = filtered.slice(0, topK);

    if (finalResults.length > 0) {
      result.set(
        `semantic:${name}`,
        finalResults.map((r, i) => ({
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
  let dot = 0;
  let normA = 0;
  let normB = 0;
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
  hubDegreeCap?: number | null,
  hubScorePenalty?: number | null,
): RankedResult[] {
  if (maxDepth <= 0 || seeds.length === 0 || !hasGraphLookup(factsDb)) return [];
  const { results: expanded } = expandGraph(factsDb, seeds, {
    maxDepth,
    scopeFilter,
    asOf,
    hubDegreeCap,
    hubScorePenalty,
  });
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
interface FactLookup {
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
const DEFAULT_SEMANTIC_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SEMANTIC_CACHE_MIN_SIMILARITY = 0.95;
const MAX_REWRITE_ITERATIONS = 2;

export function invalidateClusterCache(): void {
  clusterCache.invalidate();
}

type SemanticCacheCapableVectorDB = import("../backends/vector-db.js").VectorDB;

function describeEmbeddingRegistry(registry: EmbeddingRegistry | null | undefined): unknown {
  if (!registry) return null;

  const primaryModel = typeof registry.getPrimaryModel === "function" ? registry.getPrimaryModel() : null;
  const additionalModels =
    typeof registry.getModels === "function"
      ? registry
          .getModels()
          .map((model) => ({
            name: model.name,
            provider: model.provider,
            dimensions: model.dimensions,
            role: model.role ?? null,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : [];

  return {
    primaryModel,
    additionalModels,
    multiModel: typeof registry.isMultiModel === "function" ? registry.isMultiModel() : additionalModels.length > 0,
  };
}

function buildSemanticCacheFilterKey(
  config: RetrievalConfig,
  options: RetrievalPipelineOptions,
  policy: ExplicitDeepRetrievalPolicy | InteractiveRecallPolicy | ConstrainedRetrievalPolicy,
): string {
  const expanderMode =
    options.queryExpander && typeof (options.queryExpander as QueryExpander).getMode === "function"
      ? options.queryExpander.getMode()
      : options.queryExpander
        ? "always"
        : "off";
  const expanderThreshold =
    options.queryExpander && typeof (options.queryExpander as QueryExpander).getThreshold === "function"
      ? options.queryExpander.getThreshold()
      : null;

  return stableStringify({
    // Distinct retrieval modes/policies (interactive-recall vs. explicit-deep vs.
    // constrained-recall) enable different sets of RRF fusion/graph/alias/query expansion — a
    // cached result computed under one policy must never be served for a request resolved under
    // a different one (#storage-recall-review).
    policyMode: policy.mode,
    policyFlags: {
      allowRrfFusion: "allowRrfFusion" in policy ? policy.allowRrfFusion : null,
      allowGraphExpansion: "allowGraphExpansion" in policy ? policy.allowGraphExpansion : null,
      allowAliasExpansion: "allowAliasExpansion" in policy ? policy.allowAliasExpansion : null,
      allowQueryExpansion: "allowQueryExpansion" in policy ? policy.allowQueryExpansion : null,
      allowMultiModelSemantic: "allowMultiModelSemantic" in policy ? policy.allowMultiModelSemantic : null,
      allowHyde: "allowHyde" in policy ? policy.allowHyde : null,
      allowReranking: "allowReranking" in policy ? policy.allowReranking : null,
    },
    strategies: [...config.strategies].sort(),
    rrfK: config.rrf_k,
    semanticTopK: config.semanticTopK,
    fts5TopK: config.fts5TopK,
    graphWalkDepth: config.graphWalkDepth,
    tagFilter: options.tagFilter ?? null,
    includeSuperseded: options.includeSuperseded ?? false,
    scopeFilter: options.scopeFilter ?? null,
    asOf: options.asOf ?? null,
    clustersConfig: options.clustersConfig ?? null,
    rerankingAvailable: Boolean(options.rerankingConfig?.enabled && options.rerankingOpenai),
    rerankingConfig: options.rerankingConfig ?? null,
    documentGradingAvailable: Boolean(
      options.documentGrader || (options.documentGradingConfig?.enabled && options.adaptiveOpenai),
    ),
    documentGradingConfig: options.documentGradingConfig ?? null,
    documentGraderOverride: options.documentGrader ? (options.documentGrader.constructor?.name ?? "custom") : null,
    aliasDbEnabled: Boolean(options.aliasDb),
    queryExpansionMode: expanderMode,
    queryExpansionThreshold: expanderThreshold,
    queryExpansionContext: options.queryExpansionContext ?? null,
    embeddingRegistry: describeEmbeddingRegistry(options.embeddingRegistry),
    embeddingFactsEnabled: Boolean(options.factsDbForEmbeddings),
    constrainedFilters: options.constrainedFilters ?? null,
    warmTierOnly: options.warmTierOnly ?? false,
    graphHubDegreeCap: options.graphHubDegreeCap ?? null,
    graphHubScorePenalty: options.graphHubScorePenalty ?? null,
  });
}

function shouldPreferResult(
  candidate: { result: OrchestratorResult; shouldRewrite: boolean },
  incumbent: OrchestratorResult | null,
  incumbentWasIrrelevant: boolean,
): boolean {
  if (!incumbent) return true;

  const candidateHasRelevantDocs = !candidate.shouldRewrite;
  const incumbentHasRelevantDocs = !incumbentWasIrrelevant;
  if (candidateHasRelevantDocs !== incumbentHasRelevantDocs) {
    return candidateHasRelevantDocs;
  }

  if (candidate.result.fused.length !== incumbent.fused.length) {
    return candidate.result.fused.length > incumbent.fused.length;
  }

  return (candidate.result.fused[0]?.finalScore ?? 0) > (incumbent.fused[0]?.finalScore ?? 0);
}

function collectContradictedIds(
  factsDb: FactLookup,
  orderedEntries: Array<{ factId: string; entry: MemoryEntry }>,
): Set<string> {
  const contradictedIds = new Set<string>();
  if (factsDb.getContradictedIds) {
    const allIds = orderedEntries.map((entry) => entry.factId);
    const batch = factsDb.getContradictedIds(allIds);
    for (const id of batch) contradictedIds.add(id);
    return contradictedIds;
  }

  if (factsDb.isContradicted) {
    for (const { factId } of orderedEntries) {
      if (factsDb.isContradicted(factId)) contradictedIds.add(factId);
    }
  }

  return contradictedIds;
}

function buildOrchestratorResult(
  factsDb: FactLookup,
  fused: FusedResult[],
  orderedEntries: Array<{ factId: string; entry: MemoryEntry }>,
  budgetTokens: number,
  scopeFilter?: ScopeFilter,
): OrchestratorResult {
  const contradictedIds = collectContradictedIds(factsDb, orderedEntries);
  const provenanceByFactId = new Map<string, string>();
  for (const { factId, entry } of orderedEntries) {
    const provenance = parseFactProvenanceJson(entry.provenanceJson);
    // Source facts referenced by provenance must be re-checked against the caller's own scope —
    // a consolidated/derived fact can legitimately reference source facts from another
    // scope, and previewing their text here would leak them to a caller who couldn't
    // otherwise see them.
    const sourceFacts = resolveProvenanceSourceFacts(factsDb, provenance, 3, scopeFilter);
    if (sourceFacts.length === 0) continue;
    const preview = sourceFacts.map((s) => sanitizePromptInjection(s.text).slice(0, 40)).join("; ");
    provenanceByFactId.set(factId, `${sourceFacts.length} src: ${preview}`.slice(0, 120));
  }
  const { packed, tokensUsed } = packIntoBudget(orderedEntries, budgetTokens, {
    contradictedIds,
    provenanceByFactId,
  });
  const packedFactIds = orderedEntries.slice(0, packed.length).map((entry) => entry.factId);
  return {
    fused,
    packed,
    packedFactIds,
    tokensUsed,
    entries: orderedEntries.map((entry) => entry.entry),
  };
}

function buildCachedResult(
  factsDb: FactLookup,
  factIds: string[],
  budgetTokens: number,
  options: {
    includeSuperseded?: boolean;
    scopeFilter?: unknown;
    asOf?: number;
    nowSec: number;
    warmTierOnly?: boolean;
  },
): OrchestratorResult {
  const getByIdOpts =
    options.scopeFilter || options.asOf != null ? { scopeFilter: options.scopeFilter, asOf: options.asOf } : undefined;
  const effectiveNow = options.asOf ?? options.nowSec;

  const orderedEntries: Array<{ factId: string; entry: MemoryEntry }> = [];
  const fused: FusedResult[] = [];
  let acceptedCount = 0;

  for (const factId of factIds) {
    const entry = factsDb.getById(factId, getByIdOpts);
    if (!entry) continue;
    if (options.warmTierOnly && !isTierAllowedForWarmSearch(entry.tier)) continue;
    if (!options.includeSuperseded) {
      if (entry.supersededAt != null) continue;
      if (entry.expiresAt != null && entry.expiresAt <= effectiveNow) continue;
    }
    if (entry.snoozedUntil != null && entry.snoozedUntil > effectiveNow) continue;

    orderedEntries.push({ factId, entry });
    fused.push({
      factId,
      sources: [{ strategy: "semantic-cache", rank: acceptedCount + 1 }],
      finalScore: 1 / (acceptedCount + 1),
      rrfScore: 1 / (acceptedCount + 1),
    });
    acceptedCount++;
  }

  return buildOrchestratorResult(factsDb, fused, orderedEntries, budgetTokens, options.scopeFilter as ScopeFilter | undefined);
}

/**
 * Options bag for `runRetrievalPipeline`.
 *
 * All fields are optional. Required inputs (`query`, `queryVector`, `db`,
 * `vectorDb`, `factsDb`) are kept as positional parameters because they are
 * always needed; everything else lives here so callers can pass only what they
 * actually use — without placeholder nulls — and new strategies can be added
 * without touching every call site.
 */
export interface RetrievalPipelineOptions {
  /** Retrieval mode shortcut. When provided, derives the policy automatically.
   * 'interactive-recall' -> interactive recall policy (disables graph expansion).
   * 'explicit-deep' -> explicit deep retrieval policy.
   * 'constrained-recall' -> constrained retrieval policy (filter-before-rank).
   * Overridden by an explicit `policy` option. */
  mode?: import("./retrieval-mode-policy.js").RetrievalMode;
  /** Retrieval policy. Defaults to resolveExplicitDeepRetrievalPolicy(config). */
  policy?: ExplicitDeepRetrievalPolicy | InteractiveRecallPolicy | ConstrainedRetrievalPolicy;
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
  /** Optional semantic cache TTL. Defaults to 5 minutes. */
  semanticCacheTtlMs?: number;
  /** Optional semantic cache minimum cosine similarity. Defaults to 0.95. */
  semanticCacheMinSimilarity?: number;
  /** Optional query validator override. */
  queryValidator?: ((query: string) => QueryValidationResult | Promise<QueryValidationResult>) | null;
  /** Optional document grader override. */
  documentGrader?: DocumentGrader | null;
  /** OpenAI-compatible client for adaptive grading/rewrite loops. */
  adaptiveOpenai?: import("openai").default | null;
  /** Document grading configuration. */
  documentGradingConfig?: import("../config.js").DocumentGradingConfig | null;
  /** Structured pre-filters for constrained-recall mode.
   * When set, the pipeline first retrieves candidate fact IDs via SQLite structured filters,
   * then limits semantic/FTS5 ranking to only those candidates.
   * This implements the "filter → rank → hydrate" pattern (Issue #1026). */
  constrainedFilters?: import("../backends/facts-db/search.js").ConstrainedSearchFilters;
  /** Mirrors `graph.hubDegreeCap` for GraphRAG expansion (Issue #1192). */
  graphHubDegreeCap?: number | null;
  /** Mirrors `graph.hubScorePenalty` for GraphRAG expansion (Issue #1192). */
  graphHubScorePenalty?: number | null;
  /** Issue store for issue-aware RRF strategy and critical-issue candidate expansion (#1802). */
  issueStore?: IssueStore | null;
  /** Pre-filter fact IDs from NER entity-layer matching (#1802). Intersected with structured filters when both present. */
  entityLayerCandidateIds?: string[];
  /** When true, semantic cache entries and hydration exclude cold/structural tiers. */
  warmTierOnly?: boolean;
}

/**
 * Run the multi-strategy retrieval pipeline and return fused, ranked results.
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

  // Check if constrained mode has actual filters before selecting policy
  const hasConstrainedFilters = options.constrainedFilters && hasActiveFilters(options.constrainedFilters);

  let resolvedPolicy: ExplicitDeepRetrievalPolicy | InteractiveRecallPolicy | ConstrainedRetrievalPolicy;
  if (options.policy) {
    resolvedPolicy = options.policy as
      | ExplicitDeepRetrievalPolicy
      | InteractiveRecallPolicy
      | ConstrainedRetrievalPolicy;
  } else if (options.mode === "interactive-recall") {
    resolvedPolicy = DEFAULT_INTERACTIVE_RECALL_POLICY;
  } else if (options.mode === "constrained-recall" && hasConstrainedFilters) {
    resolvedPolicy = resolveConstrainedRetrievalPolicy(config, options.budgetTokens);
  } else {
    resolvedPolicy = resolveExplicitDeepRetrievalPolicy(config);
  }
  const policy = resolvedPolicy;
  const budgetTokens = options.budgetTokens ?? config.explicitBudgetTokens;
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
    semanticCacheTtlMs,
    semanticCacheMinSimilarity,
    queryValidator,
    documentGrader,
    adaptiveOpenai,
    documentGradingConfig,
    constrainedFilters,
    graphHubDegreeCap,
    graphHubScorePenalty,
    issueStore,
    entityLayerCandidateIds,
    warmTierOnly,
  } = options;

  const validator = queryValidator ?? validateQueryForMemoryLookup;
  const vectorDbWithCache = vectorDb as SemanticCacheCapableVectorDB;
  const semanticCacheFilterKey = buildSemanticCacheFilterKey(config, options, policy);
  const activeDocumentGrader =
    documentGrader ??
    (adaptiveOpenai && documentGradingConfig?.enabled
      ? new DocumentGrader(adaptiveOpenai, {
          model: documentGradingConfig.model,
          timeoutMs: documentGradingConfig.timeoutMs,
        })
      : null);

  // -------------------------------------------------------------------------
  // Constrained-recall: pre-filter candidate set before ranking (Issue #1026)
  // -------------------------------------------------------------------------
  let candidateIds: Set<string> | null = null;
  if (policy.mode === "constrained-recall" && constrainedFilters) {
    const ids = getCandidateIdsByStructuredFilters(db, constrainedFilters, { limit: 1000, nowSec });
    if (ids.length === 1000) {
      pluginLogger.warn("memory-hybrid: constrained-recall candidate set hit 1000 cap — results may be incomplete");
    }
    if (ids.length === 0 && !issueStore && !entityLayerCandidateIds?.length) {
      return { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] };
    }
    candidateIds = new Set(ids);
  }

  if (entityLayerCandidateIds && entityLayerCandidateIds.length > 0) {
    const layerSet = new Set(entityLayerCandidateIds);
    if (!candidateIds) {
      candidateIds = layerSet;
    } else {
      // Intersect only — do not widen constrained set when entity layer does not overlap.
      candidateIds = new Set([...candidateIds].filter((id) => layerSet.has(id)));
    }
  }

  // Expand constrained candidate set with facts linked to open critical/high issues.
  // Never set candidateIds in explicit-deep — that would restrict semantic/FTS to a tiny set.
  if (issueStore && policy.mode === "constrained-recall") {
    const issueFactIds = getCriticalOpenIssueFactIds(issueStore, 15);
    if (issueFactIds.length > 0) {
      if (!candidateIds) candidateIds = new Set(issueFactIds);
      else for (const id of issueFactIds) candidateIds.add(id);
    }
  }

  const applyConditionalReranking = async (
    queryText: string,
    initial: OrchestratorResult,
  ): Promise<OrchestratorResult> => {
    if (!(policy as ExplicitDeepRetrievalPolicy).allowReranking || !rerankingConfig?.enabled) return initial;
    const kind = rerankingConfig.kind ?? (rerankingConfig.enabled ? "llm" : "off");
    if (kind === "llm" && !rerankingOpenai) return initial;

    try {
      const rrfScoreMap = new Map(initial.fused.map((result) => [result.factId, result.finalScore]));
      const fusedEntryMap = new Map<string, MemoryEntry>(
        initial.fused
          .map((result, index) => [result.factId, initial.entries[index]] as [string, MemoryEntry])
          .filter(([, entry]) => entry != null),
      );
      const scoredFacts: ScoredFact[] = initial.fused.flatMap((result) => {
        const entry = fusedEntryMap.get(result.factId);
        if (!entry) return [];
        const storedSec = entry.sourceDate ?? entry.createdAt;
        return [
          {
            factId: result.factId,
            text: entry.text,
            confidence: entry.confidence,
            storedDate: formatDateUtc(storedSec),
            finalScore: rrfScoreMap.get(result.factId) ?? 0,
          },
        ];
      });
      const reranked = await rerankResults(
        queryText,
        scoredFacts,
        rerankingConfig,
        rerankingOpenai!,
        config.crossEncoder,
      );
      const orderedEntriesReranked = reranked
        .map((fact) => ({ factId: fact.factId, entry: fusedEntryMap.get(fact.factId)! }))
        .filter((entry) => entry.entry);
      const rerankedOrder = new Map(reranked.map((fact, index) => [fact.factId, index]));
      const fusedReranked = [...initial.fused]
        .filter((result) => rerankedOrder.has(result.factId))
        .sort(
          (a, b) =>
            (rerankedOrder.get(a.factId) ?? Number.POSITIVE_INFINITY) -
            (rerankedOrder.get(b.factId) ?? Number.POSITIVE_INFINITY),
        );
      return buildOrchestratorResult(
        factsDb,
        fusedReranked,
        orderedEntriesReranked,
        budgetTokens,
        options.scopeFilter as ScopeFilter | undefined,
      );
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "retrieval",
        operation: "reranking-conditional",
      });
      return initial;
    }
  };

  const runBasePipeline = async (
    queryText: string,
    currentQueryVector: number[] | null,
    expansion: {
      useLlm: boolean;
      variants: string[] | null;
      skipReranking?: boolean;
    },
  ): Promise<{ result: OrchestratorResult; shouldRewrite: boolean; fromCache: boolean }> => {
    const validation = await Promise.resolve(validator(queryText));
    if (!validation.requiresLookup) {
      return {
        result: { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] },
        shouldRewrite: false,
        fromCache: false,
      };
    }

    if (currentQueryVector && typeof vectorDbWithCache.getSemanticQueryCacheMatch === "function") {
      const cached = await vectorDbWithCache.getSemanticQueryCacheMatch(currentQueryVector, {
        ttlMs: semanticCacheTtlMs ?? DEFAULT_SEMANTIC_CACHE_TTL_MS,
        minSimilarity: semanticCacheMinSimilarity ?? DEFAULT_SEMANTIC_CACHE_MIN_SIMILARITY,
        filterKey: semanticCacheFilterKey,
      });
      if (cached) {
        const filteredFactIds = candidateIds ? cached.factIds.filter((id) => candidateIds.has(id)) : cached.factIds;
        const cachedResult = buildCachedResult(factsDb, filteredFactIds, budgetTokens, {
          includeSuperseded,
          scopeFilter,
          asOf,
          nowSec,
          warmTierOnly,
        });
        if (cachedResult.fused.length > 0) {
          return {
            result: cachedResult,
            shouldRewrite: false,
            fromCache: true,
          };
        }
      }
    }

    const k = config.rrf_k;
    const { strategies, semanticTopK, fts5TopK } = config;
    const strategyPromises: Array<Promise<[string, RankedResult[]]>> = [];

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
        safeStrategy("fts5", () =>
          runFts5Strategy(db, queryText, fts5TopK, tagFilter, includeSuperseded, asOf, candidateIds),
        ),
      );
    }

    if (strategies.includes("semantic") && currentQueryVector) {
      strategyPromises.push(
        safeStrategy("semantic", () =>
          runSemanticStrategy(vectorDb, currentQueryVector, semanticTopK, candidateIds, nowSec),
        ),
      );
    }

    if (issueStore && policy.mode !== "interactive-recall") {
      strategyPromises.push(
        safeStrategy("issues", () => {
          const results = runIssueRetrievalStrategy(queryText, issueStore, semanticTopK, factsDb);
          const filtered = candidateIds ? results.filter((r) => candidateIds?.has(r.factId)) : results;
          return filtered.map((r, i) => ({ ...r, rank: i + 1 }));
        }),
      );
    }

    if ((policy as ExplicitDeepRetrievalPolicy).allowAliasExpansion && aliasDb && currentQueryVector) {
      strategyPromises.push(
        safeStrategy("aliases", async () => {
          const results = await searchAliasStrategy(aliasDb, currentQueryVector, semanticTopK);
          const filtered = candidateIds ? results.filter((r) => candidateIds.has(r.factId)) : results;
          return filtered.map((r, i) => ({ ...r, rank: i + 1 }));
        }),
      );
    }

    if (
      (policy as ExplicitDeepRetrievalPolicy).allowQueryExpansion &&
      strategies.includes("semantic") &&
      currentQueryVector &&
      queryExpander &&
      embedFn
    ) {
      try {
        let additionalVariants: string[] = [];
        if (expansion.useLlm) {
          const variants = await queryExpander.expandQuery(queryText, queryExpansionContext);
          additionalVariants = variants.slice(1);
        } else if (expansion.variants && expansion.variants.length > 0) {
          additionalVariants = expansion.variants;
        }

        for (const [index, variantQuery] of additionalVariants.entries()) {
          const strategyName = `semantic:qe:${index}`;
          strategyPromises.push(
            safeStrategy(strategyName, async () => {
              const variantVector = await embedFn(variantQuery);
              return runSemanticStrategy(vectorDb, variantVector, semanticTopK, candidateIds, nowSec);
            }),
          );
        }
      } catch {
        // Graceful degradation — expansion failure never blocks retrieval.
      }
    }

    let multiModelPromise: Promise<Map<string, RankedResult[]>> | null = null;
    if (strategies.includes("semantic") && embeddingRegistry?.isMultiModel() && factsDbForEmbeddings) {
      multiModelPromise = runMultiModelSemanticStrategies(
        factsDbForEmbeddings,
        embeddingRegistry,
        queryText,
        semanticTopK,
        candidateIds,
      );
    }

    const strategySettledResults = await Promise.allSettled(strategyPromises);
    const strategyMap = new Map<string, RankedResult[]>();
    for (const settled of strategySettledResults) {
      if (settled.status === "rejected") continue;
      const [name, results] = settled.value;
      if (results.length > 0) strategyMap.set(name, results);
    }

    if (multiModelPromise) {
      try {
        const multiModelResults = await multiModelPromise;
        for (const [strategyName, results] of multiModelResults) {
          if (results.length > 0) strategyMap.set(strategyName, results);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "multi-model-semantic",
        });
      }
    }

    if ((policy as ExplicitDeepRetrievalPolicy).allowGraphExpansion && strategies.includes("graph")) {
      const seedScores = new Map<string, number>();
      const seedEntries = new Map<string, MemoryEntry>();
      const getByIdOpts = scopeFilter || asOf != null ? { scopeFilter, asOf } : undefined;

      for (const results of strategyMap.values()) {
        for (const result of results) {
          const entry = factsDb.getById(result.factId, getByIdOpts);
          if (!entry) continue;
          const score = 1 / (k + result.rank);
          const existing = seedScores.get(result.factId) ?? 0;
          seedScores.set(result.factId, existing + score);
          if (!seedEntries.has(result.factId)) seedEntries.set(result.factId, entry);
        }
      }

      const seeds = Array.from(seedScores.entries()).map(([factId, score]) => ({
        factId,
        score,
        entry: seedEntries.get(factId)!,
      }));
      const graphResults = runGraphStrategy(
        factsDb,
        seeds,
        config.graphWalkDepth,
        scopeFilter,
        asOf,
        graphHubDegreeCap,
        graphHubScorePenalty,
      );
      if (graphResults.length > 0) {
        strategyMap.set("graph", graphResults);
      }
    }

    let fused: import("./rrf-fusion.js").FusedResult[];
    if ((policy as ExplicitDeepRetrievalPolicy).allowRrfFusion) {
      fused = fuseResults(strategyMap, k);
    } else {
      const allResults = Array.from(strategyMap.values()).flat();
      const deduped = new Map<string, import("./rrf-fusion.js").FusedResult>();

      for (const res of allResults) {
        if (!deduped.has(res.factId)) {
          deduped.set(res.factId, {
            factId: res.factId,
            finalScore: 1 / (k + res.rank),
            rrfScore: 1 / (k + res.rank),

            sources: [{ strategy: res.source || "unknown", rank: res.rank }],
          });
        } else {
          const existing = deduped.get(res.factId)!;
          existing.sources.push({ strategy: res.source || "unknown", rank: res.rank });
          // The 1/(k+rank) score formula is the same regardless of which strategy produced the
          // hit — keep the best score across ALL strategies that found this fact, not just
          // "semantic" ones. A fact ranked #1 by fts5/issues/aliases must not lose to a worse
          // score kept only because the first-seen strategy happened to run first.
          const candidateScore = 1 / (k + res.rank);
          if (candidateScore > existing.finalScore) {
            existing.finalScore = candidateScore;
            existing.rrfScore = candidateScore;
          }
        }
      }

      fused = Array.from(deduped.values()).sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        return a.factId.localeCompare(b.factId);
      });
    }
    if (fused.length === 0) {
      return {
        result: { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] },
        shouldRewrite: false,
        fromCache: false,
      };
    }

    const getByIdOpts = scopeFilter || asOf != null ? { scopeFilter, asOf } : undefined;
    const factMetaMap = new Map<string, FactMetadata>();
    let orderedEntries: Array<{ factId: string; entry: MemoryEntry }> = [];
    const effectiveNow = asOf ?? nowSec;

    for (const result of fused) {
      const entry = factsDb.getById(result.factId, getByIdOpts);
      if (!entry) continue;
      if (!includeSuperseded) {
        if (entry.supersededAt != null) continue;
        if (entry.expiresAt != null && entry.expiresAt <= effectiveNow) continue;
      }
      if (entry.snoozedUntil != null && entry.snoozedUntil > effectiveNow) continue;
      factMetaMap.set(result.factId, {
        id: entry.id,
        confidence: entry.confidence,
        lastAccessed: entry.lastAccessed ?? null,
        recallCount: entry.recallCount ?? 0,
      });
      orderedEntries.push({ factId: result.factId, entry });
    }

    let scopedFused = fused.filter((result) => factMetaMap.has(result.factId));
    applyPostRrfAdjustments(scopedFused, factMetaMap, nowSec);

    if (clustersConfig?.enabled && hasClusterLookup(factsDb)) {
      try {
        const clusterByFact = clusterCache.getClusterMap(factsDb, clustersConfig.minClusterSize);
        if (clusterByFact.size > 0) {
          const clusterToIndices = new Map<string, number[]>();
          for (let index = 0; index < scopedFused.length; index++) {
            const clusterId = clusterByFact.get(scopedFused[index].factId);
            if (!clusterId) continue;
            const list = clusterToIndices.get(clusterId) ?? [];
            list.push(index);
            clusterToIndices.set(clusterId, list);
          }

          const BOOST_MULTIPLIER = 1.1;
          for (const indices of clusterToIndices.values()) {
            if (indices.length < 2) continue;
            let bestIndex = indices[0];
            for (const index of indices) {
              if (scopedFused[index].finalScore > scopedFused[bestIndex].finalScore) {
                bestIndex = index;
              }
            }
            for (const index of indices) {
              if (index === bestIndex) continue;
              scopedFused[index].finalScore *= BOOST_MULTIPLIER;
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

    const finalOrder = new Map<string, number>(scopedFused.map((result, index) => [result.factId, index]));
    orderedEntries.sort((a, b) => (finalOrder.get(a.factId) ?? 0) - (finalOrder.get(b.factId) ?? 0));

    if (activeDocumentGrader && orderedEntries.length > 0) {
      const grades = await activeDocumentGrader.gradeDocuments(
        queryText,
        orderedEntries.map(({ factId, entry }) => ({ factId, text: entry.text })),
      );
      if (grades.length > 0) {
        if (grades.every((grade) => !grade.relevant)) {
          return {
            result: buildOrchestratorResult(
              factsDb,
              scopedFused,
              [],
              budgetTokens,
              options.scopeFilter as ScopeFilter | undefined,
            ),
            shouldRewrite: true,
            fromCache: false,
          };
        }
        const relevantFactIds = new Set(grades.filter((grade) => grade.relevant).map((grade) => grade.factId));
        orderedEntries = orderedEntries.filter(({ factId }) => relevantFactIds.has(factId));
        scopedFused = scopedFused.filter((result) => relevantFactIds.has(result.factId));
      }
    }

    if (rerankingConfig?.enabled && !expansion.skipReranking) {
      const kind = rerankingConfig.kind ?? (rerankingConfig.enabled ? "llm" : "off");
      if (kind === "llm" && !rerankingOpenai) {
        // Skip reranking if LLM mode requires OpenAI but it's not available
      } else {
        try {
          const rrfScoreMap = new Map<string, number>(scopedFused.map((result) => [result.factId, result.finalScore]));
          const scoredFacts: ScoredFact[] = orderedEntries.map(({ factId, entry }) => {
            const storedSec = entry.sourceDate ?? entry.createdAt;
            return {
              factId,
              text: entry.text,
              confidence: entry.confidence,
              storedDate: formatDateUtc(storedSec),
              finalScore: rrfScoreMap.get(factId) ?? 0,
            };
          });

          const reranked = await rerankResults(
            queryText,
            scoredFacts,
            rerankingConfig,
            rerankingOpenai!,
            config.crossEncoder,
          );
          const rerankedOrder = new Map(reranked.map((fact, index) => [fact.factId, index]));
          orderedEntries.sort(
            (a, b) =>
              (rerankedOrder.get(a.factId) ?? Number.POSITIVE_INFINITY) -
              (rerankedOrder.get(b.factId) ?? Number.POSITIVE_INFINITY),
          );
          if (orderedEntries.length > reranked.length) {
            orderedEntries.length = reranked.length;
          }
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
    }

    return {
      result: buildOrchestratorResult(
        factsDb,
        scopedFused,
        orderedEntries,
        budgetTokens,
        options.scopeFilter as ScopeFilter | undefined,
      ),
      shouldRewrite: false,
      fromCache: false,
    };
  };

  const executePipelineQuery = async (
    queryText: string,
    currentQueryVector: number[] | null,
  ): Promise<{ result: OrchestratorResult; shouldRewrite: boolean; fromCache: boolean }> => {
    const expanderMode =
      queryExpander && typeof (queryExpander as QueryExpander).getMode === "function"
        ? queryExpander.getMode()
        : queryExpander
          ? "always"
          : "off";

    if (expanderMode === "conditional") {
      const alias =
        queryExpander && typeof (queryExpander as QueryExpander).getRuleBasedAlias === "function"
          ? queryExpander.getRuleBasedAlias(queryText)
          : null;
      const initial = await runBasePipeline(queryText, currentQueryVector, {
        useLlm: false,
        variants: alias ? [alias] : [],
        skipReranking: true,
      });
      const threshold =
        queryExpander && typeof (queryExpander as QueryExpander).getThreshold === "function"
          ? queryExpander.getThreshold()
          : 0.03;
      const topScore = initial.result.fused[0]?.finalScore ?? 0;
      if (initial.shouldRewrite || topScore < threshold) {
        return runBasePipeline(queryText, currentQueryVector, { useLlm: true, variants: null, skipReranking: false });
      }
      return { ...initial, result: await applyConditionalReranking(queryText, initial.result) };
    }

    if (expanderMode === "always") {
      return runBasePipeline(queryText, currentQueryVector, { useLlm: true, variants: null });
    }

    return runBasePipeline(queryText, currentQueryVector, { useLlm: false, variants: [] });
  };

  const attemptedQueries = [query];
  let currentQuery = query;
  let currentQueryVector = queryVector;
  let bestResult: OrchestratorResult | null = null;
  let bestResultWasIrrelevant = false;

  for (let iteration = 0; iteration <= MAX_REWRITE_ITERATIONS; iteration++) {
    const run = await executePipelineQuery(currentQuery, currentQueryVector);

    if (shouldPreferResult(run, bestResult, bestResultWasIrrelevant)) {
      bestResult = run.result;
      bestResultWasIrrelevant = run.shouldRewrite;
    }

    if (!run.shouldRewrite || !activeDocumentGrader) {
      if (
        !run.fromCache &&
        currentQueryVector &&
        run.result.fused.length > 0 &&
        typeof vectorDbWithCache.storeSemanticQueryCache === "function"
      ) {
        await vectorDbWithCache.storeSemanticQueryCache({
          queryText: currentQuery,
          vector: currentQueryVector,
          factIds: run.result.fused.map((result) => result.factId),
          filterKey: semanticCacheFilterKey,
          cachedAt: nowSec,
        });
      }
      return bestResult ?? run.result;
    }

    if (iteration === MAX_REWRITE_ITERATIONS) {
      return bestResult ?? run.result;
    }

    const rewritten = await activeDocumentGrader.rewriteQuery(query, attemptedQueries);
    if (!rewritten) {
      return bestResult ?? run.result;
    }

    attemptedQueries.push(rewritten);
    currentQuery = rewritten;
    if (embedFn) {
      try {
        currentQueryVector = await embedFn(rewritten);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "retrieval",
          operation: "rewrite-embed",
        });
        currentQueryVector = null;
      }
    } else {
      currentQueryVector = null;
    }
  }

  return bestResult ?? { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] };
}

/** @deprecated Use runExplicitDeepRetrieval instead */
export const runRetrievalPipeline = runExplicitDeepRetrieval;
