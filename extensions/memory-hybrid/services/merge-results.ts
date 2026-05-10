/**
 * Merge SQLite and LanceDB search results using Reciprocal Rank Fusion (RRF).
 * LanceDB results should be pre-filtered by scope before merging (SQLite results are already filtered).
 *
 * RRF (Cormack et al., 2009): rank-based fusion so BM25 and cosine scores (incompatible scales)
 * are comparable. rrf_score = sum(1/(k + rank)) per result; items ranking well in BOTH lists
 * naturally float to the top. Default k=60 (standard constant).
 */

import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";

/** RRF constant (default 60). Higher k = less penalty for lower ranks. */
export const RRF_K_DEFAULT = 60;

/** Optional provider for active/superseded state checks (e.g. FactsDB). */
interface MergeStateProvider {
  getById?: (id: string) => MemoryEntry | null;
  /** @deprecated Legacy fallback kept for compatibility with older tests/mocks. */
  getSupersededTexts?: () => Set<string>;
}

/** Optional merge options (RRF k constant). */
interface MergeOptions {
  /** RRF constant for rank fusion (default 60) */
  k?: number;
}

/**
 * Filter LanceDB results by scope.
 *
 * Delegates to `getById(id, { scopeFilter })`, which returns `null` when the fact
 * is outside the requested scope. This allows the caller to reuse the existing
 * SQLite scope-query logic without duplicating it here.
 *
 * @param results - LanceDB results to filter.
 * @param getById - Lookup function; returns `null` when the fact is out of scope.
 * @param scopeFilter - Scope constraints (userId / agentId / sessionId). Pass `null`
 *   or `undefined` (or an empty object) to skip filtering entirely.
 * @returns The subset of `results` that are within the requested scope.
 */
export function filterByScope<T extends SearchResult>(
  results: T[],
  getById: (id: string, opts?: { scopeFilter?: ScopeFilter | null }) => unknown,
  scopeFilter: ScopeFilter | null | undefined,
): T[] {
  if (!scopeFilter || (!scopeFilter.userId && !scopeFilter.agentId && !scopeFilter.sessionId)) {
    return results;
  }
  return results.filter((r) => getById(r.entry.id, { scopeFilter }) != null);
}

/**
 * Merge SQLite FTS5 and LanceDB vector search results using Reciprocal Rank Fusion (RRF).
 *
 * ## Algorithm
 * 1. Sort each backend's results by their native score (BM25 or cosine).
 * 2. Assign 1-based ranks within each list.
 * 3. Deduplicate across backends (ID first, then case-insensitive text). SQLite is processed
 *    first, so SQLite wins when both backends return the same fact.
 * 4. Filter out inactive facts (superseded/expired/missing) by fact ID when `factsDb.getById`
 *    is available. Legacy fallback: text-based superseded filter for older mocks.
 * 5. For each remaining fact, compute `rrf_score = Σ 1/(k + rank)` over all lists it appears in.
 * 6. Sort by `rrf_score` descending; break ties by recency (sourceDate or createdAt), then
 *    by backend (sqlite > lancedb).
 * 7. Return the top `limit` results with `score` replaced by the RRF score.
 *
 * @param sqliteResults - Results from SQLite FTS5 BM25 search (already scope-filtered).
 * @param lanceResults  - Results from LanceDB cosine search (pre-filtered by scope via
 *   `filterByScope` before calling this function).
 * @param limit         - Maximum number of results to return.
 * @param factsDb       - Optional provider of fact activity state. When `getById` is present,
 *   inactive rows are excluded by ID/state. Legacy fallback: text-based superseded filtering.
 * @param options       - Optional RRF tuning: `{ k }` (default `RRF_K_DEFAULT = 60`).
 * @returns Up to `limit` merged results sorted by RRF score descending.
 */
