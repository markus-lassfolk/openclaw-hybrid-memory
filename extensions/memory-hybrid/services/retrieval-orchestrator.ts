/**
 * Multi-Strategy Retrieval Orchestrator (Issue #152).
 *
 * Runs configured retrieval strategies in parallel, fuses results via RRF,
 * applies post-RRF score adjustments, and packs results into a token budget.
 *
 * Strategies:
 *   - semantic: LanceDB vector similarity search
 *   - fts5: SQLite FTS5 full-text search (Issue #151)
 *   - graph: Graph-walk spreading activation (stub — full GraphRAG is #145)
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
import type { RetrievalConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from the orchestrator, ready for context injection. */
export interface OrchestratorResult {
  /** Fused and adjusted results, sorted by finalScore descending. */
  fused: FusedResult[];
  /** Serialized fact strings packed into the token budget, highest scored first. */
  packed: string[];
  /** Total tokens used by the packed results (approximate: chars / 4). */
  tokensUsed: number;
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
 */
export function serializeFactForContext(entry: MemoryEntry): string {
  const parts: string[] = [];

  if (entry.entity) parts.push(`entity: ${entry.entity}`);
  parts.push(`category: ${entry.category}`);
  parts.push(`confidence: ${entry.confidence.toFixed(2)}`);

  const storedSec = entry.sourceDate ?? entry.createdAt;
  const storedDate = new Date(storedSec * 1000).toISOString().slice(0, 10);
  parts.push(`stored: ${storedDate}`);

  const header = `[${parts.join(" | ")}]`;
  return `${header}\n${entry.text}`;
}

// ---------------------------------------------------------------------------
// Token budget packing
// ---------------------------------------------------------------------------

/**
 * Pack serialized facts into a token budget, highest-scored first.
 *
 * @param entries - Ordered list of (factId, entry) pairs, best-scored first.
 * @param budgetTokens - Maximum token budget.
 * @returns Object with packed strings and total tokens used.
 */
export function packIntoBudget(
  entries: Array<{ factId: string; entry: MemoryEntry }>,
  budgetTokens: number,
): { packed: string[]; tokensUsed: number } {
  const packed: string[] = [];
  let tokensUsed = 0;

  for (const { entry } of entries) {
    const serialized = serializeFactForContext(entry);
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
): RankedResult[] {
  const results = searchFts(db, query, { limit, tagFilter, includeSuperseded });
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
 * Graph walk strategy stub.
 * Full GraphRAG implementation is tracked in issue #145.
 * Returns empty results gracefully.
 */
function runGraphStrategy(): RankedResult[] {
  return [];
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
}

/**
 * Run the multi-strategy retrieval pipeline and return fused, ranked results.
 *
 * Steps:
 * 1. Run configured strategies in parallel (semantic, fts5, graph stub).
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
): Promise<OrchestratorResult> {
  const k = config.rrf_k;
  const { strategies, semanticTopK, fts5TopK } = config;

  // --- Run strategies in parallel ---
  const strategyPromises: Array<Promise<[string, RankedResult[]]>> = [];

  if (strategies.includes("fts5")) {
    strategyPromises.push(
      Promise.resolve([
        "fts5",
        runFts5Strategy(db, query, fts5TopK, tagFilter, includeSuperseded),
      ] as [string, RankedResult[]]),
    );
  }

  if (strategies.includes("semantic") && queryVector) {
    strategyPromises.push(
      runSemanticStrategy(vectorDb, queryVector, semanticTopK).then(
        (r) => ["semantic", r] as [string, RankedResult[]],
      ),
    );
  }

  if (strategies.includes("graph")) {
    strategyPromises.push(
      Promise.resolve(["graph", runGraphStrategy()] as [string, RankedResult[]]),
    );
  }

  const strategyResults = await Promise.all(strategyPromises);

  // Build strategy map
  const strategyMap = new Map<string, RankedResult[]>();
  for (const [name, results] of strategyResults) {
    if (results.length > 0) {
      strategyMap.set(name, results);
    }
  }

  // --- RRF Fusion ---
  const fused = fuseResults(strategyMap, k);

  if (fused.length === 0) {
    return { fused: [], packed: [], tokensUsed: 0 };
  }

  // --- Build metadata map for post-RRF adjustments ---
  // Apply scope and asOf filters when resolving fused fact IDs to prevent returning
  // facts from outside the caller's scope (scope/session/agent boundary enforcement).
  const getByIdOpts = (scopeFilter || asOf != null)
    ? { scopeFilter, asOf }
    : undefined;

  const factMetaMap = new Map<string, FactMetadata>();
  const orderedEntries: Array<{ factId: string; entry: MemoryEntry }> = [];

  for (const result of fused) {
    const entry = factsDb.getById(result.factId, getByIdOpts);
    if (entry) {
      factMetaMap.set(result.factId, {
        id: entry.id,
        confidence: entry.confidence,
        lastAccessed: entry.lastAccessed ?? null,
        recallCount: entry.recallCount ?? 0,
      });
      orderedEntries.push({ factId: result.factId, entry });
    }
  }

  // Filter fused array to remove out-of-scope facts that were not resolved
  const scopedFused = fused.filter((result) => factMetaMap.has(result.factId));

  // --- Post-RRF adjustments ---
  applyPostRrfAdjustments(scopedFused, factMetaMap, nowSec);

  // Re-sort entries to match final order
  const finalOrder = new Map<string, number>(scopedFused.map((r, i) => [r.factId, i]));
  orderedEntries.sort((a, b) => (finalOrder.get(a.factId) ?? 0) - (finalOrder.get(b.factId) ?? 0));

  // --- Token budget packing ---
  const { packed, tokensUsed } = packIntoBudget(orderedEntries, budgetTokens);

  return { fused: scopedFused, packed, tokensUsed };
}
