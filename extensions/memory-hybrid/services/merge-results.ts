/**
 * Merge SQLite and LanceDB search results, deduplicate, and apply superseded filter.
 */

import type { SearchResult } from "../types/memory.js";

/** Optional provider for superseded fact texts (e.g. FactsDB). */
export interface SupersededProvider {
  getSupersededTexts(): Set<string>;
}

export function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
  factsDb?: SupersededProvider,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of sqliteResults) {
    if (!seen.has(r.entry.id)) {
      seen.add(r.entry.id);
      merged.push(r);
    }
  }

  const supersededTexts = factsDb ? factsDb.getSupersededTexts() : new Set<string>();

  for (const r of lanceResults) {
    const isSuperseded = supersededTexts.has(r.entry.text.toLowerCase());
    const isDupe = merged.some(
      (m) =>
        m.entry.id === r.entry.id ||
        m.entry.text.toLowerCase() === r.entry.text.toLowerCase(),
    );
    if (!isDupe && !isSuperseded) {
      merged.push(r);
    }
  }

  merged.sort((a, b) => {
    const s = b.score - a.score;
    if (s !== 0) return s;
    const da = a.entry.sourceDate ?? a.entry.createdAt;
    const db = b.entry.sourceDate ?? b.entry.createdAt;
    return db - da;
  });
  return merged.slice(0, limit);
}
