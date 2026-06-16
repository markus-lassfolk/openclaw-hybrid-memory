/**
 * Fact lifecycle verb helpers (pin, snooze) — Issue #1911.
 */

import type { FactsDB } from "../backends/facts-db.js";

export function pinFact(
  factsDb: FactsDB,
  factId: string,
  reason: string,
): boolean {
  const db = factsDb.getRawDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare("UPDATE facts SET pinned_at = ?, pinned_reason = ? WHERE id = ? AND superseded_at IS NULL")
    .run(now, reason, factId);
  return result.changes > 0;
}

export function snoozeFact(factsDb: FactsDB, factId: string, untilSec: number): boolean {
  const db = factsDb.getRawDb();
  const result = db
    .prepare("UPDATE facts SET snoozed_until = ? WHERE id = ? AND superseded_at IS NULL")
    .run(untilSec, factId);
  return result.changes > 0;
}

export function countPinnedFacts(factsDb: FactsDB): number {
  const db = factsDb.getRawDb();
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM facts WHERE pinned_at IS NOT NULL AND superseded_at IS NULL").get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}

export function isFactSnoozed(factsDb: FactsDB, factId: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const db = factsDb.getRawDb();
  const row = db
    .prepare("SELECT snoozed_until FROM facts WHERE id = ?")
    .get(factId) as { snoozed_until: number | null } | undefined;
  return row?.snoozed_until != null && row.snoozed_until > nowSec;
}

export function resolveFactByIdOrQuery(factsDb: FactsDB, idOrQuery: string, scopeFilter?: { userId?: string | null; agentId?: string | null; sessionId?: string | null }) {
  const direct = factsDb.getById(idOrQuery);
  if (direct) return direct;
  const hits = factsDb.search(idOrQuery, 1, { scopeFilter });
  return hits[0]?.entry ?? null;
}
