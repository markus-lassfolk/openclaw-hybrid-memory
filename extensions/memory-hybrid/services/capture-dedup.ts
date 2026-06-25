/**
 * Observation dedup window for capture paths (Issue #1913).
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createTransaction } from "../utils/sqlite-transaction.js";

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

/** Read-only dedup window probe — does not bump duplicate_count. */
export function peekCaptureDedupWindow(
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
  return { skip: true, existingId: row.id };
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
  const peek = peekCaptureDedupWindow(db, input, windowMinutes);
  if (!peek.skip || !peek.existingId) return peek;
  db.prepare(`UPDATE facts SET duplicate_count = COALESCE(duplicate_count, 0) + 1 WHERE id = ?`).run(peek.existingId);
  return peek;
}

export type CaptureStoreDedupResult<TStoreResult extends { skipped?: boolean; entry: { id: string } }> =
  | { skipped: true; dedupExistingId?: string }
  | { skipped: false; storeResult: TStoreResult };

/**
 * Store with optional observation dedup window (#1913).
 * When factsDb has no getRawDb(), skips the transaction wrapper and dedup hash write.
 */
export function runCaptureStoreWithDedupWindow<TStoreResult extends { skipped?: boolean; entry: { id: string } }>(
  factsDb: { getRawDb?: () => DatabaseSync },
  dedupWindowMinutes: number,
  dedupInput: CaptureDedupInput,
  store: () => TStoreResult,
): CaptureStoreDedupResult<TStoreResult> {
  const execute = (): CaptureStoreDedupResult<TStoreResult> => {
    const rawDb = typeof factsDb.getRawDb === "function" ? factsDb.getRawDb() : null;
    if (rawDb && dedupWindowMinutes > 0) {
      const dedupCheck = checkCaptureDedupWindow(rawDb, dedupInput, dedupWindowMinutes);
      if (dedupCheck.skip) {
        return { skipped: true, dedupExistingId: dedupCheck.existingId };
      }
    }
    const storeResult = store();
    if (rawDb && dedupWindowMinutes > 0 && !storeResult.skipped) {
      rawDb
        .prepare("UPDATE facts SET content_dedup_hash = ? WHERE id = ?")
        .run(computeCaptureDedupHash(dedupInput), storeResult.entry.id);
    }
    return { skipped: false, storeResult };
  };

  const rawDb = typeof factsDb.getRawDb === "function" ? factsDb.getRawDb() : null;
  if (rawDb) {
    return createTransaction(rawDb, execute, "IMMEDIATE")();
  }
  return execute();
}
