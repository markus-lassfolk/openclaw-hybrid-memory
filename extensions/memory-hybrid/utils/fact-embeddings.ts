/**
 * Utility for persisting canonical fact embeddings to SQLite.
 * Mirrors Lance writes into SQLite `fact_embeddings` table so audit vectorless counts stay accurate.
 */

import type { FactsDB } from "../backends/facts-db.js";
import { capturePluginError } from "../services/error-reporter.js";

/**
 * Persist canonical embedding to SQLite fact_embeddings table.
 * Call only after a successful `vectorDb.store` for this fact id so SQLite stays aligned
 * with Lance and vectorless audit / reembed paths remain correct.
 * Used by auto-capture and reflection to mirror Lance writes (#audit remediation).
 *
 * @param factsDb - Facts database instance
 * @param factId - Fact ID
 * @param modelName - Embedding model name
 * @param vector - Embedding vector
 * @param operation - Operation name for error tracking (e.g., "auto-capture", "reflection")
 * @param subsystem - Subsystem name for error tracking (e.g., "auto-capture", "reflection")
 * @param logWarn - Optional warning logger
 */
export function persistCanonicalFactEmbedding(
  factsDb: FactsDB,
  factId: string,
  modelName: string,
  vector: number[],
  operation: string,
  subsystem: string,
  logWarn?: (msg: string) => void,
): void {
  try {
    factsDb.storeEmbedding(factId, modelName, "canonical", new Float32Array(vector), vector.length);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation,
      subsystem,
      factId,
    });
    logWarn?.(`memory-hybrid: fact_embeddings canonical store failed: ${err}`);
  }
}
