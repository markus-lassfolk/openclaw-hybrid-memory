/**
 * Fact lifecycle CRUD: store, access refresh, delete, dedupe (Issue #954).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { type DecayClass, type MemoryCategory, type StoreConfig, TTL_DEFAULTS } from "../../config.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { calculateExpiry, classifyDecay } from "../../utils/decay.js";
import { createTransaction, type SqliteTransactionBeginMode } from "../../utils/sqlite-transaction.js";
import { applyDedupe, hasGlobalDuplicateProbe, resolveDedupeProfile } from "../../services/dedupe-policy.js";
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
  storeConfig?: StoreConfig;
  getById: (id: string) => MemoryEntry | null;
  invalidateSupersededCache: () => void;
  warnOnce?: (key: string, message: string) => void;
  warnOnceKey?: string;
  suppressVectorFallbackWarning?: boolean;
  /**
   * Pre-computed vector neighbour candidates for the new fact's embedding (#1186, #1194).
   * Caller is expected to populate this when the embedding is known and the policy has
   * `vectorThreshold` configured.
   */
  vectorCandidates?: ReadonlyArray<{ id: string; score: number }>;
};

export function storeFact(ctx: StoreFactContext, entry: StoreFactInput): MemoryEntry {
  validateStoreEntryInput(entry);
  const sourceForPolicy = entry.source ?? "conversation";
  const profile = resolveDedupeProfile(sourceForPolicy, ctx.storeConfig ?? { fuzzyDedupe: ctx.fuzzyDedupe });
  const nowSec = Math.floor(Date.now() / 1000);
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);

  // Normalized-hash + lexical Jaccard dedupe (per-source profiles) before daily quota.
  const dedupe = applyDedupe(
    profile,
    { text: entry.text, source: sourceForPolicy, scope: entry.scope ?? "global", scopeTarget: entry.scopeTarget ?? null },
    {
      db: ctx.db,
      nowSec,
      fuzzyDedupe: ctx.fuzzyDedupe,
      vectorCandidates: ctx.vectorCandidates,
      warnOnce: ctx.warnOnce,
      warnOnceKey: ctx.warnOnceKey,
      suppressVectorFallbackWarning: ctx.suppressVectorFallbackWarning,
      warn: (m) => console.warn(m),
    },
  );

  if (dedupe.action === "skip") {
    // #1186 acceptance ("cosine ≥ 0.85 → skip + recall_count++"): when we skipped because
    // of a near-duplicate, bump recall on the existing winner so the dedup acts as a
    // reinforcement signal instead of silently dropping the new evidence.
    if (dedupe.reason === "vector" || dedupe.reason === "lexical" || dedupe.reason === "hash") {
      ctx.db
        .prepare(
          `UPDATE facts SET recall_count = recall_count + 1, access_count = access_count + 1, last_confirmed_at = ? WHERE id = ?`,
        )
        .run(nowSec, dedupe.existingId);
    }
    const existing = ctx.getById(dedupe.existingId);
    if (existing) return existing;
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  if (dedupe.action === "boost") {
    ctx.db
      .prepare(
        "UPDATE facts SET recall_count = recall_count + 1, access_count = access_count + 1, importance = min(1.0, importance + ?) WHERE id = ?",
      )
      .run(dedupe.boostBy, dedupe.existingId);
    const boosted = ctx.getById(dedupe.existingId);
    if (boosted) return boosted;
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  if (dedupe.action === "merge") {
    const existing = ctx.getById(dedupe.existingId);
    if (existing) {
      const mergedText = existing.text.includes(entry.text)
        ? existing.text
        : `${existing.text}\n${entry.text}`.slice(0, 4000);
      const mergedHash = normalizedHash(mergedText);
      ctx.db
        .prepare("UPDATE facts SET text = ?, normalized_hash = ? WHERE id = ?")
        .run(mergedText, mergedHash, existing.id);
      return ctx.getById(existing.id) ?? existing;
    }
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  const id = randomUUID();

  const importance = entry.importance ?? 0.5;
  const why = entry.why ?? null;
  const entity = entry.entity ?? null;
  const key = entry.key ?? null;
  const value = entry.value ?? null;
  const source = entry.source ?? "conversation";
  const category = entry.category ?? "other";
  const decayClass =
    entry.decayClass || classifyDecay(entity, key, value, entry.text, { source, category, importance });
  const expiresAt = entry.expiresAt !== undefined ? entry.expiresAt : calculateExpiry(decayClass, nowSec);
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
  const provenanceJson = entry.provenanceJson ?? null;

  const tier: MemoryTier = (entry as { tier?: MemoryTier }).tier ?? "warm";
  const rawFreeze = (entry as { decayFreezeUntil?: number | null }).decayFreezeUntil ?? null;
  const decayFreezeUntil = rawFreeze !== null && Number.isFinite(rawFreeze) ? rawFreeze : null;
  const adjustedExpiresAt =
    decayFreezeUntil !== null && expiresAt !== null && expiresAt < decayFreezeUntil ? decayFreezeUntil : expiresAt;
  const beginMode: SqliteTransactionBeginMode = profile.maxPerDay != null ? "IMMEDIATE" : "DEFERRED";
  // Quota "drop" path records `dropped` in this transaction, commits, then throws below so
  // observability survives the error. Retrying the same write increments `dropped` again (each
  // attempt is counted), which is intentional for operational metrics.
  let quotaExceededSource: string | null = null;
  let evictedFactId: string | null = null;
  const tx = createTransaction(
    ctx.db,
    () => {
      if (profile.maxPerDay != null) {
        const quotaRow = ctx.db
          .prepare("SELECT count FROM daily_writes WHERE source = ? AND day = ?")
          .get(sourceForPolicy, day) as { count: number } | undefined;
        if ((quotaRow?.count ?? 0) >= profile.maxPerDay) {
          // #1194: legacy behaviour was throw-on-overflow + bump `dropped`. With
          // `onOverflow=evict-lowest-confidence`, we instead supersede the lowest-confidence
          // active fact for this source and let the new write through, which prevents the
          // quota from acting as a "freeze the noise" gate when noisy sources accumulate stale
          // low-confidence rows.
          if (profile.onOverflow === "evict-lowest-confidence") {
            const victim = ctx.db
              .prepare(
                `SELECT id FROM facts
                  WHERE source = ? AND superseded_at IS NULL
                  ORDER BY confidence ASC, COALESCE(recall_count, 0) ASC, created_at ASC
                  LIMIT 1`,
              )
              .get(sourceForPolicy) as { id: string } | undefined;
            if (victim) {
              ctx.db
                .prepare(`UPDATE facts SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`)
                .run(nowSec, victim.id);
              evictedFactId = victim.id;
              ctx.db
                .prepare(
                  `INSERT INTO daily_writes (source, day, count, dropped, evicted) VALUES (?, ?, 0, 0, 1)
                   ON CONFLICT(source, day) DO UPDATE SET evicted = evicted + 1`,
                )
                .run(sourceForPolicy, day);
              // Fall through to the INSERT path below (do not return).
            } else {
              quotaExceededSource = sourceForPolicy;
              ctx.db
                .prepare(
                  `INSERT INTO daily_writes (source, day, count, dropped) VALUES (?, ?, 0, 1)
                   ON CONFLICT(source, day) DO UPDATE SET dropped = dropped + 1`,
                )
                .run(sourceForPolicy, day);
              return;
            }
          } else {
            quotaExceededSource = sourceForPolicy;
            ctx.db
              .prepare(
                `INSERT INTO daily_writes (source, day, count, dropped) VALUES (?, ?, 0, 1)
                 ON CONFLICT(source, day) DO UPDATE SET dropped = dropped + 1`,
              )
              .run(sourceForPolicy, day);
            return;
          }
        }
      }
      ctx.db
        .prepare(
          `INSERT INTO facts (id, text, why, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, embedding_model, normalized_hash, source_date, tags, valid_from, valid_until, supersedes_id, tier, scope, scope_target, procedure_type, success_count, last_validated, source_sessions, decay_freeze_until, provenance_session, source_turn, extraction_method, extraction_confidence, preserve_until, preserve_tags, provenance_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entry.text,
          why,
          category,
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
          provenanceJson,
        );
      // Count bump is in the same IMMEDIATE transaction as the facts INSERT when maxPerDay is set.
      if (profile.maxPerDay != null) {
        ctx.db
          .prepare(
            `INSERT INTO daily_writes (source, day, count, dropped) VALUES (?, ?, 1, 0)
           ON CONFLICT(source, day) DO UPDATE SET count = count + 1`,
          )
          .run(sourceForPolicy, day);
      }
    },
    beginMode,
  );
  tx();
  if (quotaExceededSource) {
    throw new Error(`memory-hybrid: daily write quota exceeded for source ${quotaExceededSource}`);
  }
  if (supersedesId || evictedFactId) {
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
  db.prepare(`DELETE FROM memory_links WHERE source_fact_id = ? OR target_fact_id = ?`).run(id, id);
  const result = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Exact match or write-time dedupe policy would not insert a new row.
 * When `source` is omitted, uses a global probe (any source) for idempotency / CLI alignment (#1202).
 */
export function hasDuplicateText(
  db: DatabaseSync,
  fuzzyDedupe: boolean,
  text: string,
  storeConfig?: StoreConfig,
  source?: string,
): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  if (source === undefined) {
    return hasGlobalDuplicateProbe(db, text, { nowSec, fuzzyDedupe, storeConfig });
  }
  const profile = resolveDedupeProfile(source, storeConfig ?? { fuzzyDedupe });
  const r = applyDedupe(profile, { text, source }, { db, nowSec, fuzzyDedupe });
  return r.action !== "store";
}

export function statsDailyWrites(
  db: DatabaseSync,
): Array<{ source: string; day: string; count: number; dropped: number; evicted: number }> {
  return db
    .prepare(
      "SELECT source, day, count, dropped, COALESCE(evicted, 0) AS evicted FROM daily_writes ORDER BY day DESC, source ASC LIMIT 100",
    )
    .all() as Array<{ source: string; day: string; count: number; dropped: number; evicted: number }>;
}
