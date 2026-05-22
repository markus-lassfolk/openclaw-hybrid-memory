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

import { deleteVectorForFactId } from "../services/vector-maintenance.js";
import type { FactsDB, VectorDB } from "../types/memory.js";

/** Patterns matched by isPromptArtifactOrReasoningTrace — must stay in sync. */
const REASONING_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "think-prefix", regex: /^think\s/i },
  { label: "Thinking Process", regex: /^Thinking Process[;:]/i },
  { label: "The user is asking me to classify/extract", regex: /^The user is asking me to (classify|extract)/i },
  { label: "NOOP |", regex: /^NOOP \|/i },
  { label: "ADD |", regex: /^ADD \|/i },
  { label: "UPDATE |", regex: /^UPDATE \|/i },
  { label: 'classifier JSON {"action"', regex: /^\{"action"\s*:/i },
  { label: "capability-hints marker", regex: /^<!--\s*memory-hybrid\s*:\s*capability\s*hints/i },
];

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
  let pageOffset = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const rows = factsDb.allRaw(
      `SELECT id, text, source, category, importance FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT ? OFFSET ?`,
      [Math.floor(Date.now() / 1000), PAGE_SIZE, pageOffset],
    ) as Array<{ id: string; text: string; source: string; category: string; importance: number }>;

    if (rows.length === 0) break;
    result.scanned += rows.length;

    for (const row of rows) {
      const matches = REASONING_PATTERNS.filter((p) => p.regex.test(row.text.trim()));
      if (matches.length === 0) continue;

      result.matched++;
      const matchLabels = matches.map((m) => m.label).join(", ");
      if (verbose || result.samples.length < 5) {
        result.samples.push(`[${matchLabels}] ${row.text.slice(0, 80)}`);
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
          logger?.info?.(`cleaned [${matchLabels}] fact ${row.id} (src=${row.source})`);
        } catch (err) {
          result.errors.push(`failed to supersede ${row.id}: ${err}`);
        }
      }
    }

    pageOffset += PAGE_SIZE;
    if (rows.length < PAGE_SIZE) break;
  }

  return result;
}
