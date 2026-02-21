/**
 * Vector search service: find similar memories by embedding.
 */

import type { VectorDB } from "../backends/vector.js";
import type { MemoryEntry } from "../types/memory.js";

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
): Promise<MemoryEntry[]> {
  const results = await vectorDb.search(vector, limit, minScore);
  const entries: MemoryEntry[] = [];
  for (const r of results) {
    const entry = factsDb.getById(r.entry.id);
    if (entry && entry.supersededAt == null) entries.push(entry);
  }
  return entries;
}
