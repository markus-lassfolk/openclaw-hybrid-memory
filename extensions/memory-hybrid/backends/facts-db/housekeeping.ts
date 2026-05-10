/**
 * Misc DB ops: pruning logs, stats helpers, scope pruning (Issue #954 split).
 */
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { MemoryEntry, ScopeFilter } from "../../types/memory.js";
import { getLanguageKeywordsFilePath } from "../../utils/language-keywords.js";
import { rowToMemoryEntry } from "./row-mapper.js";

export function pruneOrphanedLinks(db: DatabaseSync): number {
  const result = db
    .prepare(
      `DELETE FROM memory_links
         WHERE NOT EXISTS (SELECT 1 FROM facts WHERE facts.id = memory_links.source_fact_id)
            OR NOT EXISTS (SELECT 1 FROM facts WHERE facts.id = memory_links.target_fact_id)`,
    )
    .run();
  return Number(result.changes ?? 0);
}

/**
 * SQL COUNT of active (non-superseded, non-expired) facts for a given category.
 * Replaces the previous O(n) approach of loading all rows and filtering in JS.
 */
export function countActiveFactsByCategory(db: DatabaseSync, category: string): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM facts
         WHERE category = ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(category, nowSec) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function pruneLogTables(db: DatabaseSync, retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const recall = db.prepare("DELETE FROM recall_log WHERE occurred_at < ?").run(cutoff);
  const reinforcement = db.prepare("DELETE FROM reinforcement_log WHERE occurred_at < ?").run(cutoff);
  const feedback = db.prepare("DELETE FROM feedback_trajectories WHERE created_at < ?").run(cutoff);
  return Number(recall.changes ?? 0) + Number(reinforcement.changes ?? 0) + Number(feedback.changes ?? 0);
}

export function optimizeFts(db: DatabaseSync): void {
  db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('optimize')`);
}

export function vacuumAndCheckpoint(db: DatabaseSync): void {
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function statsReflection(db: DatabaseSync): {
  reflectionPatternsCount: number;
  reflectionRulesCount: number;
} {
  const patternsRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'reflection' AND category = 'pattern'`,
    )
    .get() as { count: number } | undefined;
  const rulesRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'reflection' AND category = 'rule'`,
    )
    .get() as { count: number } | undefined;
  return {
    reflectionPatternsCount: patternsRow?.count ?? 0,
    reflectionRulesCount: rulesRow?.count ?? 0,
  };
}

export function selfCorrectionIncidentsCount(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'self-correction'`)
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function countSupersededFacts(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NOT NULL`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

export function countVerifiedFacts(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM verified_facts").get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/** Number of active (non-superseded, non-expired) facts created at-or-after `sinceSec`. */
export function countActiveFactsCreatedSince(db: DatabaseSync, sinceSec: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM facts
         WHERE superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND created_at >= ?`,
    )
    .get(nowSec, sinceSec) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Recent ingestion activity for the rich `stats` view. Cheap (3× COUNT). */
