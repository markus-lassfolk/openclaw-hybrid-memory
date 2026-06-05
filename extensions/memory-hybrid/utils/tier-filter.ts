import type { MemoryTier } from "../types/memory.js";

/** Tiers eligible for default warm-tier FTS + hybrid auto-recall (excludes cold and structural). */
export function isTierAllowedForWarmSearch(tier: MemoryTier | null | undefined): boolean {
  const resolved = tier ?? "warm";
  return resolved === "warm" || resolved === "hot";
}
