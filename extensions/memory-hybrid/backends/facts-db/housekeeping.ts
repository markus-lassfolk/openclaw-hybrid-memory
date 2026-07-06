/**
 * Misc DB ops: pruning logs, stats helpers, scope pruning (Issue #954 split).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { rebuildFtsIndex } from "../../services/fts-search.js";
import type { MemoryEntry, ScopeFilter } from "../../types/memory.js";
import { getLanguageKeywordsFilePath } from "../../utils/language-keywords.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import { scopeFilterClausePositional } from "./scope-sql.js";

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
  const tx = createTransaction(db, () => {
    const recall = db.prepare("DELETE FROM recall_log WHERE occurred_at < ?").run(cutoff);
    const reinforcement = db.prepare("DELETE FROM reinforcement_log WHERE occurred_at < ?").run(cutoff);
    const feedback = db.prepare("DELETE FROM feedback_trajectories WHERE created_at < ?").run(cutoff);
    return Number(recall.changes ?? 0) + Number(reinforcement.changes ?? 0) + Number(feedback.changes ?? 0);
  });
  return tx();
}

/** Run standard FTS5 optimize maintenance on `facts_fts`. */
export function optimizeFts(db: DatabaseSync): void {
  db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('optimize')`);
}

const EXPECTED_FTS_TRIGGERS = ["facts_ai", "facts_au", "facts_ad"] as const;

export type FtsConsistencySnapshot = {
  factsCount: number;
  ftsCount: number;
  ftsTableExists: boolean;
  ftsTableSql: string | null;
  hasTagsColumn: boolean;
  hasWhyColumn: boolean;
  presentTriggers: string[];
  missingTriggers: string[];
  missingFactsInFts: number;
  extraFtsRows: number;
  missingFactIdsSample: string[];
  extraFtsRowidsSample: number[];
};

export type FtsTriggerProbeResult = {
  ok: boolean;
  insertVisible: boolean;
  updateVisible: boolean;
  deleteVisibleAfterDelete: boolean;
  error?: string;
};

function scalarCount(db: DatabaseSync, query: string, ...params: (string | number)[]): number {
  const row = db.prepare(query).get(...params) as { cnt: number } | undefined;
  return Number(row?.cnt ?? 0);
}

export function getFtsConsistencySnapshot(db: DatabaseSync): FtsConsistencySnapshot {
  const factsCount = scalarCount(db, "SELECT COUNT(*) AS cnt FROM facts");
  const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts_fts'`).get() as
    | { sql: string | null }
    | undefined;
  const ftsTableExists = !!ftsRow;
  const ftsTableSql = ftsRow?.sql ?? null;
  const hasTagsColumn = /\btags\b/i.test(ftsTableSql ?? "");
  const hasWhyColumn = /\bwhy\b/i.test(ftsTableSql ?? "");

  const triggerRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name IN ('facts_ai', 'facts_au', 'facts_ad')`,
    )
    .all() as Array<{ name: string }>;
  const presentTriggers = triggerRows.map((r) => r.name).sort();
  const missingTriggers = EXPECTED_FTS_TRIGGERS.filter((name) => !presentTriggers.includes(name));

  if (!ftsTableExists) {
    return {
      factsCount,
      ftsCount: 0,
      ftsTableExists,
      ftsTableSql,
      hasTagsColumn,
      hasWhyColumn,
      presentTriggers,
      missingTriggers,
      missingFactsInFts: factsCount,
      extraFtsRows: 0,
      missingFactIdsSample: [],
      extraFtsRowidsSample: [],
    };
  }

  const ftsCount = scalarCount(db, "SELECT COUNT(*) AS cnt FROM facts_fts");
  const missingFactsInFts = scalarCount(
    db,
    `SELECT COUNT(*) AS cnt
       FROM facts f
      WHERE NOT EXISTS (SELECT 1 FROM facts_fts t WHERE t.rowid = f.rowid)`,
  );
  const extraFtsRows = scalarCount(
    db,
    `SELECT COUNT(*) AS cnt
       FROM facts_fts t
      WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.rowid = t.rowid)`,
  );
  const missingFactIdsSampleRows = db
    .prepare(
      `SELECT f.id
         FROM facts f
        WHERE NOT EXISTS (SELECT 1 FROM facts_fts t WHERE t.rowid = f.rowid)
        LIMIT 5`,
    )
    .all() as Array<{ id: string }>;
  const extraFtsRowidsSampleRows = db
    .prepare(
      `SELECT t.rowid
         FROM facts_fts t
        WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.rowid = t.rowid)
        LIMIT 5`,
    )
    .all() as Array<{ rowid: number }>;

  return {
    factsCount,
    ftsCount,
    ftsTableExists,
    ftsTableSql,
    hasTagsColumn,
    hasWhyColumn,
    presentTriggers,
    missingTriggers,
    missingFactsInFts,
    extraFtsRows,
    missingFactIdsSample: missingFactIdsSampleRows.map((row) => row.id),
    extraFtsRowidsSample: extraFtsRowidsSampleRows.map((row) => Number(row.rowid)),
  };
}

export function runFtsTriggerProbe(db: DatabaseSync): FtsTriggerProbeResult {
  const savepoint = `hm_fts_probe_${randomUUID().replace(/-/g, "")}`;
  const probeId = randomUUID();
  const tokenBase = randomUUID().replace(/-/g, "");
  const insertToken = `hmdoctorins${tokenBase.slice(0, 12)}`;
  const updateToken = `hmdoctorupd${tokenBase.slice(12, 24)}`;
  const nowSec = Math.floor(Date.now() / 1000);

  let insertVisible = false;
  let updateVisible = false;
  let deleteVisibleAfterDelete = true;

  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    db.prepare(
      `INSERT INTO facts(id, text, category, importance, source, created_at)
       VALUES(?, ?, 'fact', 0.01, 'doctor-fts-probe', ?)`,
    ).run(probeId, insertToken, nowSec);

    const rowidRow = db.prepare("SELECT rowid FROM facts WHERE id = ?").get(probeId) as { rowid: number } | undefined;
    if (!rowidRow?.rowid) {
      return {
        ok: false,
        insertVisible,
        updateVisible,
        deleteVisibleAfterDelete,
        error: "probe insert rowid not found",
      };
    }
    const rowid = Number(rowidRow.rowid);

    const insertMatchCount = scalarCount(
      db,
      "SELECT COUNT(*) AS cnt FROM facts_fts WHERE rowid = ? AND facts_fts MATCH ?",
      rowid,
      insertToken,
    );
    insertVisible = insertMatchCount === 1;

    db.prepare("UPDATE facts SET text = ? WHERE id = ?").run(updateToken, probeId);
    const updateMatchCount = scalarCount(
      db,
      "SELECT COUNT(*) AS cnt FROM facts_fts WHERE rowid = ? AND facts_fts MATCH ?",
      rowid,
      updateToken,
    );
    const staleMatchCount = scalarCount(
      db,
      "SELECT COUNT(*) AS cnt FROM facts_fts WHERE rowid = ? AND facts_fts MATCH ?",
      rowid,
      insertToken,
    );
    updateVisible = updateMatchCount === 1 && staleMatchCount === 0;

    db.prepare("DELETE FROM facts WHERE id = ?").run(probeId);
    const postDeleteCount = scalarCount(db, "SELECT COUNT(*) AS cnt FROM facts_fts WHERE rowid = ?", rowid);
    deleteVisibleAfterDelete = postDeleteCount > 0;

    return {
      ok: insertVisible && updateVisible && !deleteVisibleAfterDelete,
      insertVisible,
      updateVisible,
      deleteVisibleAfterDelete,
    };
  } catch (error) {
    return {
      ok: false,
      insertVisible,
      updateVisible,
      deleteVisibleAfterDelete,
      error: String(error),
    };
  } finally {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      // ignore cleanup errors
    }
    try {
      db.exec(`RELEASE ${savepoint}`);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function rebuildFtsIndexFromFacts(db: DatabaseSync): number {
  const tx = createTransaction(db, () => rebuildFtsIndex(db));
  return tx();
}

export function freelistSpaceStats(db: DatabaseSync): {
  freelistCount: number;
  pageSize: number;
  freedBytes: number;
  freedMB: number;
} {
  const freelistCountResult = db.prepare("PRAGMA freelist_count").get() as { freelist_count: number } | undefined;
  const pageSizeResult = db.prepare("PRAGMA page_size").get() as { page_size: number } | undefined;
  const freelistCount = freelistCountResult?.freelist_count ?? 0;
  const pageSize = pageSizeResult?.page_size ?? 4096;
  const freedBytes = freelistCount * pageSize;
  return {
    freelistCount,
    pageSize,
    freedBytes,
    freedMB: freedBytes / (1024 * 1024),
  };
}

export function checkpointWalTruncate(db: DatabaseSync): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export function vacuumAndCheckpoint(db: DatabaseSync): void {
  db.exec("VACUUM");
  checkpointWalTruncate(db);
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
  const row = db.prepare("SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NOT NULL").get() as
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

export function countBySource(db: DatabaseSync, source: string, scopeFilter?: ScopeFilter | null): number {
  const scopeClause = scopeFilterClausePositional(scopeFilter);
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = ? ${scopeClause.clause}`)
    .get(source, ...scopeClause.params) as { count: number } | undefined;
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

  if (scopeFilter.global) {
    conditions.push(`(scope = 'global')`);
  }
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

