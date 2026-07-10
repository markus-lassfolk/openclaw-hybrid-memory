/**
 * Fact lifecycle verb helpers (pin, snooze) — Issue #1911.
 */

import { appendFactProvenance } from "../backends/facts-db/provenance-json.js";
import { scopeFilterClausePositional } from "../backends/facts-db/scope-sql.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { SQLInputValue } from "node:sqlite";

export const DEFAULT_PIN_QUOTA = 10;

export function checkPinQuota(
  factsDb: FactsDB,
  quota = DEFAULT_PIN_QUOTA,
  scopeFilter?: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
): { allowed: boolean; current: number } {
  const current = countPinnedFacts(factsDb, scopeFilter);
  return { allowed: current < quota, current };
}

export function pinFact(factsDb: FactsDB, factId: string, reason: string, sessionId?: string): boolean {
  const db = factsDb.getRawDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare("UPDATE facts SET pinned_at = ?, pinned_reason = ? WHERE id = ? AND superseded_at IS NULL")
    .run(now, reason, factId);
  if (result.changes > 0) {
    appendFactProvenance(db, factId, {
      method: "agent-pin",
      pinnedReason: reason,
      sessionId,
      pinnedAt: now,
    });
  }
  return result.changes > 0;
}

export function snoozeFact(factsDb: FactsDB, factId: string, untilSec: number): boolean {
  const db = factsDb.getRawDb();
  const result = db
    .prepare("UPDATE facts SET snoozed_until = ? WHERE id = ? AND superseded_at IS NULL")
    .run(untilSec, factId);
  return result.changes > 0;
}

export function countPinnedFacts(
  factsDb: FactsDB,
  scopeFilter?: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
): number {
  const db = factsDb.getRawDb();
  const sql = "SELECT COUNT(*) AS cnt FROM facts WHERE pinned_at IS NOT NULL AND superseded_at IS NULL";
  // Quota enforcement must count every pinned fact *visible* to this caller, not just one scope
  // tier picked exclusively -- buildToolScopeFilter() routinely sets both userId and agentId at
  // once for a non-orchestrator agent, and the old if/else-if chain only ever counted the first
  // matching tier, letting an agent accumulate far more than DEFAULT_PIN_QUOTA total pins by
  // spreading them across scope tiers. Reuses the same OR-based, all-dimensions visibility clause
  // every other read path (getById/search) uses.
  const { clause, params } = scopeFilterClausePositional(scopeFilter);
  const row = db.prepare(sql + clause).get(...(params as SQLInputValue[])) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function isFactSnoozed(factsDb: FactsDB, factId: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const db = factsDb.getRawDb();
  const row = db.prepare("SELECT snoozed_until FROM facts WHERE id = ?").get(factId) as
    | { snoozed_until: number | null }
    | undefined;
  return row?.snoozed_until != null && row.snoozed_until > nowSec;
}

export function resolveFactByIdOrQuery(
  factsDb: FactsDB,
  idOrQuery: string,
  scopeFilter?: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
) {
  const direct = factsDb.getById(idOrQuery, scopeFilter ? { scopeFilter } : undefined);
  if (direct) return direct;
  const hits = factsDb.search(idOrQuery, 1, { scopeFilter });
  return hits[0]?.entry ?? null;
}
