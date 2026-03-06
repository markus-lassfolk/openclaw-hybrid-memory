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

import type Database from "better-sqlite3";
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
import type { RetrievalConfig, ClustersConfig } from "../config.js";
import type { QueryExpander } from "./query-expander.js";
import { searchAliasStrategy, type AliasDB } from "./retrieval-aliases.js";
import { detectClusters, type ClusterFactLookup } from "./topic-clusters.js";
import { expandGraph, type GraphFactLookup } from "./graph-retrieval.js";
import type { EmbeddingRegistry } from "./embedding-registry.js";

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
  db: Database.Database,
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
async function runSemanticStrategy(
  vectorDb: VectorDB,
  queryVector: number[],
  topK: number,
): Promise<RankedResult[]> {
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
      console.error(`[retrieval] multi-model embed failed for a model:`, s.reason);
      continue;
    }
    const { name, queryVec } = s.value;
    const candidates = factsDbWithEmbeddings.getEmbeddingsByModel(name);
    if (candidates.length === 0) continue;

    // Compute cosine similarity for all stored embeddings
    const scored = candidates
      .map(({ factId, embedding }) => ({
        factId,
        score: cosineSimilarity(queryVec, embedding),
      }))
      .filter((r) => r.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (scored.length > 0) {
      result.set(`semantic:${name}`, scored.map((r, i) => ({
        factId: r.factId,
        rank: i + 1,
        source: `semantic:${name}` as const,
      })));
    }
  }
  return result;
}

/** Compute cosine similarity between two Float32Arrays. Returns [-1, 1]. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
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
  getEmbeddingsByModel(model: string): Array<{ factId: string; embedding: Float32Array }>;
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

  getClusterMap(
    factsDb: FactLookup & ClusterFactLookup,
    minClusterSize?: number,
  ): Map<string, string> {
    const now = Date.now();
    const linkCount = typeof factsDb.linksCount === "function" ? factsDb.linksCount() : null;
    if (this.clusterCache && now - this.clusterCache.timestamp < this.ttlMs) {
      if ((linkCount == null || linkCount === this.clusterCacheLinkCount) &&
          this.clusterCache.minClusterSize === minClusterSize) {
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
 * @param db - better-sqlite3 Database instance for FTS5 queries.
 * @param vectorDb - LanceDB VectorDB instance for semantic queries.
 * @param factsDb - FactsDB for metadata lookup.
 * @param config - Retrieval pipeline configuration.
 * @param budgetTokens - Token budget for packing (overrides config defaults).
 * @param nowSec - Current time as epoch seconds (default: Date.now()/1000).
 * @param tagFilter - Optional tag constraint to propagate into FTS5 strategy.
 * @param includeSuperseded - Whether to include superseded facts (default false).
 * @param scopeFilter - Scope constraints applied when resolving fused fact IDs.
 * @param asOf - Temporal filter applied when resolving fused fact IDs.
 * @param embeddingRegistry - Optional multi-model registry (Issue #158). When provided and
 *   has additional models registered, each model contributes a separate RRF strategy.
 * @param factsDbForEmbeddings - Optional access to fact_embeddings table (Issue #158).
 * @param queryExpander - Optional query expander instance (Issue #160). When provided and
 *   expansion is enabled, generates variant queries and adds each as a separate RRF strategy.
 * @param embedFn - Optional function to embed text (Issue #160). Required for expansion to work.
 * @param queryExpansionContext - Optional recent conversation context to improve expansion quality.
 */
