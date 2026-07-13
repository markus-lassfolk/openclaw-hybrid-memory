/**
 * Fact lifecycle CRUD: store, access refresh, delete, dedupe (Issue #954).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { type DecayClass, type MemoryCategory, type StoreConfig, TTL_DEFAULTS } from "../../config.js";
import { isPromptArtifactOrReasoningTrace } from "../../services/capture-utils.js";
import { applyDedupe, hasGlobalDuplicateProbe, resolveDedupeProfile } from "../../services/dedupe-policy.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../utils/constants.js";
import { formatDateUtc, formatTimestampUtc } from "../../utils/dates.js";
import { calculateExpiry, classifyDecay } from "../../utils/decay.js";
import { createTransaction, type SqliteTransactionBeginMode } from "../../utils/sqlite-transaction.js";
import { normalizedHash, serializeTags } from "../../utils/tags.js";
import { resolveEntityForeignKeys } from "./entity-layer.js";
import { decrementFactDegreesForLink } from "./links.js";

const SQLITE_BUSY_STORE_MAX_RETRIES = 3;
const SQLITE_BUSY_STORE_BACKOFF_BASE_MS = 50;
const SQLITE_BUSY_STORE_BACKOFF_MAX_MS = 500;
const SQLITE_BUSY_STORE_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function isSqliteBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  return /SQLITE_BUSY|database is locked/i.test(message) || /SQLITE_BUSY/i.test(code);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SQLITE_BUSY_STORE_SLEEP, 0, 0, ms);
}

export function runWithSqliteBusyRetry<T = void>(db: DatabaseSync, run: () => T): T {
  for (let attempt = 0; attempt <= SQLITE_BUSY_STORE_MAX_RETRIES; attempt += 1) {
    try {
      return run();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt === SQLITE_BUSY_STORE_MAX_RETRIES) {
        throw err;
      }
      // Re-apply timeout before retry in case lock contention happened after reconnect/reopen.
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      const delayMs = Math.min(SQLITE_BUSY_STORE_BACKOFF_BASE_MS * 2 ** attempt, SQLITE_BUSY_STORE_BACKOFF_MAX_MS);
      sleepSync(delayMs);
    }
  }
  throw new Error("unreachable: runWithSqliteBusyRetry exhausted retries without throwing");
}

// Pre-store guard constants: filter internal artifacts (#1560, #1561).
// These categories and sources are not user-relevant memories.
const BLOCKED_CATEGORIES = new Set(["noop", "classification", "artifact", "chain-of-thought", "prompt"]);
const BLOCKED_SOURCES = new Set(["think", "classify", "remember", "noop", "compact", "derive"]);

/** Check if an entry would be blocked by the pre-store guard. */
export function isPreStoreGuardBlocked(entry: { category?: string; source?: string; text: string }): boolean {
  const entryCategory = entry.category ?? "";
  const entrySource = entry.source ?? "";
  return (
    BLOCKED_CATEGORIES.has(entryCategory) ||
    BLOCKED_SOURCES.has(entrySource) ||
    isPromptArtifactOrReasoningTrace(entry.text)
  );
}

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
   * Allow trusted edit paths to re-store an already persisted fact whose legacy
   * source/category is now blocked by the artifact guard (#1560/#1561).
   */
  allowPreStoreGuardBypass?: boolean;
  /**
   * Pre-computed vector neighbour candidates for the new fact's embedding (#1186, #1194).
   * Caller is expected to populate this when the embedding is known and the policy has
   * `vectorThreshold` configured.
   */
  vectorCandidates?: ReadonlyArray<{ id: string; score: number }>;
};

