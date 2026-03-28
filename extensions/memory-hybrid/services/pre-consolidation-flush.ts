import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import { replayWalEntries } from "../utils/wal-replay.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";

export interface PreConsolidationFlushDeps {
  wal: WriteAheadLog | null;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
}

export async function runPreConsolidationFlush(
  deps: PreConsolidationFlushDeps,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
  phase: string,
): Promise<{ committed: number; skipped: number }> {
  if (!deps.wal) return { committed: 0, skipped: 0 };

  try {
    const result = await replayWalEntries(deps.wal, deps.factsDb, deps.vectorDb, deps.embeddings);
    if (result.committed > 0 || result.skipped > 0) {
      logger.info?.(`memory-hybrid: ${phase} — WAL replay: ${result.committed} committed, ${result.skipped} skipped`);
    }
    return result;
  } catch (err) {
    logger.warn?.(`memory-hybrid: ${phase} — WAL replay failed (non-fatal): ${String(err)}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "lifecycle",
      operation: `${phase}-wal-replay`,
    });
    return { committed: 0, skipped: 0 };
  }
}
