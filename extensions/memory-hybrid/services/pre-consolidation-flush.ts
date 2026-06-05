import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import { replayWalEntriesWithRepair } from "../utils/wal-replay.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";

interface PreConsolidationFlushDeps {
  wal: WriteAheadLog | null;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
}

export async function runPreConsolidationFlush(
  deps: PreConsolidationFlushDeps,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
  phase: string,
): Promise<{ committed: number; skipped: number; failed: boolean }> {
  if (!deps.wal) return { committed: 0, skipped: 0, failed: false };

  try {
    const result = await replayWalEntriesWithRepair(
      deps.wal,
      deps.factsDb,
      deps.vectorDb,
      deps.embeddings,
      logger,
      phase,
    );
    if (result.committed > 0 || result.skipped > 0) {
      logger.info?.(`memory-hybrid: ${phase} — WAL replay: ${result.committed} committed, ${result.skipped} skipped`);
    }
    return { ...result, failed: false };
  } catch (err) {
    logger.warn?.(`memory-hybrid: ${phase} — WAL replay failed: ${String(err)}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "lifecycle",
      operation: `${phase}-wal-replay`,
    });
    return { committed: 0, skipped: 0, failed: true };
  }
}