export type StoredFactResult = {
  /** The stored fact entry */
  entry: MemoryEntry;
  /** Stored results are never legacy-rejected. */
  rejected?: false;
  /**
   * CRITICAL (#2): ID of fact evicted during onOverflow=evict-lowest-confidence.
   * Caller MUST delete the vector from VectorDB to prevent orphaned vectors.
   */
  evictedFactId?: string | null;
  /**
   * True when the stored fact's text was updated in-place by a dedupe merge, so the
   * existing LanceDB vector now encodes stale content.  Caller MUST re-embed
   * `entry.text` and replace the vector for `entry.id` in VectorDB.
   */
  embeddingStale?: boolean;
  /**
   * True only when this call inserted a brand-new fact row.
   * False when the returned entry points to a pre-existing row (skip/boost/merge).
   */
  newlyStored?: boolean;
  /**
   * Original text for dedupe-merge updates. Callers can use this for reliable rollback
   * when post-merge embed/vector persistence fails.
   */
  preMergeText?: string | null;
  /**
   * True when the pre-store guard filtered this entry as an internal artifact (#1560, #1561).
   * Callers must skip post-store operations (vector upsert, supersession, logging) when true.
   */
  skipped?: false;
};

export type SkippedStoreFactResult = {
  /**
   * True when the pre-store guard filtered this entry as an internal artifact (#1560, #1561).
   * No fact was written, so callers must skip all post-store operations.
   */
  skipped: true;
  /** Non-addressable placeholder retained for legacy callers; do not use for vector/supersession/provenance side effects. */
  entry: MemoryEntry;
  /** Skipped results never evict persisted facts. */
  evictedFactId: null;
  /** Skipped results never modify embeddings. */
  embeddingStale: false;
  /** Skipped results never insert a persisted row. */
  newlyStored: false;
  /** Skipped results never mutate an existing row. */
  preMergeText: null;
  /** Legacy alias for skipped. */
  rejected: true;
};

export type StoreFactResult = StoredFactResult | SkippedStoreFactResult;

function createSkippedStorePlaceholder(entry: StoreFactInput): MemoryEntry {
  const nowSec = Math.floor(Date.now() / 1000);
  const decayClass =
    entry.decayClass ??
    classifyDecay(entry.entity ?? null, entry.key ?? null, entry.value ?? null, entry.text, {
      source: entry.source ?? null,
      category: entry.category ?? null,
      importance: entry.importance ?? 0.5,
    });
  return {
    id: "",
    text: entry.text,
    why: entry.why ?? null,
    category: entry.category ?? "other",
    importance: entry.importance ?? 0.5,
    entity: entry.entity ?? null,
    key: entry.key ?? null,
    value: entry.value ?? null,
    source: entry.source ?? "conversation",
    createdAt: nowSec,
    sourceDate: entry.sourceDate ?? null,
    decayClass,
    expiresAt: entry.expiresAt ?? calculateExpiry(decayClass, nowSec),
    lastConfirmedAt: nowSec,
    confidence: entry.confidence ?? 1,
    summary: entry.summary ?? null,
    tags: entry.tags ?? null,
    validFrom: entry.validFrom ?? null,
    validUntil: entry.validUntil ?? null,
    supersedesId: entry.supersedesId ?? null,
    scope: entry.scope ?? "global",
    scopeTarget: entry.scopeTarget ?? null,
    procedureType: entry.procedureType ?? null,
    successCount: entry.successCount,
    lastValidated: entry.lastValidated ?? null,
    sourceSessions: entry.sourceSessions ?? null,
    embeddingModel: entry.embeddingModel ?? null,
    provenanceSession: entry.provenanceSession ?? null,
    sourceTurn: entry.sourceTurn ?? null,
    extractionMethod: entry.extractionMethod ?? null,
    extractionConfidence: entry.extractionConfidence ?? null,
    decayFreezeUntil: entry.decayFreezeUntil ?? null,
    preserveUntil: entry.preserveUntil ?? null,
    preserveTags: entry.preserveTags ?? null,
  };
}

