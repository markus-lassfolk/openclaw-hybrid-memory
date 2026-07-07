/**
 * Recall quality signals (Issue #1916).
 */

import type { DatabaseSync } from "node:sqlite";
import { scopeFilterClausePositional } from "../backends/facts-db/scope-sql.js";
import type { ScopeFilter } from "../types/memory.js";

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

type RecallEventRow = { fact_ids: string; query: string | null; occurred_at: number };

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
export function isNeverReferencedCandidate(surfaceCount: number, referenceCount: number, threshold: number): boolean {
  return surfaceCount >= threshold && referenceCount === 0;
}

export type FactRecallStats = {
  factId: string;
  distinctQueries: number;
  distinctDays: number;
  surfaceCount: number;
  referenceCount: number;
};

function fetchRecallEventRows(db: DatabaseSync, windowDays: number): RecallEventRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  return db
    .prepare("SELECT fact_ids, query, occurred_at FROM recall_events WHERE occurred_at >= ? AND hit = 1")
    .all(cutoff) as RecallEventRow[];
}

function buildRecallStatsFromRows(
  rows: RecallEventRow[],
  db: DatabaseSync,
  scopeFilter?: ScopeFilter | null,
): Map<string, FactRecallStats> {
  const stats = new Map<string, FactRecallStats>();
  for (const row of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.fact_ids) as string[];
    } catch {
      continue;
    }
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

  const queryDayTracker = new Map<string, Set<string>>();
  const dayTracker = new Map<string, Set<number>>();
  for (const row of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.fact_ids) as string[];
    } catch {
      continue;
    }
    const day = Math.floor(row.occurred_at / 86_400);
    const query = row.query?.trim() || "";
    if (query) {
      for (const factId of ids) {
        const key = `${factId}:${query}`;
        if (!queryDayTracker.has(key)) {
          queryDayTracker.set(key, new Set());
        }
        queryDayTracker.get(key)?.add(`${day}`);
      }
    }
    for (const factId of ids) {
      if (!dayTracker.has(factId)) {
        dayTracker.set(factId, new Set());
      }
      dayTracker.get(factId)?.add(day);
    }
  }

  for (const [factId, s] of stats.entries()) {
    const uniqueQueries = new Set<string>();
    for (const key of queryDayTracker.keys()) {
      if (key.startsWith(`${factId}:`)) {
        uniqueQueries.add(key);
      }
    }
    s.distinctQueries = uniqueQueries.size;
    s.distinctDays = dayTracker.get(factId)?.size ?? 0;
  }

  enrichReferenceCountsFromFacts(db, stats, scopeFilter);

  return stats;
}

/** Aggregate recall_events stats per fact (last N days). */
export function aggregateRecallStats(
  db: DatabaseSync,
  windowDays = 30,
  scopeFilter?: ScopeFilter | null,
): Map<string, FactRecallStats> {
  return buildRecallStatsFromRows(fetchRecallEventRows(db, windowDays), db, scopeFilter);
}

/**
 * Map confirmed access (full injection / explicit recall) onto recall-event surface stats.
 *
 * `recall_events` itself has no scope/tenant column (only `session_key`), so it can't be
 * scope-filtered directly -- but every fact id it references still resolves against the scoped
 * `facts` table here. Facts that don't resolve in-scope (another tenant's, or since deleted) are
 * dropped from `stats` entirely rather than left with a zero reference count, so they can never
 * influence a scoped caller's snooze-candidate list or cross-domain-boost score.
 */
export function enrichReferenceCountsFromFacts(
  db: DatabaseSync,
  stats: Map<string, FactRecallStats>,
  scopeFilter?: ScopeFilter | null,
): void {
  const factIds = [...stats.keys()];
  if (factIds.length === 0) return;

  const { clause: scopeClause, params: scopeParams } = scopeFilterClausePositional(scopeFilter);
  const inScopeIds = new Set<string>();
  const BATCH = 500;
  for (let i = 0; i < factIds.length; i += BATCH) {
    const batch = factIds.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, COALESCE(access_count, 0) AS access_count FROM facts WHERE id IN (${placeholders})${scopeClause}`,
      )
      .all(...batch, ...scopeParams) as Array<{ id: string; access_count: number }>;
    for (const row of rows) {
      const s = stats.get(row.id);
      if (s) s.referenceCount = row.access_count;
      inScopeIds.add(row.id);
    }
  }
  for (const factId of factIds) {
    if (!inScopeIds.has(factId)) stats.delete(factId);
  }
}

/** Filter snooze candidates from pre-aggregated stats. */
export function snoozeCandidatesFromStats(
  stats: Map<string, FactRecallStats>,
  config: RecallSignalConfig = DEFAULT_RECALL_SIGNAL_CONFIG,
): string[] {
  const candidates: string[] = [];
  for (const s of stats.values()) {
    if (isNeverReferencedCandidate(s.surfaceCount, s.referenceCount, config.neverReferencedThreshold)) {
      candidates.push(s.factId);
    }
  }
  return candidates;
}

export function getSnoozeCandidates(
  db: DatabaseSync,
  config: RecallSignalConfig = DEFAULT_RECALL_SIGNAL_CONFIG,
  scopeFilter?: ScopeFilter | null,
): string[] {
  const stats = aggregateRecallStats(db, config.neverReferencedWindowDays, scopeFilter);
  return snoozeCandidatesFromStats(stats, config);
}

export type RecallSignalsSnapshot = {
  schemaVersion: 1;
  windowDays: number;
  autoSnoozeCandidates: number;
  neverReferencedSurfaced: number;
  crossDomainHubs: number;
  snoozeCandidateIds: string[];
};

/** Dashboard / doctor snapshot for recall feedback (#1916). */
export function getRecallSignalsSnapshot(
  db: DatabaseSync,
  windowDays = 7,
  config: RecallSignalConfig = DEFAULT_RECALL_SIGNAL_CONFIG,
): RecallSignalsSnapshot {
  const fetchWindow = Math.max(windowDays, config.neverReferencedWindowDays);
  const rows = fetchRecallEventRows(db, fetchWindow);
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshotCutoff = nowSec - windowDays * 86_400;
  const snoozeCutoff = nowSec - config.neverReferencedWindowDays * 86_400;

  const snapshotRows = fetchWindow === windowDays ? rows : rows.filter((r) => r.occurred_at >= snapshotCutoff);
  const stats = buildRecallStatsFromRows(snapshotRows, db);

  let crossDomainHubs = 0;
  let neverReferencedSurfaced = 0;
  for (const s of stats.values()) {
    if (s.distinctQueries >= config.crossDomainMinQueries) crossDomainHubs++;
    if (isNeverReferencedCandidate(s.surfaceCount, s.referenceCount, config.neverReferencedThreshold)) {
      neverReferencedSurfaced++;
    }
  }

  const snoozeStats =
    windowDays === config.neverReferencedWindowDays
      ? stats
      : buildRecallStatsFromRows(
          fetchWindow === config.neverReferencedWindowDays ? rows : rows.filter((r) => r.occurred_at >= snoozeCutoff),
          db,
        );
  const snoozeCandidateIds = snoozeCandidatesFromStats(snoozeStats, config);

  return {
    schemaVersion: 1,
    windowDays,
    autoSnoozeCandidates: snoozeCandidateIds.length,
    neverReferencedSurfaced,
    crossDomainHubs,
    snoozeCandidateIds: snoozeCandidateIds.slice(0, 20),
  };
}
