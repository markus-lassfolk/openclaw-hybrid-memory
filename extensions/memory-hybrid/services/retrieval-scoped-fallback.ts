/**
 * Scoped FTS + vector fallback when the explicit RRF pipeline fails.
 * Preserves tier and scope filters (unlike raw legacy mergeResults-only paths).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ScopeFilter, SearchResult } from "../types/memory.js";
import { isTierAllowedForWarmSearch } from "../utils/tier-filter.js";
import { filterByScope, mergeResults } from "./merge-results.js";

export type ScopedRetrievalFallbackParams = {
  query: string;
  limit: number;
  queryVector: number[] | null;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  recallOpts: {
    tag?: string;
    includeSuperseded?: boolean;
    tierFilter?: "warm" | "all";
    scopeFilter?: ScopeFilter | null;
    asOf?: number;
  };
  scopeFilter: ScopeFilter | null | undefined;
  warmTierOnly: boolean;
  seedResults?: SearchResult[];
  reinforcementBoost?: number;
  diversityWeight?: number;
  vectorMinScore?: number;
};

export async function runScopedFtsVectorFallback(params: ScopedRetrievalFallbackParams): Promise<SearchResult[]> {
  const {
    query,
    limit,
    queryVector,
    factsDb,
    vectorDb,
    recallOpts,
    scopeFilter,
    warmTierOnly,
    seedResults = [],
    reinforcementBoost = 0.1,
    diversityWeight = 1.0,
    vectorMinScore = 0.3,
  } = params;

  const ftsResults = factsDb.search(query, limit, {
    ...recallOpts,
    reinforcementBoost,
    diversityWeight,
  });

  let lanceResults: SearchResult[] = [];
  if (queryVector) {
    lanceResults = await vectorDb.search(queryVector, limit * 3, vectorMinScore);
    lanceResults = filterByScope(lanceResults, (id, opts) => factsDb.getById(id, opts), scopeFilter);
    if (warmTierOnly) {
      lanceResults = lanceResults.filter((r) => {
        const full = factsDb.getById(r.entry.id);
        return full != null && isTierAllowedForWarmSearch(full.tier);
      });
    }
  }

  let merged = mergeResults([...seedResults, ...ftsResults], lanceResults, limit, factsDb);
  if (warmTierOnly && merged.length > 0) {
    merged = merged
      .filter((r) => {
        const full = factsDb.getById(r.entry.id);
        return full != null && isTierAllowedForWarmSearch(full.tier);
      })
      .slice(0, limit);
  }
  return merged;
}
