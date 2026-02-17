/**
 * FR-005: Dynamic Salience Scoring (Access-Based Importance)
 *
 * Combines:
 * 1. Access Boost — frequently recalled facts score higher
 * 2. Time Decay — older, unused memories fade in relevance
 */

import type { MemoryEntry } from "../types/memory.js";
import { SECONDS_PER_DAY } from "./constants.js";

/** Default half-life in days: after this many days without access, salience halves. */
export const SALIENCE_DECAY_HALF_LIFE_DAYS = 30;

/**
 * Compute dynamic salience multiplier for a base score.
 * Combines access boost (recall_count) and time decay (last_accessed).
 *
 * @param baseScore — Original relevance score (0–1)
 * @param entry — Memory with recallCount, lastAccessed, importance
 * @param options — Optional overrides
 * @returns Adjusted score
 */
export function computeDynamicSalience(
  baseScore: number,
  entry: MemoryEntry,
  options?: {
    /** Apply access boost (default true) */
    accessBoost?: boolean;
    /** Apply time decay (default true) */
    timeDecay?: boolean;
    /** Half-life in days for decay (default 30) */
    halfLifeDays?: number;
    /** Access boost strength (default 0.1) */
    accessBoostStrength?: number;
  },
): number {
  const {
    accessBoost = true,
    timeDecay = true,
    halfLifeDays = SALIENCE_DECAY_HALF_LIFE_DAYS,
    accessBoostStrength = 0.1,
  } = options ?? {};

  let s = baseScore;

  // 1. Access Boost: frequently recalled facts score higher
  if (accessBoost) {
    const recallCount = entry.recallCount ?? 0;
    if (recallCount > 0) {
      s *= 1 + accessBoostStrength * Math.log(recallCount + 1);
    }
  }

  // 2. Time Decay: older, unused memories fade
  if (timeDecay) {
    const nowSec = Math.floor(Date.now() / 1000);
    const lastAccess = entry.lastAccessed ?? entry.lastConfirmedAt ?? entry.createdAt;
    const daysSinceAccess = (nowSec - lastAccess) / SECONDS_PER_DAY;
    // decay = 1 / (1 + days / halfLife) — reciprocal decay (not exponential)
    // At halfLife days: factor = 0.5
    const decayFactor = 1 / (1 + daysSinceAccess / halfLifeDays);
    s *= decayFactor;
  }

  return Math.min(1, Math.max(0, s));
}