export function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
  factsDb?: MergeStateProvider,
  options?: MergeOptions,
): SearchResult[] {
  const k = options?.k ?? RRF_K_DEFAULT;
  const nowSec = Math.floor(Date.now() / 1000);
  const supersededTexts =
    factsDb && typeof factsDb.getById !== "function" && typeof factsDb.getSupersededTexts === "function"
      ? factsDb.getSupersededTexts()
      : new Set<string>();

  const isInactive = (result: SearchResult): boolean => {
    if (factsDb && typeof factsDb.getById === "function") {
      const entry = factsDb.getById(result.entry.id);
      if (!entry) return true;
      if (entry.supersededAt != null) return true;
      if (entry.expiresAt != null && entry.expiresAt <= nowSec) return true;
      return false;
    }
    const norm = result.entry.text.toLowerCase();
    return supersededTexts.has(norm);
  };

  // Rank SQLite by BM25 score descending (higher = rank 1)
  const sqliteRanked = [...sqliteResults].sort((a, b) => b.score - a.score);
  // Rank LanceDB by cosine similarity descending
  const lanceRanked = [...lanceResults].sort((a, b) => b.score - a.score);

  // Build rank maps: id -> rank (1-based) in each list
  const sqliteRankById = new Map<string, number>();
  const lanceRankById = new Map<string, number>();
  const sqliteRankByText = new Map<string, number>();
  const lanceRankByText = new Map<string, number>();

  sqliteRanked.forEach((r, i) => {
    const rank = i + 1;
    sqliteRankById.set(r.entry.id, rank);
    sqliteRankByText.set(r.entry.text.toLowerCase(), rank);
  });
  lanceRanked.forEach((r, i) => {
    const rank = i + 1;
    lanceRankById.set(r.entry.id, rank);
    lanceRankByText.set(r.entry.text.toLowerCase(), rank);
  });

  // Collect unique results with RRF score; prefer first occurrence (SQLite then Lance)
  const byId = new Map<string, SearchResult>();
  const byText = new Map<string, string>(); // normalized text -> id

  for (const r of sqliteResults) {
    if (isInactive(r)) continue;
    const norm = r.entry.text.toLowerCase();
    if (!byId.has(r.entry.id) && !byText.has(norm)) {
      byId.set(r.entry.id, r);
      byText.set(norm, r.entry.id);
    }
  }
  for (const r of lanceResults) {
    if (isInactive(r)) continue;
    const norm = r.entry.text.toLowerCase();
    const existingId = byText.get(norm);
    if (existingId) continue; // dedupe by text (case-insensitive)
    if (byId.has(r.entry.id)) continue; // dedupe by id
    byId.set(r.entry.id, r);
    byText.set(norm, r.entry.id);
  }

  // Compute RRF score for each: sum 1/(k+rank) across lists
  const withRrf: Array<{ r: SearchResult; rrfScore: number }> = [];
  for (const r of byId.values()) {
    const norm = r.entry.text.toLowerCase();
    let rrfScore = 0;
    const sqliteRank = sqliteRankById.get(r.entry.id) ?? sqliteRankByText.get(norm);
    const lanceRank = lanceRankById.get(r.entry.id) ?? lanceRankByText.get(norm);
    if (sqliteRank != null) rrfScore += 1 / (k + sqliteRank);
    if (lanceRank != null) rrfScore += 1 / (k + lanceRank);
    withRrf.push({ r, rrfScore });
  }

  withRrf.sort((a, b) => {
    const s = b.rrfScore - a.rrfScore;
    if (s !== 0) return s;
    const da = a.r.entry.sourceDate ?? a.r.entry.createdAt;
    const db = b.r.entry.sourceDate ?? b.r.entry.createdAt;
    if (da !== db) return db - da; // newer first
    // Stable tie-break: prefer sqlite over lancedb
    return (a.r.backend === "sqlite" ? 0 : 1) - (b.r.backend === "sqlite" ? 0 : 1);
  });

  // Return results with score replaced by RRF (for display consistency)
  return withRrf.slice(0, limit).map(({ r, rrfScore }) => ({ ...r, score: rrfScore }));
}
