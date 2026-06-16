/**
 * Quarantine blocked synthesis drafts (Issue #1916).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContaminationCheckResult } from "./contamination-guard.js";

export function quarantineSynthesisDraft(
  db: DatabaseSync,
  draft: string,
  check: ContaminationCheckResult,
  sourceTexts: string[],
): string {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO synthesis_quarantine (id, draft_text, reason, source_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    draft.slice(0, 10_000),
    `${check.layer}: ${check.reason ?? "blocked"}`,
    JSON.stringify({ sources: sourceTexts.map((t) => t.slice(0, 500)) }),
    now,
  );
  return id;
}