/**
 * Prune facts matching scopeFilter and return the IDs that were actually deleted.
 * Callers doing follow-up cleanup keyed by fact ID (e.g. LanceDB vector deletion) should use
 * this return value rather than a separately-collected id snapshot: the SELECT-then-DELETE here
 * runs inside a single IMMEDIATE transaction with nothing else able to run in between, so it
 * reflects exactly what was deleted — unlike a snapshot taken earlier (e.g. before a confirmation
 * prompt), which can drift if a fact enters or leaves the scope in the meantime and silently
 * leave its vector orphaned.
 */
export function pruneScopedFacts(db: DatabaseSync, scopeFilter: ScopeFilter): string[] {
  const conditions: string[] = [];
  const params: (string | null)[] = [];

  if (scopeFilter.global) {
    conditions.push(`(scope = 'global')`);
  }
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

  const tx = createTransaction(
    db,
    () => {
      const idRows = db
        .prepare(
          `SELECT id FROM facts WHERE (${conditions.join(" OR ")})
             AND id NOT IN (SELECT fact_id FROM verified_facts)`,
        )
        .all(...params) as Array<{ id: string }>;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return ids;

      // Match deleteFact()'s cleanup exactly: both link directions (not just target_fact_id),
      // no link_type exclusion (a purged fact's DERIVED_FROM edges are just as dangling as any
      // other), and the contradictions table (previously never touched here at all) — otherwise
      // a hard-deleted fact leaves orphaned memory_links/contradictions rows that silently vanish
      // from queryContradictionSurface's INNER JOIN listings and make applyContradictionDecisions
      // FromReview fail with a confusing "could not persist decision" error (#83).
      const scopedIdsSubquery = `SELECT id FROM facts WHERE (${conditions.join(" OR ")})
              AND id NOT IN (SELECT fact_id FROM verified_facts)`;
      db.prepare(
        `DELETE FROM contradictions
           WHERE fact_id_new IN (${scopedIdsSubquery}) OR fact_id_old IN (${scopedIdsSubquery})`,
      ).run(...params, ...params);
      db.prepare(
        `DELETE FROM memory_links
           WHERE source_fact_id IN (${scopedIdsSubquery}) OR target_fact_id IN (${scopedIdsSubquery})`,
      ).run(...params, ...params);

      const query = `DELETE FROM facts WHERE (${conditions.join(" OR ")})
        AND id NOT IN (SELECT fact_id FROM verified_facts)`;
      db.prepare(query).run(...params);
      return ids;
    },
    "IMMEDIATE",
  );
  return tx();
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