export function storeFact(ctx: StoreFactContext, entry: StoreFactInput): StoreFactResult {
  validateStoreEntryInput(entry);

  const entryCategory = entry.category ?? "";
  const entrySource = entry.source ?? "";
  if (isPromptArtifactOrReasoningTrace(entry.text)) {
    return {
      skipped: true,
      rejected: true,
      evictedFactId: null,
      embeddingStale: false,
      newlyStored: false,
      preMergeText: null,
      entry: createSkippedStorePlaceholder(entry),
    };
  }
  if (!ctx.allowPreStoreGuardBypass && (BLOCKED_CATEGORIES.has(entryCategory) || BLOCKED_SOURCES.has(entrySource))) {
    return {
      skipped: true,
      rejected: true,
      evictedFactId: null,
      embeddingStale: false,
      newlyStored: false,
      preMergeText: null,
      entry: createSkippedStorePlaceholder(entry),
    };
  }

  const sourceForPolicy = entry.source ?? "conversation";
  const profile = resolveDedupeProfile(sourceForPolicy, ctx.storeConfig ?? { fuzzyDedupe: ctx.fuzzyDedupe });
  const nowSec = Math.floor(Date.now() / 1000);
  const day = formatDateUtc(nowSec);

  const dedupeCandidate = {
    text: entry.text,
    source: sourceForPolicy,
    scope: entry.scope ?? "global",
    scopeTarget: entry.scopeTarget ?? null,
    category: entry.category ?? null,
    entity: entry.entity ?? null,
    key: entry.key ?? null,
    value: entry.value ?? null,
  };
  const dedupeCtx = {
    db: ctx.db,
    nowSec,
    fuzzyDedupe: ctx.fuzzyDedupe,
    vectorCandidates: ctx.vectorCandidates,
    warnOnce: ctx.warnOnce,
    warnOnceKey: ctx.warnOnceKey,
    suppressVectorFallbackWarning: ctx.suppressVectorFallbackWarning,
    warn: (_m: string) => {},
  };

  // Normalized-hash + lexical Jaccard dedupe (per-source profiles) before daily quota.
  const dedupe = applyDedupe(profile, dedupeCandidate, dedupeCtx);

  if (dedupe.action === "skip") {
    // #1186 acceptance ("cosine ≥ 0.85 → skip + recall_count++"): when we skipped because
    // of a near-duplicate, bump recall on the existing winner so the dedup acts as a
    // reinforcement signal instead of silently dropping the new evidence.
    if (dedupe.reason === "vector" || dedupe.reason === "lexical" || dedupe.reason === "hash") {
      runWithSqliteBusyRetry(ctx.db, () => {
        ctx.db
          .prepare(
            "UPDATE facts SET recall_count = recall_count + 1, access_count = access_count + 1, last_confirmed_at = ? WHERE id = ?",
          )
          .run(nowSec, dedupe.existingId);
      });
    }
    const existing = ctx.getById(dedupe.existingId);
    if (existing)
      return { entry: existing, evictedFactId: null, embeddingStale: false, newlyStored: false, preMergeText: null };
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  if (dedupe.action === "boost") {
    runWithSqliteBusyRetry(ctx.db, () => {
      ctx.db
        .prepare(
          "UPDATE facts SET recall_count = recall_count + 1, access_count = access_count + 1, importance = min(1.0, importance + ?) WHERE id = ?",
        )
        .run(dedupe.boostBy, dedupe.existingId);
    });
    const boosted = ctx.getById(dedupe.existingId);
    if (boosted)
      return { entry: boosted, evictedFactId: null, embeddingStale: false, newlyStored: false, preMergeText: null };
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  if (dedupe.action === "merge") {
    const existing = ctx.getById(dedupe.existingId);
    if (existing) {
      const alreadyContained = existing.text.includes(entry.text);
      if (alreadyContained) {
        return { entry: existing, evictedFactId: null, embeddingStale: false, newlyStored: false, preMergeText: null };
      }

      const rawMergedText = `${existing.text}\n${entry.text}`;
      if (rawMergedText.length > 4000) {
        capturePluginError(
          new Error(`dedupe merge for fact ${existing.id} truncated to 4000 chars; some content may be lost`),
          {
            operation: "dedupe-merge-truncate",
            subsystem: "facts-db",
            severity: "warning",
            tags: { factId: existing.id, combinedLength: rawMergedText.length, truncatedLength: 4000 },
          },
        );
      }
      const mergedText = rawMergedText.slice(0, 4000);
      const mergedHash = normalizedHash(mergedText);
      // Wrap the merge UPDATE in a transaction so it is atomic and can be
      // rolled back on failure.  Without this, an interrupted write leaves
      // SQLite with new merged text while LanceDB still encodes the pre-merge
      // content (split-brain).  createTransaction() uses a SAVEPOINT when a
      // transaction is already active, so nesting is safe.
      const mergeTx = createTransaction(ctx.db, () => {
        ctx.db
          .prepare("UPDATE facts SET text = ?, normalized_hash = ? WHERE id = ?")
          .run(mergedText, mergedHash, existing.id);
      });
      runWithSqliteBusyRetry(ctx.db, () => {
        mergeTx();
      });
      // Signal callers to re-embed only when the persisted text changed. This handles edge
      // cases where append text is truncated and the final merged text remains unchanged.
      const embeddingStale = mergedText !== existing.text;
      return {
        entry: ctx.getById(existing.id) ?? existing,
        evictedFactId: null,
        embeddingStale,
        newlyStored: false,
        preMergeText: existing.text,
      };
    }
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupe.existingId} not found (may have been deleted concurrently)`,
    );
  }

  const id = randomUUID();

  const importance = entry.importance ?? 0.5;
  const why = entry.why ?? null;
  const entity = entry.entity?.trim() || null;
  const key = entry.key?.trim() || null;
  const value = entry.value ?? null;
  const source = entry.source ?? "conversation";
  const category = (entry.category?.trim() || "other").toLowerCase();
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
  // Always IMMEDIATE (not conditional on profile.maxPerDay): the dedupe recheck below needs the
  // write lock held from the start of the transaction, not just from the first write inside it.
  const beginMode: SqliteTransactionBeginMode = "IMMEDIATE";
  // Quota "drop" path records `dropped` in this transaction, commits, then throws below so
  // observability survives the error. Retrying the same write increments `dropped` again (each
  // attempt is counted), which is intentional for operational metrics.
  let quotaExceededSource: string | null = null;
  let evictedFactId: string | null = null;
  const dedupeRaceHitRef: { existingId: string | null } = { existingId: null };
  const tx = createTransaction(
    ctx.db,
    () => {
      // Re-run the dedupe check now that the write lock is held. The first applyDedupe() call
      // above ran without a lock, so two concurrent storeFact() calls for identical/near-identical
      // text could both observe "no duplicate" and both reach here — this recheck closes that
      // window by making the final duplicate decision atomic with the INSERT.
      const recheck = applyDedupe(profile, dedupeCandidate, dedupeCtx);
      if (recheck.action !== "store") {
        dedupeRaceHitRef.existingId = recheck.existingId;
        return;
      }
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
            // Restrict the eviction candidate to the same scope bucket as the incoming write —
            // otherwise a quota trip in one tenant's scope could supersede another tenant's fact
            // that merely shares the same `source` string.
            const evictScopeSql = scope === "global" ? " AND scope = 'global'" : " AND scope = ? AND scope_target = ?";
            const evictScopeParams: SQLInputValue[] = scope === "global" ? [] : [scope, scopeTarget];
            const victim = ctx.db
              .prepare(
                `SELECT id FROM facts
                  WHERE source = ? AND superseded_at IS NULL${evictScopeSql}
                  ORDER BY confidence ASC, COALESCE(recall_count, 0) ASC, created_at ASC
                  LIMIT 1`,
              )
              .get(sourceForPolicy, ...evictScopeParams) as { id: string } | undefined;
            if (victim) {
              ctx.db
                .prepare("UPDATE facts SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL")
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
  runWithSqliteBusyRetry(ctx.db, () => {
    quotaExceededSource = null;
    evictedFactId = null;
    dedupeRaceHitRef.existingId = null;
    tx();
  });
  if (dedupeRaceHitRef.existingId) {
    // A concurrent writer inserted (or updated) a matching fact between the first dedupe check
    // and this transaction acquiring the write lock — surface their fact instead of inserting a
    // duplicate. Deliberately skip re-applying skip/boost bookkeeping (recall_count bump, etc.)
    // for this rare race edge case; the concurrent writer's own store() call already did it.
    const raceWinner = ctx.getById(dedupeRaceHitRef.existingId);
    if (raceWinner) {
      return { entry: raceWinner, evictedFactId: null, embeddingStale: false, newlyStored: false, preMergeText: null };
    }
    throw new Error(
      `memory-hybrid: dedupe existing fact ${dedupeRaceHitRef.existingId} not found (may have been deleted concurrently)`,
    );
  }
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
  try {
    resolveEntityForeignKeys(ctx.db, id, loaded.entity);
  } catch (err) {
    // Non-fatal — the fact is already stored; losing the entity FK link only degrades
    // entity-scoped retrieval for this fact, not fact-level durability. Still worth surfacing:
    // silently swallowing this made entity-linkage gaps invisible.
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "resolve-entity-foreign-keys",
      subsystem: "facts-db",
      severity: "warning",
      tags: { factId: id, entity: loaded.entity ?? "" },
    });
  }
  return { entry: loaded, evictedFactId, embeddingStale: false, newlyStored: true, preMergeText: null };
}

/**
 * Update recall_count and last_accessed for facts (bulk UPDATE).
 * MUST only be called when full content is injected or explicitly recalled by user.
 * Index-only exposures must use refreshIndexedFacts() instead (#1559).
 */
export function refreshAccessedFacts(db: DatabaseSync, ids: string[]): void {
  if (ids.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIsoAt = formatTimestampUtc(nowSec);
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

      // Confidence rises with use (asymptotic toward 0.95 — 1.0 stays reserved for verified /
      // confirmFact): each genuine full-content recall closes 5% of the remaining gap. The CASE
      // guard keeps already-high confidence untouched (the bump formula would otherwise LOWER a
      // 1.0-confidence fact). Counterpart to graded decay: unused facts fade, used facts firm up.
      db.prepare(
        `UPDATE facts SET recall_count = recall_count + 1, last_accessed = ?, access_count = access_count + 1, last_accessed_at = ?,
           confidence = CASE WHEN confidence < 0.95 THEN confidence + (0.95 - confidence) * 0.05 ELSE confidence END
         WHERE id IN (${placeholders})`,
      ).run(nowSec, nowIsoAt, ...batch);
    }
  });
  tx();
}

/**
 * Update indexed_count and last_indexed for index-only exposures (#1559).
 * Does NOT inflate recall_count or last_accessed — these are separate signals.
 */
export function refreshIndexedFacts(db: DatabaseSync, ids: string[]): void {
  if (ids.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const BATCH_SIZE = 500;

  const tx = createTransaction(db, () => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      db.prepare(
        `UPDATE facts SET indexed_count = indexed_count + 1, last_indexed = ? WHERE id IN (${placeholders})`,
      ).run(nowSec, ...batch);
    }
  });
  tx();
}

export function deleteFact(db: DatabaseSync, id: string): boolean {
  const tx = createTransaction(db, () => {
    db.prepare("DELETE FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ?").run(id, id);
    // Fetch doomed links before deleting so the surviving endpoint's out_degree/in_degree can be
    // decremented (#2085/#2090) — decrementFactDegreesForLink is a no-op UPDATE for the id being
    // deleted here (it no longer exists in `facts`), so it's safe to call for both endpoints.
    const doomedLinks = db
      .prepare(
        "SELECT source_fact_id, target_fact_id, link_type FROM memory_links WHERE source_fact_id = ? OR target_fact_id = ?",
      )
      .all(id, id) as Array<{ source_fact_id: string; target_fact_id: string; link_type: string }>;
    db.prepare("DELETE FROM memory_links WHERE source_fact_id = ? OR target_fact_id = ?").run(id, id);
    for (const link of doomedLinks) {
      decrementFactDegreesForLink(db, link.source_fact_id, link.target_fact_id, link.link_type);
    }
    const result = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    return result.changes > 0;
  });
  return tx();
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
  structured?: { category?: MemoryCategory | null; entity?: string | null; key?: string | null; value?: string | null },
  scope?: "global" | "user" | "agent" | "session",
  scopeTarget?: string | null,
): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  if (source === undefined) {
    return hasGlobalDuplicateProbe(db, text, { nowSec, fuzzyDedupe, storeConfig });
  }
  const profile = resolveDedupeProfile(source, storeConfig ?? { fuzzyDedupe });
  const r = applyDedupe(
    profile,
    {
      text,
      source,
      category: structured?.category ?? null,
      entity: structured?.entity ?? null,
      key: structured?.key ?? null,
      value: structured?.value ?? null,
      scope,
      scopeTarget,
    },
    { db, nowSec, fuzzyDedupe },
  );
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
