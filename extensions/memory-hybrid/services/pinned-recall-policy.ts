/**
 * Shared pinning policy for progressive_hybrid and pre-compaction constraint injection (#1559).
 */

import type { MemoryEntry } from "../types/memory.js";

export function shouldPinFactForInjection(
  entry: Pick<MemoryEntry, "decayClass" | "recallCount" | "indexedCount" | "lastAccessed">,
  pinnedRecallThreshold: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (entry.decayClass === "permanent") return true;

  const recallCount = entry.recallCount ?? 0;
  const indexedCount = entry.indexedCount ?? 0;
  const lastAccessed = entry.lastAccessed ?? 0;
  const lastAccessedDaysAgo = lastAccessed > 0 ? (nowSec - lastAccessed) / 86400 : Number.POSITIVE_INFINITY;
  const isRecentlyAccessed = lastAccessedDaysAgo < 14;
  const indexInflationRatio = recallCount > 0 ? indexedCount / recallCount : indexedCount;
  const likelyIndexGarbage = indexInflationRatio > 10 && indexedCount > 50;

  return recallCount >= pinnedRecallThreshold && isRecentlyAccessed && !likelyIndexGarbage;
}
