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
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of sqliteResults) {
    if (!seenIds.has(r.entry.id)) {
      seenIds.add(r.entry.id);
      seenTexts.add(r.entry.text.toLowerCase());
      merged.push(r);
    }
  }

  const supersededTexts = factsDb ? factsDb.getSupersededTexts() : new Set<string>();

  for (const r of lanceResults) {
    const normalizedText = r.entry.text.toLowerCase();
    const isSuperseded = supersededTexts.has(normalizedText);
    const isDupe = seenIds.has(r.entry.id) || seenTexts.has(normalizedText);
    if (!isDupe && !isSuperseded) {
      seenIds.add(r.entry.id);
      seenTexts.add(normalizedText);
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
