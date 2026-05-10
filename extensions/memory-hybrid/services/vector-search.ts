/**
 * Vector search service: find similar memories by embedding.
 */

import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryEntry, MemoryScope } from "../types/memory.js";

type ScopedClassificationOptions = {
  scope?: MemoryScope;
  scopeTarget?: string | null;
};

function matchesExactScope(
  entry: MemoryEntry,
  scope: MemoryScope,
  scopeTarget: string | null,
): boolean {
  const entryScope = entry.scope ?? "global";
  const entryScopeTarget = entry.scopeTarget ?? null;
  if (scope === "global") {
    return entryScope === "global";
  }
  return entryScope === scope && entryScopeTarget === scopeTarget;
}

/**
 * Find similar memories by embedding vector.
 * Returns entries that are not superseded.
 */
export async function findSimilarByEmbedding(
  vectorDb: VectorDB,
  factsDb: { getById(id: string): MemoryEntry | null },
  vector: number[],
  limit: number,
  minScore = 0.3,
  options?: ScopedClassificationOptions,
): Promise<MemoryEntry[]> {
  const scope = options?.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (options?.scopeTarget ?? null);
  const results = await vectorDb.search(vector, limit, minScore);
  const entries: MemoryEntry[] = [];
  for (const r of results) {
    const entry = factsDb.getById(r.entry.id);
    if (entry && entry.supersededAt == null && matchesExactScope(entry, scope, scopeTarget)) entries.push(entry);
  }
  return entries;
}