export async function runRetrievalPipeline(
  query: string,
  queryVector: number[] | null,
  db: Database.Database,
  vectorDb: VectorDB,
  factsDb: FactLookup,
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  budgetTokens: number = config.explicitBudgetTokens,
  nowSec: number = Math.floor(Date.now() / 1000),
  tagFilter?: string,
  includeSuperseded?: boolean,
  scopeFilter?: unknown,
  asOf?: number,
  aliasDb?: AliasDB | null,
  clustersConfig?: ClustersConfig,
  embeddingRegistry?: EmbeddingRegistry | null,
  factsDbForEmbeddings?: FactsDbWithEmbeddings | null,
  queryExpander?: QueryExpander | null,
  embedFn?: ((text: string) => Promise<number[]>) | null,
  queryExpansionContext?: string,
): Promise<OrchestratorResult> {
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
        // Log and return empty so other strategies still contribute
        console.error(`[retrieval] strategy "${name}" failed:`, err);
        return [name, []] as [string, RankedResult[]];
      }
    })();

  if (strategies.includes("fts5")) {
    strategyPromises.push(
      safeStrategy("fts5", () =>
        runFts5Strategy(db, query, fts5TopK, tagFilter, includeSuperseded, asOf),
      ),
    );
  }

  if (strategies.includes("semantic") && queryVector) {
    strategyPromises.push(
      safeStrategy("semantic", () =>
        runSemanticStrategy(vectorDb, queryVector, semanticTopK),
      ),
    );
  }

  // Issue #149: alias search — participates in RRF fusion as "aliases" strategy
  if (aliasDb && queryVector) {
    strategyPromises.push(
      safeStrategy("aliases", () =>
        searchAliasStrategy(aliasDb, queryVector, semanticTopK),
      ),
    );
  }

  // Issue #160: query expansion — generate variant queries, embed each, run semantic search.
  // Only runs when semantic strategy is active, expander is provided, and embedFn is available.
  if (strategies.includes("semantic") && queryVector && queryExpander && embedFn) {
    try {
      const variants = await queryExpander.expandQuery(query, queryExpansionContext);
      // variants[0] is always the original query (already handled above); expand from index 1.
      const additionalVariants = variants.slice(1);
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
    } catch {
      // Graceful degradation — expansion failure never blocks retrieval
    }
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

  // Issue #158: multi-model semantic strategies — each additional model is a separate RRF lane.
  // Only runs when registry has additional models and we have access to the fact_embeddings table.
  if (
    strategies.includes("semantic") &&
    embeddingRegistry &&
    embeddingRegistry.isMultiModel() &&
    factsDbForEmbeddings
  ) {
    try {
      const multiModelResults = await runMultiModelSemanticStrategies(
        factsDbForEmbeddings,
        embeddingRegistry,
        query,
        semanticTopK,
      );
      for (const [strategyName, results] of multiModelResults) {
        if (results.length > 0) {
          strategyMap.set(strategyName, results);
        }
      }
    } catch (err) {
      console.error("[retrieval] multi-model semantic strategy failed:", err);
    }
  }

  // Graph walk strategy (Issue #152) — expand from semantic/FTS5 seeds
  if (strategies.includes("graph")) {
    const seedScores = new Map<string, number>();
    const seedEntries = new Map<string, MemoryEntry>();
    const getByIdOpts = (scopeFilter || asOf != null)
      ? { scopeFilter, asOf }
      : undefined;

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
  const fused = fuseResults(strategyMap, k);

  if (fused.length === 0) {
    return { fused: [], packed: [], packedFactIds: [], tokensUsed: 0, entries: [] };
  }

  // --- Build metadata map for post-RRF adjustments ---
  // Apply scope and asOf filters when resolving fused fact IDs to prevent returning
  // facts from outside the caller's scope (scope/session/agent boundary enforcement).
  const getByIdOpts = (scopeFilter || asOf != null)
    ? { scopeFilter, asOf }
    : undefined;

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
      const clusterByFact = clusterCache.getClusterMap(
        factsDb,
        clustersConfig.minClusterSize,
      );
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
      // Log via stderr without leaking query content; cluster boost is non-critical
      console.error("[retrieval] cluster boost failed");
    }
  }

  // Re-sort entries to match final order
  const finalOrder = new Map<string, number>(scopedFused.map((r, i) => [r.factId, i]));
  orderedEntries.sort((a, b) => (finalOrder.get(a.factId) ?? 0) - (finalOrder.get(b.factId) ?? 0));

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
}
