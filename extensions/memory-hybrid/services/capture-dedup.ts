/**
 * Observation dedup window for capture paths (Issue #1913).
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CaptureDedupInput = {
  text: string;
  entity?: string | null;
  key?: string | null;
  scope?: string | null;
  scopeTarget?: string | null;
};

/** Normalize capture content for dedup fingerprint. */
export function computeCaptureDedupHash(input: CaptureDedupInput): string {
  const payload = [
    input.text.trim().toLowerCase().replace(/\s+/g, " "),
    (input.entity ?? "").trim().toLowerCase(),
    (input.key ?? "").trim().toLowerCase(),
    (input.scope ?? "global").trim().toLowerCase(),
    (input.scopeTarget ?? "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * When an identical hash exists within the window for the same scope, bump duplicate_count
 * on the existing row and return skip=true. Otherwise returns skip=false.
 */
export function checkCaptureDedupWindow(
  db: DatabaseSync,
  input: CaptureDedupInput,
  windowMinutes: number,
): { skip: boolean; existingId?: string } {
  if (windowMinutes <= 0) return { skip: false };
  const hash = computeCaptureDedupHash(input);
  const scope = input.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (input.scopeTarget ?? null);
  const cutoff = Math.floor(Date.now() / 1000) - windowMinutes * 60;
  const row = db
    .prepare(
      `SELECT id FROM facts
       WHERE content_dedup_hash = ? AND superseded_at IS NULL AND created_at >= ?
         AND COALESCE(scope, 'global') = ?
         AND (? IS NULL OR scope_target = ? OR (scope_target IS NULL AND ? IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(hash, cutoff, scope, scopeTarget, scopeTarget, scopeTarget) as { id: string } | undefined;
  if (!row) return { skip: false };
  db.prepare(
    `UPDATE facts SET duplicate_count = COALESCE(duplicate_count, 0) + 1 WHERE id = ?`,
  ).run(row.id);
  return { skip: true, existingId: row.id };
}
