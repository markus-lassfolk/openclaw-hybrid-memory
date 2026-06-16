/**
 * Recall quality signals (Issue #1916).
 */

import type { DatabaseSync } from "node:sqlite";

export type RecallSignalConfig = {
  crossDomainMinQueries: number;
  spacedRecallMinDays: number;
  neverReferencedThreshold: number;
  neverReferencedWindowDays: number;
};

export const DEFAULT_RECALL_SIGNAL_CONFIG: RecallSignalConfig = {
  crossDomainMinQueries: 3,
  spacedRecallMinDays: 3,
  neverReferencedThreshold: 5,
  neverReferencedWindowDays: 30,
};

/** Cross-domain relevance boost when fact surfaced by ≥ N distinct queries. */
export function computeCrossDomainBoost(distinctQueryCount: number, minQueries: number): number {
  if (distinctQueryCount < minQueries) return 0;
  return Math.min(0.15, 0.03 * (distinctQueryCount - minQueries + 1));
}

/** Spaced recall flag: surfaced across ≥ M distinct calendar days. */
export function hasSpacedRecall(distinctDays: number, minDays: number): boolean {
  return distinctDays >= minDays;
}

/** Auto-snooze candidate: surfaced > K times but never referenced. */
export function isNeverReferencedCandidate(
  surfaceCount: number,
  referenceCount: number,
  threshold: number,
): boolean {
  return surfaceCount >= threshold && referenceCount === 0;
}

export type FactRecallStats = {
  factId: string;
  distinctQueries: number;
  distinctDays: number;
  surfaceCount: number;
  referenceCount: number;
};

/** Aggregate recall_events stats per fact (last N days). */
export function aggregateRecallStats(
  db: DatabaseSync,
  windowDays = 30,
): Map<string, FactRecallStats> {
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const rows = db
    .prepare(
      `SELECT fact_ids, query, occurred_at FROM recall_events WHERE occurred_at >= ? AND hit = 1`,
    )
    .all(cutoff) as Array<{ fact_ids: string; query: string | null; occurred_at: number }>;

  const stats = new Map<string, FactRecallStats>();
  for (const row of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.fact_ids) as string[];
    } catch {
      continue;
    }
    const day = Math.floor(row.occurred_at / 86_400);
    for (const factId of ids) {
      let s = stats.get(factId);
      if (!s) {
        s = {
          factId,
          distinctQueries: 0,
          distinctDays: 0,
          surfaceCount: 0,
          referenceCount: 0,
        };
        stats.set(factId, s);
      }
      s.surfaceCount++;
    }
  }
  return stats;
}

export function getSnoozeCandidates(
  db: DatabaseSync,
  config: RecallSignalConfig = DEFAULT_RECALL_SIGNAL_CONFIG,
): string[] {
  const stats = aggregateRecallStats(db, config.neverReferencedWindowDays);
  const candidates: string[] = [];
  for (const s of stats.values()) {
    if (isNeverReferencedCandidate(s.surfaceCount, s.referenceCount, config.neverReferencedThreshold)) {
      candidates.push(s.factId);
    }
  }
  return candidates;
}
