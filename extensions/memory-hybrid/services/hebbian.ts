/**
 * Hebbian co-recall learning: memories recalled TOGETHER bond. Collects top-K co-recalled fact
 * ids into all-pairs and batch-strengthens their RELATED_TO links (+0.1, one transaction),
 * fire-and-forget so it never adds latency to the recall path. Shared by ambient injection
 * (lifecycle/stage-injection) and the explicit memory_recall tool. Bounded by graph.linkDecay
 * (unused links weaken back) and hubDegreeCap, so use shapes the graph without saturating it.
 */
import { capturePluginError } from "./error-reporter.js";

const HEBBIAN_MAX_K = 8;

/** Structural slice of FactsDB so tools/ and lifecycle/ can both pass their instance. */
export interface HebbianFactsDb {
  isOpen?: () => boolean;
  strengthenRelatedLinksBatch(pairs: [string, string][], deltaStrength?: number): void;
}

/** Collect top-K pairs and batch-strengthen in a single transaction, fire-and-forget. */
export function strengthenHebbianLinks(
  ids: string[],
  factsDb: HebbianFactsDb,
  logger: { warn: (msg: string) => void },
  subsystem = "stage-injection",
): void {
  const topK = Array.from(new Set(ids)).slice(0, HEBBIAN_MAX_K);
  const pairs: [string, string][] = [];
  for (let i = 0; i < topK.length; i++) {
    for (let j = i + 1; j < topK.length; j++) {
      pairs.push([topK[i], topK[j]]);
    }
  }
  if (pairs.length === 0) return;
  setImmediate(() => {
    try {
      // Check database connection before deferred operation to prevent race condition during shutdown (#1288)
      if (typeof factsDb.isOpen === "function" && !factsDb.isOpen()) {
        return;
      }
      factsDb.strengthenRelatedLinksBatch(pairs);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Expected when the plugin is shutting down or the database closed mid-operation
      if (!/database connection is not open/i.test(e.message)) {
        capturePluginError(e, {
          operation: "hebbian-strengthen",
          subsystem,
        });
        logger.warn(`memory-hybrid: hebbian link strengthening failed: ${err}`);
      }
    }
  });
}
