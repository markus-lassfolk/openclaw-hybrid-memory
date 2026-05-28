import { getEnv } from "../../utils/env-manager.js";

function parseBoundedPositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = getEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export const LANCE_TABLE = "memories";
export const SEMANTIC_QUERY_CACHE_TABLE = "semantic_query_cache";
/**
 * Per-filter cap for semantic query cache rows.
 * Operator override: OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_MAX_ROWS_PER_FILTER_KEY.
 */
export const SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY = parseBoundedPositiveIntEnv(
  "OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_MAX_ROWS_PER_FILTER_KEY",
  100,
  10,
  5000,
);
/**
 * Upper bound for semantic-query-cache candidate vectors loaded per lookup.
 * Operator override: OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_CANDIDATE_LIMIT_MAX.
 */
export const SEMANTIC_QUERY_CACHE_CANDIDATE_LIMIT_MAX = parseBoundedPositiveIntEnv(
  "OPENCLAW_HYBRID_MEM_SEMANTIC_CACHE_CANDIDATE_LIMIT_MAX",
  200,
  10,
  5000,
);
/**
 * Hard ceiling for rows fetched per vector search call.
 * Operator override: OPENCLAW_HYBRID_MEM_VECTOR_QUERY_MAX_RESULTS.
 * Keeps Arrow/Lance result materialization bounded under recall-heavy workloads.
 */
export const VECTOR_QUERY_MAX_RESULTS = parseBoundedPositiveIntEnv(
  "OPENCLAW_HYBRID_MEM_VECTOR_QUERY_MAX_RESULTS",
  200,
  10,
  5000,
);
export const VECTOR_BULK_DELETE_IN_CHUNK = 200;

export type VectorDBLogger = { warn: (msg: string) => void };

export interface SemanticQueryCacheEntry {
  id: string;
  queryText: string;
  factIds: string[];
  cachedAt: number;
  similarity: number;
  filterKey: string;
}

export const optimizingByPath = new Map<string, boolean>();
export const optimizeFailuresByPath = new Map<string, number>();
export const autoOptimizePauseByPath = new Map<string, number>();
