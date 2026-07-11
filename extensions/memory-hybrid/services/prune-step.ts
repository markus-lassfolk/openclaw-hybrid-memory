/**
 * Shared facts prune step: TTL hard-prune (with one-time second chances for important/used facts)
 * + confidence decay (half-life curve by default, legacy cliff as escape hatch) + LanceDB vector
 * cleanup for everything actually deleted. Extracted so the CLI and plugin-cycle maintenance
 * runners execute the SAME decay semantics — they had drifted: the CLI runner skipped
 * decayConfidence entirely, so operators triggering maintenance via CLI never applied decay.
 *
 * Vector cleanup uses the deletion ids RETURNED by the WithDetails variants (not pre-run
 * previews): with second chances, a previewed-as-expired fact can survive via reprieve, and its
 * vector must survive with it.
 */
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { deleteVectorsForFactIds } from "./vector-maintenance.js";

export interface FactsPruneOutcome {
  /** Facts hard-deleted because their TTL (expires_at) passed. */
  expired: number;
  /** Facts whose confidence was decayed this run (floor deletions are in cleanups[1]). */
  decayed: number;
  /** Important/frequently-recalled facts granted their one TTL/2 reprieve instead of deletion. */
  secondChances: number;
  /** Vector-cleanup results: [expired-facts cleanup, decay-deleted-facts cleanup]. */
  cleanups: [Awaited<ReturnType<typeof deleteVectorsForFactIds>>, Awaited<ReturnType<typeof deleteVectorsForFactIds>>];
  vectorFailures: number;
}

export async function runFactsPruneStep(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  opts?: {
    operationPrefix?: string;
    nowSec?: number;
    /** "half-life" (default): continuous per-content-type curve. "cliff": legacy 75%-window halving. */
    decayMode?: "half-life" | "cliff";
    secondChance?: boolean;
  },
): Promise<FactsPruneOutcome> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const prefix = opts?.operationPrefix ?? "orchestrator";
  const pruneOutcome = factsDb.pruneExpiredWithDetails(nowSec, { secondChance: opts?.secondChance !== false });
  const decayOutcome =
    (opts?.decayMode ?? "half-life") === "cliff"
      ? factsDb.decayConfidenceWithDetails(nowSec)
      : factsDb.decayConfidenceHalfLifeWithDetails(nowSec);
  const expiredCleanup = await deleteVectorsForFactIds(vectorDb, pruneOutcome.deletedFactIds, {
    operation: `${prefix}-prune`,
  });
  const decayCleanup = await deleteVectorsForFactIds(vectorDb, decayOutcome.deletedFactIds, {
    operation: `${prefix}-decay`,
  });
  return {
    expired: pruneOutcome.factsPruned,
    decayed: decayOutcome.factsDecayed,
    secondChances: pruneOutcome.secondChances,
    cleanups: [expiredCleanup, decayCleanup],
    vectorFailures: expiredCleanup.failed + decayCleanup.failed,
  };
}
