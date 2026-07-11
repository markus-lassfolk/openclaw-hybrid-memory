/**
 * Affect back-stamping (living-memory P4.1): "memory formation carries emotional state."
 *
 * The frustration detector already computes per-session affect signals and persists them to
 * implicit_signals (source='frustration') — then nothing ever used them. This nightly step
 * correlates those signals with the facts formed in the same session window and stamps a valence
 * (−1..1, negative = frustration) onto each fact, so the emotional context a memory was formed
 * under travels with it (Memory Graph lens + future ranking input). Wiring, not new capture: no
 * hot-path cost, no LLM.
 */
import type { DatabaseSync } from "node:sqlite";

const WINDOW_SLACK_SEC = 30 * 60;

export interface AffectStampResult {
  sessionsSeen: number;
  factsStamped: number;
}

export function runAffectStamp(db: DatabaseSync, opts?: { sinceDays?: number; nowSec?: number }): AffectStampResult {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - (opts?.sinceDays ?? 7) * 86_400;

  // Per-session aggregate: confidence-weighted mean valence + the signal time window.
  const sessions = db
    .prepare(
      `SELECT session_file,
              SUM(CASE WHEN polarity = 'negative' THEN -confidence ELSE confidence END) / COUNT(*) AS valence,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
         FROM implicit_signals
        WHERE source = 'frustration' AND session_file IS NOT NULL AND created_at >= ?
        GROUP BY session_file`,
    )
    .all(sinceSec) as Array<{ session_file: string; valence: number; first_at: number; last_at: number }>;

  let factsStamped = 0;
  const stamp = db.prepare(
    `UPDATE facts SET valence = ?, affect_source = 'frustration-detector'
      WHERE provenance_session = ?
        AND valence IS NULL
        AND created_at BETWEEN ? AND ?`,
  );
  for (const s of sessions) {
    const valence = Math.max(-1, Math.min(1, s.valence));
    const result = stamp.run(valence, s.session_file, s.first_at - WINDOW_SLACK_SEC, s.last_at + WINDOW_SLACK_SEC);
    factsStamped += Number(result.changes ?? 0);
  }
  return { sessionsSeen: sessions.length, factsStamped };
}
