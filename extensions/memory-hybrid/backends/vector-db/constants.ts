export const LANCE_TABLE = "memories";
export const SEMANTIC_QUERY_CACHE_TABLE = "semantic_query_cache";
export const SEMANTIC_QUERY_CACHE_MAX_ROWS_PER_FILTER_KEY = 100;
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
