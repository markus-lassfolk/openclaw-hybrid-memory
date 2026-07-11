/**
 * Shared facts prune step: TTL hard-prune + confidence decay + LanceDB vector cleanup for
 * everything deleted. Extracted so the CLI and plugin-cycle maintenance runners execute the SAME
 * decay semantics — they had drifted: the CLI runner skipped decayConfidence entirely, so
 * operators triggering maintenance via CLI never applied confidence decay.
 */
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { deleteVectorsForFactIds } from "./vector-maintenance.js";

export interface FactsPruneOutcome {
  /** Facts hard-deleted because their TTL (expires_at) passed. */
  expired: number;
  /** Facts whose confidence was decayed this run (deletions from the <0.1 floor are in cleanups). */
  decayed: number;
  /** Vector-cleanup results: [expired-facts cleanup, decay-deleted-facts cleanup]. */
  cleanups: [Awaited<ReturnType<typeof deleteVectorsForFactIds>>, Awaited<ReturnType<typeof deleteVectorsForFactIds>>];
  vectorFailures: number;
}

export async function runFactsPruneStep(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  opts?: { operationPrefix?: string; nowSec?: number },
): Promise<FactsPruneOutcome> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const prefix = opts?.operationPrefix ?? "orchestrator";
  // Capture the doomed id sets BEFORE deleting so LanceDB rows can be cleaned up afterwards
  // (including facts newly pushed below the confidence floor by this run's decay step).
  const expiredIds = factsDb.listExpiredFactIdsPendingPrune();
  const decayDeleteIds = factsDb.listFactIdsToBeDeletedByDecayRun(nowSec);
  const expired = factsDb.pruneExpired();
  const decayed = factsDb.decayConfidence(nowSec);
  const expiredCleanup = await deleteVectorsForFactIds(vectorDb, expiredIds, {
    operation: `${prefix}-prune`,
  });
  const decayCleanup = await deleteVectorsForFactIds(vectorDb, decayDeleteIds, {
    operation: `${prefix}-decay`,
  });
  return {
    expired,
    decayed,
    cleanups: [expiredCleanup, decayCleanup],
    vectorFailures: expiredCleanup.failed + decayCleanup.failed,
  };
}
