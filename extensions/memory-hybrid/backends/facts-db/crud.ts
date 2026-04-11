/**
 * Fact lifecycle CRUD: store, access refresh, delete, dedupe (Issue #954).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { type DecayClass, type MemoryCategory, TTL_DEFAULTS } from "../../config.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { calculateExpiry, classifyDecay } from "../../utils/decay.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { normalizedHash, serializeTags } from "../../utils/tags.js";

/** Input shape for `FactsDB.store` / `storeFact`. */
export type StoreFactInput = Omit<
  MemoryEntry,
  "id" | "createdAt" | "decayClass" | "expiresAt" | "lastConfirmedAt" | "confidence"
> & {
  decayClass?: DecayClass;
  expiresAt?: number | null;
  confidence?: number;
  summary?: string | null;
  sourceDate?: number | null;
  tags?: string[] | null;
  validFrom?: number | null;
  validUntil?: number | null;
  supersedesId?: string | null;
  procedureType?: "positive" | "negative" | null;
  successCount?: number;
  lastValidated?: number | null;
  sourceSessions?: string | null;
  embeddingModel?: string | null;
  scope?: "global" | "user" | "agent" | "session";
  scopeTarget?: string | null;
  decayFreezeUntil?: number | null;
  provenanceSession?: string | null;
  sourceTurn?: number | null;
  extractionMethod?: string | null;
  extractionConfidence?: number | null;
  preserveUntil?: number | null;
  preserveTags?: string[] | null;
};

export function validateStoreEntryInput(
  entry: Omit<MemoryEntry, "id" | "createdAt" | "decayClass" | "expiresAt" | "lastConfirmedAt" | "confidence"> & {
    category?: MemoryCategory;
    importance?: number;
  },
): void {
  const text = (entry.text ?? "").trim();
  if (text.length === 0) {
    throw new Error("memory-hybrid: cannot store empty fact text");
  }
  const imp = entry.importance ?? 0.5;
  if (!Number.isFinite(imp) || imp < 0 || imp > 1) {
    throw new Error("memory-hybrid: importance must be a number in [0, 1]");
  }
}

