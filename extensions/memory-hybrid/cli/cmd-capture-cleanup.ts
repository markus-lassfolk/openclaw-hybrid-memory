/**
 * Capture Cleanup Maintenance Command (`memory-hybrid capture-cleanup`)
 *
 * Scans all active (non-superseded, non-expired) facts for text that matches
 * chain-of-thought / reasoning-trace / classifier-prompt patterns that should NOT
 * have been stored as memory facts (#1560).
 *
 * For each matching fact:
 *   1. Marks it superseded in SQLite (sets superseded_at, decrements importance)
 *   2. Removes its LanceDB vector to free space and stop semantic retrieval noise
 *
 * Dry-run mode reports what would be cleaned without making changes.
 */

import { isPromptArtifactOrReasoningTrace } from "../services/capture-utils.js";
import { deleteVectorForFactId } from "../services/vector-maintenance.js";
import type { FactsDB, VectorDB } from "../types/memory.js";

export interface CaptureCleanupResult {
  scanned: number;
  matched: number;
  superseded: number;
  vectorDeleted: number;
  errors: string[];
  dryRun: boolean;
  samples: string[];
}

export async function runCaptureCleanupForCli(options: {
  factsDb: FactsDB;
  vectorDb: VectorDB | null;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<CaptureCleanupResult> {
  const { factsDb, vectorDb, logger, dryRun = false, verbose = false } = options;
  const result: CaptureCleanupResult = {
    scanned: 0,
    matched: 0,
    superseded: 0,
    vectorDeleted: 0,
    errors: [],
    dryRun,
    samples: [],
  };

  // Scan all active facts (source not explicitly excluded; reasoning traces come from auto-capture)
  const PAGE_SIZE = 500;

  while (true) {
    // Always query at offset 0: superseded facts drop out of the result set in non-dry-run mode
    const rows = factsDb.allRaw(
      `SELECT id, text, source, category, importance FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT ?`,
      [Math.floor(Date.now() / 1000), PAGE_SIZE],
    ) as Array<{ id: string; text: string; source: string; category: string; importance: number }>;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      if (!isPromptArtifactOrReasoningTrace(row.text)) continue;

      result.matched++;
      if (verbose || result.samples.length < 5) {
        result.samples.push(row.text.slice(0, 80));
      }

      if (!dryRun) {
        try {
          // Demote: set superseded_at and lower importance
          factsDb.allRaw(
            `UPDATE facts SET superseded_at = ?, importance = ? WHERE id = ? AND superseded_at IS NULL`,
            [Math.floor(Date.now() / 1000), Math.min(row.importance, 0.1), row.id],
          );

          // Remove LanceDB vector
          if (vectorDb) {
            try {
              const deleted = await deleteVectorForFactId({
                vectorDb: vectorDb as VectorDB,
                factId: row.id,
                logger,
                context: "capture-cleanup",
              });
              if (deleted) result.vectorDeleted++;
            } catch (vecErr) {
              result.errors.push(`vector delete failed for ${row.id}: ${vecErr}`);
            }
          }

          result.superseded++;
          logger?.info?.(`cleaned fact ${row.id} (src=${row.source})`);
        } catch (err) {
          result.errors.push(`failed to supersede ${row.id}: ${err}`);
        }
      }
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return result;
}
