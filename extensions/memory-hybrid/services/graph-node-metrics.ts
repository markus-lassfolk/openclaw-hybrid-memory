/**
 * Query-independent node metrics for the Memory Graph constellation layout.
 *
 * `computeNodeStrength` gives each fact an intrinsic "strength" (higher → nearer the center) by
 * reusing the retrieval composite-score formula (services/composite-score.ts) with importance as
 * the base salience — there is no active query at graph-render time — plus recency from last
 * access and pin/frequency boosts. This is the single source of truth for the radial layout radius
 * and node sizing so the client and any server-side ranking agree.
 */
import type { MemoryEntry } from "../types/memory.js";
import {
  type CompositeScoreConfig,
  computeCompositeScore,
  computeFrequencyBoost,
  recencyScoreFromDays,
} from "./composite-score.js";

const DAY_SEC = 86_400;

const NODE_STRENGTH_CONFIG: CompositeScoreConfig = {
  version: 2,
  pinBoostDefault: 0.3,
  pinBoostCap: 1.0,
};

/** Epoch seconds of the fact's most recent access, falling back to creation time. */
function lastAccessSec(fact: MemoryEntry): number {
  if (typeof fact.lastAccessed === "number" && fact.lastAccessed > 0) return fact.lastAccessed;
  if (fact.lastAccessedAt) {
    const parsed = Date.parse(fact.lastAccessedAt);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return fact.createdAt;
}

/** Intrinsic strength of a fact for the constellation layout (higher = stronger = more central). */
export function computeNodeStrength(fact: MemoryEntry, nowSec: number): number {
  const daysSince = Math.max(0, (nowSec - lastAccessSec(fact)) / DAY_SEC);
  return computeCompositeScore(
    {
      searchScore: fact.importance,
      recencyScore: recencyScoreFromDays(daysSince),
      confidence: fact.confidence,
      bodyLength: fact.text.length,
      intent: "GENERAL",
      // Recall count is a frequency signal; +1 so a single recall still nudges strength up.
      freqBoost: computeFrequencyBoost((fact.recallCount ?? 0) + 1, 1),
      pinBoost: fact.pinnedAt ? NODE_STRENGTH_CONFIG.pinBoostDefault : 0,
    },
    NODE_STRENGTH_CONFIG,
  );
}