export function getDuplicateIdByNormalizedHash(db: DatabaseSync, text: string): string | null {
  const hash = normalizedHash(text);
  const row = db.prepare("SELECT id FROM facts WHERE normalized_hash = ? LIMIT 1").get(hash) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

export type StoreFactContext = {
  db: DatabaseSync;
  fuzzyDedupe: boolean;
  getById: (id: string) => MemoryEntry | null;
  invalidateSupersededCache: () => void;
};

export function storeFact(ctx: StoreFactContext, entry: StoreFactInput): MemoryEntry {
  validateStoreEntryInput(entry);
  if (ctx.fuzzyDedupe) {
    const existingId = getDuplicateIdByNormalizedHash(ctx.db, entry.text);
    if (existingId) {
      const existing = ctx.getById(existingId);
      if (existing) return existing;
    }
  }

  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);

  const decayClass =
    entry.decayClass || classifyDecay(entry.entity ?? null, entry.key ?? null, entry.value ?? null, entry.text);
  const expiresAt = entry.expiresAt !== undefined ? entry.expiresAt : calculateExpiry(decayClass, nowSec);
  const importance = entry.importance ?? 0.5;
  const why = entry.why ?? null;
  const entity = entry.entity ?? null;
  const key = entry.key ?? null;
  const value = entry.value ?? null;
  const source = entry.source ?? "conversation";
  const confidence = entry.confidence ?? 1.0;
  const summary = entry.summary ?? null;
  const embeddingModel = entry.embeddingModel ?? null;
  const normHash = normalizedHash(entry.text);
  const sourceDate = entry.sourceDate ?? null;
  const tags = entry.tags ?? null;
  const tagsStr = tags ? serializeTags(tags) : null;
  const validFrom = entry.validFrom ?? sourceDate ?? nowSec;
  const validUntil = entry.validUntil ?? null;
  const supersedesId = entry.supersedesId ?? null;
  const scope = entry.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (entry.scopeTarget ?? null);
  if (scope !== "global" && !scopeTarget) {
    throw new Error(`scopeTarget required for non-global scope: ${scope}`);
  }
  const procedureType = entry.procedureType ?? null;
  const successCount = entry.successCount ?? 0;
  const lastValidated = entry.lastValidated ?? null;
  const sourceSessionsRaw = entry.sourceSessions ?? null;
  const sourceSessionsStr =
    sourceSessionsRaw == null
      ? null
      : typeof sourceSessionsRaw === "string"
        ? sourceSessionsRaw
        : JSON.stringify(sourceSessionsRaw);
  const provenanceSession = entry.provenanceSession ?? null;
  const sourceTurn = entry.sourceTurn ?? null;
  const extractionMethod = entry.extractionMethod ?? null;
  const extractionConfidence = entry.extractionConfidence !== undefined ? entry.extractionConfidence : null;
  const preserveUntil = entry.preserveUntil ?? null;
  const preserveTags = entry.preserveTags ?? null;
  const preserveTagsStr = preserveTags ? JSON.stringify(preserveTags) : null;

  const tier: MemoryTier = (entry as { tier?: MemoryTier }).tier ?? "warm";
  const rawFreeze = (entry as { decayFreezeUntil?: number | null }).decayFreezeUntil ?? null;
  const decayFreezeUntil = rawFreeze !== null && Number.isFinite(rawFreeze) ? rawFreeze : null;
  const adjustedExpiresAt =
    decayFreezeUntil !== null && expiresAt !== null && expiresAt < decayFreezeUntil ? decayFreezeUntil : expiresAt;
  const tx = createTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO facts (id, text, why, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, embedding_model, normalized_hash, source_date, tags, valid_from, valid_until, supersedes_id, tier, scope, scope_target, procedure_type, success_count, last_validated, source_sessions, decay_freeze_until, provenance_session, source_turn, extraction_method, extraction_confidence, preserve_until, preserve_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.text,
        why,
        entry.category,
        importance,
        entity,
        key,
        value,
        source,
        nowSec,
        decayClass,
        adjustedExpiresAt,
        nowSec,
        confidence,
        summary,
        embeddingModel,
        normHash,
        sourceDate,
        tagsStr,
        validFrom,
        validUntil,
        supersedesId,
        tier,
        scope,
        scopeTarget,
        procedureType,
        successCount,
        lastValidated,
        sourceSessionsStr,
        decayFreezeUntil,
        provenanceSession,
        sourceTurn,
        extractionMethod,
        extractionConfidence,
        preserveUntil,
        preserveTagsStr,
      );
  });
  tx();
  if (supersedesId) {
    ctx.invalidateSupersededCache();
  }
  const loaded = ctx.getById(id);
  if (!loaded) {
    throw new Error(`memory-hybrid: store() failed to read back inserted fact ${id}`);
  }
  return loaded;
}

/** Update recall_count and last_accessed for facts (bulk UPDATE). */
export function refreshAccessedFacts(db: DatabaseSync, ids: string[]): void {
  if (ids.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const BATCH_SIZE = 500;

  const tx = createTransaction(db, () => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");

      db.prepare(
        `UPDATE facts SET last_confirmed_at = ?, expires_at = CASE decay_class WHEN 'stable' THEN ? + ? WHEN 'active' THEN ? + ? WHEN 'durable' THEN ? + ? WHEN 'normal' THEN ? + ? ELSE expires_at END WHERE id IN (${placeholders}) AND decay_class IN ('stable', 'active', 'durable', 'normal')`,
      ).run(
        nowSec,
        nowSec,
        TTL_DEFAULTS.stable,
        nowSec,
        TTL_DEFAULTS.active,
        nowSec,
        TTL_DEFAULTS.durable,
        nowSec,
        TTL_DEFAULTS.normal,
        ...batch,
      );

      db.prepare(
        `UPDATE facts SET recall_count = recall_count + 1, last_accessed = ?, access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'unixepoch') WHERE id IN (${placeholders})`,
      ).run(nowSec, nowSec, ...batch);
    }
  });
  tx();
}

export function deleteFact(db: DatabaseSync, id: string): boolean {
  db.prepare("DELETE FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ?").run(id, id);
  db.prepare(`DELETE FROM memory_links WHERE target_fact_id = ? AND link_type != 'DERIVED_FROM'`).run(id);
  const result = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Exact or (if fuzzyDedupe) normalized-text duplicate. */
export function hasDuplicateText(db: DatabaseSync, fuzzyDedupe: boolean, text: string): boolean {
  const exact = db.prepare("SELECT id FROM facts WHERE text = ? LIMIT 1").get(text);
  if (exact) return true;
  if (fuzzyDedupe && getDuplicateIdByNormalizedHash(db, text) !== null) return true;
  return false;
}
