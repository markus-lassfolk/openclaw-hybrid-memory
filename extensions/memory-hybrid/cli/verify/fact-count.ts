import type { DatabaseSync } from "node:sqlite";

const VERIFY_FACT_COUNT_TTL_MS = 5 * 60_000;
let verifyFactCountCache: { path: string; n: number; at: number } | null = null;

export function readApproxFactsRowCount(db: DatabaseSync): number | null {
  try {
    const row = db.prepare(`SELECT stat FROM sqlite_stat1 WHERE tbl = 'facts' LIMIT 1`).get() as
      | { stat: string | number }
      | undefined;
    if (row == null || row.stat === undefined || row.stat === null) return null;
    const statStr = String(row.stat).trim();
    const firstInt = statStr.split(/\s+/)[0];
    if (!firstInt) return null;
    const n = Number.parseInt(firstInt, 10);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

export function getCachedFactCount(
  factsDb: { count: () => number; getRawDb: () => DatabaseSync },
  sqlitePath: string,
): number {
  const now = Date.now();
  if (
    verifyFactCountCache &&
    verifyFactCountCache.path === sqlitePath &&
    now - verifyFactCountCache.at < VERIFY_FACT_COUNT_TTL_MS
  ) {
    return verifyFactCountCache.n;
  }
  const approx = readApproxFactsRowCount(factsDb.getRawDb());
  const n = approx != null ? approx : factsDb.count();
  verifyFactCountCache = { path: sqlitePath, n, at: now };
  return n;
}

/** Test-only: reset verify fact-count TTL cache between tests. */
export function resetVerifyFactCountCacheForTests(): void {
  verifyFactCountCache = null;
}