export function recentActivity(db: DatabaseSync): {
  last24h: number;
  last7d: number;
  last30d: number;
  newestCreatedAtSec: number | null;
  oldestActiveCreatedAtSec: number | null;
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const day = 86400;
  const last24h = countActiveFactsCreatedSince(db, nowSec - day);
  const last7d = countActiveFactsCreatedSince(db, nowSec - 7 * day);
  const last30d = countActiveFactsCreatedSince(db, nowSec - 30 * day);
  const minMaxRow = db
    .prepare(
      `SELECT MIN(created_at) as min_ts, MAX(created_at) as max_ts FROM facts
         WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec) as { min_ts: number | null; max_ts: number | null } | undefined;
  return {
    last24h,
    last7d,
    last30d,
    newestCreatedAtSec: minMaxRow?.max_ts ?? null,
    oldestActiveCreatedAtSec: minMaxRow?.min_ts ?? null,
  };
}

export function countBySource(db: DatabaseSync, source: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = ?")
    .get(source) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function languageKeywordsCount(): number {
  const filePath = getLanguageKeywordsFilePath();
  if (!filePath || !existsSync(filePath)) return 0;

  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    let count = 0;

    const translations = data.translations ?? {};
    for (const lang of Object.values(translations)) {
      for (const [_key, val] of Object.entries(lang as Record<string, unknown>)) {
        if (Array.isArray(val)) count += val.length;
      }
    }

    const triggerStructures = data.triggerStructures ?? {};
    for (const val of Object.values(triggerStructures)) {
      if (Array.isArray(val)) count += val.length;
    }

    const directiveSignals = data.directiveSignalsByCategory ?? {};
    for (const val of Object.values(directiveSignals)) {
      if (Array.isArray(val)) count += val.length;
    }

    const reinforcementCategories = data.reinforcementCategories ?? {};
    for (const val of Object.values(reinforcementCategories)) {
      if (Array.isArray(val)) count += val.length;
    }

    return count;
  } catch {
    return 0;
  }
}

export function statsBySource(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare("SELECT source, COUNT(*) as count FROM facts WHERE superseded_at IS NULL GROUP BY source")
    .all() as Array<{ source: string; count: number }>;
  return Object.fromEntries(rows.map((r) => [r.source, r.count]));
}

export function uniqueScopes(db: DatabaseSync): Array<{ scope: string; scopeTarget: string | null }> {
  const rows = db
    .prepare("SELECT DISTINCT scope, scope_target as scopeTarget FROM facts WHERE scope IS NOT NULL")
    .all() as Array<{ scope: string; scopeTarget: string | null }>;
  return rows;
}

export function scopeStats(db: DatabaseSync): Array<{
  scope: string;
  scopeTarget: string | null;
  count: number;
}> {
  const rows = db
    .prepare(
      "SELECT scope, scope_target as scopeTarget, COUNT(*) as count FROM facts WHERE scope IS NOT NULL GROUP BY scope, scope_target",
    )
    .all() as Array<{
    scope: string;
    scopeTarget: string | null;
    count: number;
  }>;
  return rows;
}

/**
 * Return all fact IDs that `pruneScopedFacts(scopeFilter)` would delete.
 * Use this *before* calling `pruneScopedFacts` to gather IDs for vector cleanup.
 * Excludes pinned facts in `verified_facts` (same guard as the DELETE).
 */
export function listScopedFactIdsPendingPrune(db: DatabaseSync, scopeFilter: ScopeFilter): string[] {
  const conditions: string[] = [];
  const params: (string | null)[] = [];

  if (scopeFilter.userId !== undefined) {
    conditions.push(`(scope = 'user' AND scope_target = ?)`);
    params.push(scopeFilter.userId);
  }
  if (scopeFilter.agentId !== undefined) {
    conditions.push(`(scope = 'agent' AND scope_target = ?)`);
    params.push(scopeFilter.agentId);
  }
  if (scopeFilter.sessionId !== undefined) {
    conditions.push(`(scope = 'session' AND scope_target = ?)`);
    params.push(scopeFilter.sessionId);
  }

  if (conditions.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT id FROM facts
         WHERE (${conditions.join(" OR ")})
           AND id NOT IN (SELECT fact_id FROM verified_facts)`,
    )
    .all(...params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function pruneScopedFacts(db: DatabaseSync, scopeFilter: ScopeFilter): number {
  const conditions: string[] = [];
  const params: (string | null)[] = [];

  if (scopeFilter.userId !== undefined) {
    conditions.push(`(scope = 'user' AND scope_target = ?)`);
    params.push(scopeFilter.userId);
  }
  if (scopeFilter.agentId !== undefined) {
    conditions.push(`(scope = 'agent' AND scope_target = ?)`);
    params.push(scopeFilter.agentId);
  }
  if (scopeFilter.sessionId !== undefined) {
    conditions.push(`(scope = 'session' AND scope_target = ?)`);
    params.push(scopeFilter.sessionId);
  }

  if (conditions.length === 0) return 0;

  const linkCleanupQuery = `DELETE FROM memory_links
      WHERE target_fact_id IN (
        SELECT id FROM facts WHERE (${conditions.join(" OR ")})
          AND id NOT IN (SELECT fact_id FROM verified_facts)
      )
      AND link_type != 'DERIVED_FROM'`;
  db.prepare(linkCleanupQuery).run(...params);

  const query = `DELETE FROM facts WHERE (${conditions.join(" OR ")})
    AND id NOT IN (SELECT fact_id FROM verified_facts)`;
  const result = db.prepare(query).run(...params);
  return Number(result.changes ?? 0);
}

export function findSessionFactsForPromotion(
  db: DatabaseSync,
  thresholdDays: number,
  minImportance: number,
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const thresholdSec = nowSec - thresholdDays * 86400;
  const rows = db
    .prepare(
      `SELECT * FROM facts
         WHERE scope = 'session'
           AND importance >= ?
           AND created_at <= ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(minImportance, thresholdSec, nowSec) as Record<string, unknown>[];
  return rows.map((r) => rowToMemoryEntry(r));
}
