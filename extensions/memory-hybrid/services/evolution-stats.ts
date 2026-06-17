/**
 * Evolution / fragment observability for status and dashboard (#1914).
 */

import type { DatabaseSync } from "node:sqlite";
import { formatTimestampUtc } from "../utils/dates.js";

export type EvolutionStats = {
  evolvedFacts: number;
  fragmentFacts: number;
  maxEvolutionVersion: number;
  lastEvolutionPassAt: string | null;
  neighborsUpdatedLastPass: number | null;
  qualityEvolvedLastPass: number | null;
};

export function collectEvolutionStats(db: DatabaseSync): EvolutionStats | null {
  try {
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN COALESCE(evolution_version, 0) > 0 THEN 1 ELSE 0 END) AS evolved_facts,
           SUM(CASE WHEN parent_fact_id IS NOT NULL THEN 1 ELSE 0 END) AS fragment_facts,
           MAX(COALESCE(evolution_version, 0)) AS max_evolution_version
         FROM facts
         WHERE superseded_at IS NULL`,
      )
      .get() as
      | {
          evolved_facts: number | null;
          fragment_facts: number | null;
          max_evolution_version: number | null;
        }
      | undefined;

    let lastEvolutionPassAt: string | null = null;
    let neighborsUpdatedLastPass: number | null = null;
    let qualityEvolvedLastPass: number | null = null;

    try {
      const lastRun = db
        .prepare(
          `SELECT started_at, items_processed, metadata_json
           FROM maintenance_runs
           WHERE job = 'evolution-pass'
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get() as { started_at: number; items_processed: number; metadata_json: string | null } | undefined;
      if (lastRun) {
        lastEvolutionPassAt = formatTimestampUtc(lastRun.started_at);
        qualityEvolvedLastPass = lastRun.items_processed ?? null;
        if (lastRun.metadata_json) {
          try {
            const meta = JSON.parse(lastRun.metadata_json) as {
              neighborsUpdated?: number;
              scanned?: number;
            };
            if (typeof meta.neighborsUpdated === "number") {
              neighborsUpdatedLastPass = meta.neighborsUpdated;
            }
          } catch {
            /* ignore malformed metadata */
          }
        }
      }
    } catch {
      /* maintenance_runs may be missing on very old DBs */
    }

    return {
      evolvedFacts: counts?.evolved_facts ?? 0,
      fragmentFacts: counts?.fragment_facts ?? 0,
      maxEvolutionVersion: counts?.max_evolution_version ?? 0,
      lastEvolutionPassAt,
      neighborsUpdatedLastPass,
      qualityEvolvedLastPass,
    };
  } catch {
    return null;
  }
}
