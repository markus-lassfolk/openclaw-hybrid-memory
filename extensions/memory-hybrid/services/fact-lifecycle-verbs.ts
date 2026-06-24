/**
 * Fact lifecycle verb helpers (pin, snooze) — Issue #1911.
 */

import { appendFactProvenance } from "../backends/facts-db/provenance-json.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { SQLInputValue } from "node:sqlite";
import { GLOBAL_ONLY_SCOPE_SENTINEL } from "../utils/scope-filter.js";

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
  let sql = "SELECT COUNT(*) AS cnt FROM facts WHERE pinned_at IS NOT NULL AND superseded_at IS NULL";
  const params: unknown[] = [];
  if (scopeFilter) {
    if (scopeFilter.sessionId) {
      sql += " AND scope = 'session' AND scope_target = ?";
      params.push(scopeFilter.sessionId);
    } else if (scopeFilter.userId) {
      sql += " AND scope = 'user' AND scope_target = ?";
      params.push(scopeFilter.userId);
    } else if (scopeFilter.agentId && scopeFilter.agentId !== GLOBAL_ONLY_SCOPE_SENTINEL) {
      sql += " AND scope = 'agent' AND scope_target = ?";
      params.push(scopeFilter.agentId);
    } else {
      sql += " AND scope = 'global'";
    }
  }
  const row = db.prepare(sql).get(...(params as SQLInputValue[])) as { cnt: number } | undefined;
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
