/**
 * Vector search service: find similar memories by embedding.
 */

import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryEntry, MemoryScope } from "../types/memory.js";
import { matchesExactScope } from "./classification-scope.js";

export type ScopedClassificationOptions = {
  scope?: MemoryScope;
  scopeTarget?: string | null;
};

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
  const scope = options?.scope;
  const scopeTarget = scope === undefined || scope === "global" ? null : (options?.scopeTarget ?? null);
  const searchLimit = Math.min(Math.max(limit * 4, limit), 200);
  const results = await vectorDb.search(vector, searchLimit, minScore);
  const entries: MemoryEntry[] = [];
  for (const r of results) {
    const entry = factsDb.getById(r.entry.id);
    if (!entry || entry.supersededAt != null) continue;
    if (scope !== undefined && !matchesExactScope(entry, scope, scopeTarget)) continue;
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}
