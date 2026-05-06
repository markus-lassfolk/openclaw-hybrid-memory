/**
 * SQLite CHECK drift vs application enums (legacy `CREATE TABLE IF NOT EXISTS`).
 *
 * Older `episodes` tables may CHECK only `('success','partial','failed')` while
 * current code inserts `failure` / `unknown`. Older `audit_log` may omit
 * `skipped` while new paths append `skipped`. `CREATE TABLE IF NOT EXISTS`
 * never upgrades CHECK constraints — inserts fail at runtime.
 *
 * Strategy: read `sqlite_master.sql` once per DB (WeakMap cache), normalize
 * values at insert time. Reads map legacy stored values back to public types
 * where needed (`failed` → `failure` for episodes).
 */

import type { DatabaseSync } from "node:sqlite";
import type { EpisodeOutcome } from "../types/memory.js";

const episodesLegacyFailedOnlyCache = new WeakMap<DatabaseSync, boolean>();

function tableCreateSql(db: DatabaseSync, name: string): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql?: string }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : undefined;
}

/**
 * True when `episodes` exists with legacy CHECK using `failed` but not `failure`
 * (current shipped DDL uses `failure` and `unknown`).
 */
export function episodesTableIsLegacyFailedOutcomeCheck(db: DatabaseSync): boolean {
  let cached = episodesLegacyFailedOnlyCache.get(db);
  if (cached !== undefined) return cached;
  const sql = tableCreateSql(db, "episodes") ?? "";
  if (sql.length === 0) {
    episodesLegacyFailedOnlyCache.set(db, false);
    return false;
  }
  const hasFailed = sql.includes("'failed'");
  const hasFailure = sql.includes("'failure'");
  cached = hasFailed && !hasFailure;
  episodesLegacyFailedOnlyCache.set(db, cached);
  return cached;
}

/**
 * Outcome string bound on INSERT — maps app enums to values accepted by the
 * live table CHECK.
 */
export function episodeOutcomeForSqliteInsert(db: DatabaseSync, outcome: EpisodeOutcome): string {
  if (!episodesTableIsLegacyFailedOutcomeCheck(db)) {
    return outcome;
  }
  if (outcome === "failure" || outcome === "unknown") {
    return "failed";
  }
  return outcome;
}

/**
 * Map a stored `episodes.outcome` row value to the public {@link EpisodeOutcome}.
 * Legacy rows may still contain `failed` from older writers.
 */
export function storedEpisodeOutcomeToPublic(stored: string): EpisodeOutcome {
  if (stored === "failed") {
    return "failure";
  }
  if (stored === "success" || stored === "partial" || stored === "failure" || stored === "unknown") {
    return stored;
  }
  return "unknown";
}

/** Test-only: clear cached legacy detection for a db handle. */
export function _resetEpisodesOutcomeCompatCacheForTests(db: DatabaseSync): void {
  episodesLegacyFailedOnlyCache.delete(db);
}
