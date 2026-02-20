/**
 * Merge SQLite and LanceDB search results using Reciprocal Rank Fusion (RRF).
 * LanceDB results should be pre-filtered by scope before merging (SQLite results are already filtered).
 *
 * RRF (Cormack et al., 2009): rank-based fusion so BM25 and cosine scores (incompatible scales)
 * are comparable. rrf_score = sum(1/(k + rank)) per result; items ranking well in BOTH lists
 * naturally float to the top. Default k=60 (standard constant).
 */

import type { SearchResult, ScopeFilter } from "../types/memory.js";

/** RRF constant (default 60). Higher k = less penalty for lower ranks. */
export const RRF_K_DEFAULT = 60;

/** Optional provider for superseded fact texts (e.g. FactsDB). */
export interface SupersededProvider {
  getSupersededTexts(): Set<string>;
}

/** Optional merge options (RRF k constant). */
export interface MergeOptions {
  /** RRF constant for rank fusion (default 60) */
  k?: number;
}

/** Filter LanceDB results by scope. Uses getById(id, { scopeFilter }) — returns null when not in scope. */
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

export function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
  factsDb?: SupersededProvider,
  options?: MergeOptions,
): SearchResult[] {
  const k = options?.k ?? RRF_K_DEFAULT;
  const supersededTexts = factsDb ? factsDb.getSupersededTexts() : new Set<string>();

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
    const norm = r.entry.text.toLowerCase();
    if (supersededTexts.has(norm)) continue;
    if (!byId.has(r.entry.id) && !byText.has(norm)) {
      byId.set(r.entry.id, r);
      byText.set(norm, r.entry.id);
    }
  }
  for (const r of lanceResults) {
    const norm = r.entry.text.toLowerCase();
    if (supersededTexts.has(norm)) continue;
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
