/**
 * Semantic memory evolution pass (Issue #1914).
 * Bumps quality_score and evolution metadata for facts with repeated access.
 */

import type { DatabaseSync } from "node:sqlite";
import { getHalfLifeForContentType } from "./semantic-lifecycle.js";

export type EvolutionPassResult = {
  scanned: number;
  evolved: number;
};

/** Run deterministic evolution pass: reinforce quality on frequently accessed facts. */
export function runEvolutionPass(db: DatabaseSync, limit = 500): EvolutionPassResult {
  const rows = db
    .prepare(
      `SELECT id, category, COALESCE(access_count, 0) AS access_count,
              COALESCE(quality_score, 0.5) AS quality_score,
              COALESCE(revision_count, 0) AS revision_count
       FROM facts
       WHERE superseded_at IS NULL
         AND COALESCE(access_count, 0) >= 2
       ORDER BY access_count DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    category: string;
    access_count: number;
    quality_score: number;
    revision_count: number;
  }>;

  let evolved = 0;
  const now = Math.floor(Date.now() / 1000);
  const update = db.prepare(
    `UPDATE facts SET quality_score = ?, evolution_version = COALESCE(evolution_version, 0) + 1,
     evolution_reason = ?, revision_count = COALESCE(revision_count, 0) + 1
     WHERE id = ?`,
  );

  for (const row of rows) {
    const spec = getHalfLifeForContentType(row.category);
    const boost = Math.min(0.15, row.access_count * 0.02);
    const newQuality = Math.min(1, row.quality_score + boost * spec.baseline);
    if (newQuality <= row.quality_score + 0.001) continue;
    update.run(newQuality, `access_reinforcement:${row.access_count}`, row.id);
    evolved++;
  }

  if (evolved > 0) {
    db.prepare(
      `INSERT INTO maintenance_runs (job, started_at, ended_at, status, items_processed, metadata_json)
       VALUES ('evolution-pass', ?, ?, 'ran', ?, ?)`,
    ).run(now, now, evolved, JSON.stringify({ scanned: rows.length }));
  }

  return { scanned: rows.length, evolved };
}
