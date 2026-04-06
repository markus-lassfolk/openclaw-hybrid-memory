/**
 * Embedding migration service: re-generate embeddings when the model or provider changes.
 * Handles LanceDB table swap when vector dimensions differ between old and new model.
 *
 * Issue #153: Migration tooling for switching embedding models.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { pluginLogger } from "../utils/logger.js";
import { is403QuotaOrRateLimitLike, is429OrWrapped } from "./chat.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MigrateEmbeddingsOptions {
  /** SQLite facts backend (source of truth for facts). */
  factsDb: FactsDB;
  /** LanceDB vector backend. Should already be initialized (and auto-repaired if dimensions changed). */
  vectorDb: VectorDB;
  /** The new (target) embedding provider — already configured with the new model. */
  embeddings: EmbeddingProvider;
  /** Number of facts to embed per API call (default: 50). */
  batchSize?: number;
  /**
   * Delay between batches in milliseconds. Spreads load to avoid 429/403 throttling
   * on Azure and other rate-limited providers. Default: 0 (no delay).
   */
  delayMsBetweenBatches?: number;
  /**
   * Progress callback fired after each batch.
   * @param completed  Facts processed so far (embedded or skipped).
   * @param total      Total facts in SQLite.
   */
  onProgress?: (completed: number, total: number) => void;
  /** Logger for structured output. Falls back to console when not provided. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

interface MigrateEmbeddingsResult {
  /** Total facts found in SQLite. */
  total: number;
  /** Facts successfully re-embedded and stored in LanceDB. */
  migrated: number;
  /** Facts skipped (near-duplicate already present, or embed returned empty). */
  skipped: number;
  /** Per-fact error strings for failures that were recoverable. */
  errors: string[];
}

export interface EmbeddingMaintenanceOptions extends MigrateEmbeddingsOptions {
  /** Provider name from the current plugin config (e.g. "openai", "ollama", "onnx"). */
  currentProvider: string;
  /** Model name from the current plugin config (e.g. "text-embedding-3-small"). */
  currentModel: string;
  /**
   * When `true`, automatically call `migrateEmbeddings` whenever a config change is detected.
   * When `false` (default), the change is logged but no re-embedding is performed.
   */
  autoMigrate: boolean;
}

interface EmbeddingMaintenanceResult {
  /** `true` when the recorded provider/model differs from `currentProvider`/`currentModel`. */
  changed: boolean;
  /** `true` when `migrateEmbeddings` was actually invoked this run. */
  migrated: boolean;
  /** Full migration stats — present only when `migrated` is `true`. */
  result?: MigrateEmbeddingsResult;
}

// ---------------------------------------------------------------------------
// Core migration
// ---------------------------------------------------------------------------

/**
 * Re-generate embeddings for all non-superseded facts using the provided embedding provider.
 *
 * Processing:
 *  1. Loads all non-expired facts from SQLite via `factsDb.getAll()`.
 *  2. Embeds each batch with `embeddings.embedBatch()` (falls back to single-fact embeds on error).
 *  3. Removes any stale LanceDB entry for the fact (handles dimension changes cleanly).
 *  4. Stores the new vector and updates `facts.embedding_model` in SQLite.
 *
 * Aborts early with a warning if the VectorDB is closed mid-run (hot-reload / shutdown).
 * Progress is emitted after every batch via `onProgress` and logged via `logger`.
 */
export async function migrateEmbeddings(opts: MigrateEmbeddingsOptions): Promise<MigrateEmbeddingsResult> {
  const { factsDb, vectorDb, embeddings, batchSize = 40, delayMsBetweenBatches = 0, onProgress, logger } = opts;

  const log = logger ?? { info: (m: string) => pluginLogger.info(m), warn: (m: string) => pluginLogger.warn(m) };

  const useBatched =
    typeof (factsDb as { getCount?: unknown }).getCount === "function" &&
    typeof (factsDb as { getBatch?: unknown }).getBatch === "function";
  const total = useBatched
    ? (factsDb as { getCount: (opts: { includeSuperseded: boolean }) => number }).getCount({ includeSuperseded: false })
    : factsDb.getAll({ includeSuperseded: false }).length;
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  log.info(
    `memory-hybrid: embedding-migration: starting — ${total} facts, ` +
      `model=${embeddings.modelName}, batchSize=${batchSize}`,
  );

  const initialGeneration = vectorDb.getCloseGeneration();
  let offset = 0;
  const facts = useBatched ? null : factsDb.getAll({ includeSuperseded: false });

  while (offset < total) {
    // Abort if the VectorDB was closed (hot-reload or shutdown)
    if (vectorDb.getCloseGeneration() !== initialGeneration) {
      log.warn(
        `memory-hybrid: embedding-migration: aborted at ${migrated + skipped}/${total} — VectorDB closed during migration`,
      );
      break;
    }

    const batch =
      (useBatched
        ? (
            factsDb as {
              getBatch: (
                offset: number,
                limit: number,
                opts: { includeSuperseded: boolean },
              ) => Array<{ id: string; text: string; importance?: number; category: string }>;
            }
          ).getBatch(offset, batchSize, { includeSuperseded: false })
        : facts?.slice(offset, offset + batchSize)) ?? [];
    if (batch.length === 0) break;
    const texts = batch.map((f) => f.text);

    // Attempt batch embed first; fall back to per-fact embeds on failure
    let vectors: (number[] | null)[];
    try {
      const batchResult = await embeddings.embedBatch(texts);
      vectors = batchResult;
    } catch (batchErr) {
      if (!shouldSuppressEmbeddingError(batchErr)) {
        capturePluginError(batchErr instanceof Error ? batchErr : new Error(String(batchErr)), {
          subsystem: "embeddings",
          operation: "migration-embed-batch",
        });
      }
      const batchAsErr = batchErr instanceof Error ? batchErr : new Error(String(batchErr));
      const isRateLimit = is429OrWrapped(batchAsErr) || is403QuotaOrRateLimitLike(batchErr);

      if (isRateLimit) {
        // Back off before per-fact fallback to avoid amplifying RPM pressure (#940 §3).
        const backoffMs = delayMsBetweenBatches > 0 ? delayMsBetweenBatches * 3 : 5_000;
        log.warn(
          `[embedding-quota] memory-hybrid: embedding-migration: batch rate-limited at offset ${offset} — backing off ${backoffMs}ms before per-fact fallback`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        log.warn(
          `memory-hybrid: embedding-migration: batch embed failed at offset ${offset} — falling back to per-fact embeds: ${batchErr}`,
        );
      }

      // Per-fact fallback: sequential with delay when rate-limited (prevents RPM storm).
      vectors = [];
      for (const fact of batch) {
        try {
          vectors.push(await embeddings.embed(fact.text));
        } catch (err) {
          if (!shouldSuppressEmbeddingError(err)) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "embeddings",
              operation: "migration-embed-single",
            });
          }
          const singleAsErr = err instanceof Error ? err : new Error(String(err));
          if (is429OrWrapped(singleAsErr) || is403QuotaOrRateLimitLike(err)) {
            const singleBackoff = delayMsBetweenBatches > 0 ? delayMsBetweenBatches * 2 : 3_000;
            log.warn(
              `[embedding-quota] memory-hybrid: embedding-migration: per-fact rate-limited for ${fact.id} — backing off ${singleBackoff}ms`,
            );
            await new Promise((r) => setTimeout(r, singleBackoff));
          }
          errors.push(`fact ${fact.id}: embed failed — ${String(err)}`);
          vectors.push(null);
        }
        if (isRateLimit && delayMsBetweenBatches > 0) {
          await new Promise((r) => setTimeout(r, delayMsBetweenBatches));
        }
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const fact = batch[j];
      const vec = vectors[j];
      if (!fact) continue;

      if (vec === null || !vec || vec.length === 0) {
        skipped++;
        continue;
      }

      try {
        // Check for duplicate BEFORE deleting old vector: if a different fact already has
        // a similar embedding, skip rather than removing the existing entry unnecessarily.
        const isDuplicate = await vectorDb.hasDuplicate(vec);
        if (!isDuplicate) {
          // Remove stale entry so dimension-changed stores succeed
          try {
            await vectorDb.delete(fact.id);
          } catch {
            // Entry may not exist — expected on first migration
          }
          await vectorDb.store({
            id: fact.id,
            text: fact.text,
            vector: vec,
            importance: fact.importance ?? 0.5,
            category: fact.category,
          });
          factsDb.setEmbeddingModel(fact.id, embeddings.modelName);
          migrated++;
        } else {
          skipped++;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "vector",
          operation: "migration-store",
        });
        errors.push(`fact ${fact.id}: store failed — ${String(err)}`);
        skipped++;
      }
    }

    offset += batch.length;
    onProgress?.(offset, total);

    // Periodic progress log for large datasets
    if (total >= 100 && offset % 100 < batch.length) {
      log.info(
        `memory-hybrid: embedding-migration: ${offset}/${total} processed ` +
          `(${migrated} migrated, ${errors.length} errors)`,
      );
    }

    // Inter-batch throttle to stay under provider rate limits (Azure/OpenAI).
    if (delayMsBetweenBatches > 0 && offset < total) {
      await new Promise((r) => setTimeout(r, delayMsBetweenBatches));
    }
  }

  log.info(
    `memory-hybrid: embedding-migration: complete — ${migrated} migrated, ${skipped} skipped, ${errors.length} errors (total ${total})`,
  );

  return { total, migrated, skipped, errors };
}

// ---------------------------------------------------------------------------
// Maintenance: detect config change → optionally migrate
// ---------------------------------------------------------------------------

/**
 * Maintenance function: compare the current embedding config against the last recorded
 * config (stored in the SQLite `embedding_meta` table). When a change is detected and
 * `autoMigrate` is `true`, triggers a full re-embedding run via `migrateEmbeddings`.
 *
 * On first run (no previous meta), the current config is recorded and no migration occurs.
 * On config change with `autoMigrate=true`, the meta is updated only after successful migration,
 * ensuring failed migrations will retry on the next restart.
 *
 * @returns `changed`  — whether provider or model differed from the recorded values.
 *          `migrated` — whether re-embedding was actually performed.
 *          `result`   — migration stats when `migrated` is `true`.
 */
export async function runEmbeddingMaintenance(opts: EmbeddingMaintenanceOptions): Promise<EmbeddingMaintenanceResult> {
  const { factsDb, currentProvider, currentModel, autoMigrate, logger } = opts;
  const log = logger ?? { info: (m: string) => pluginLogger.info(m), warn: (m: string) => pluginLogger.warn(m) };

  let changed = false;
  let previousMeta;

  try {
    previousMeta = factsDb.getEmbeddingMeta();

    if (previousMeta) {
      changed = previousMeta.provider !== currentProvider || previousMeta.model !== currentModel;
    } else {
      // First run — record initial state and return early
      factsDb.setEmbeddingMeta(currentProvider, currentModel);
      return { changed: false, migrated: false };
    }
  } catch (err) {
    log.warn(`memory-hybrid: embedding-migration: failed to read/write embedding metadata (non-fatal): ${err}`);
    // Cannot determine whether change happened — skip migration to be safe
    return { changed: false, migrated: false };
  }

  if (!changed) {
    return { changed: false, migrated: false };
  }

  log.info(`memory-hybrid: embedding config changed — now using provider=${currentProvider}, model=${currentModel}`);

  if (!autoMigrate) {
    log.warn(
      "memory-hybrid: embedding.autoMigrate=false — skipping automatic re-embedding. " +
        "Set embedding.autoMigrate=true in plugin config to automatically re-generate " +
        "embeddings when the model changes, or run the maintenance command manually.",
    );
    factsDb.setEmbeddingMeta(currentProvider, currentModel);
    return { changed: true, migrated: false };
  }

  log.info("memory-hybrid: embedding.autoMigrate=true — starting re-embedding of existing facts...");

  try {
    const result = await migrateEmbeddings(opts);
    // Only update meta after successful migration
    factsDb.setEmbeddingMeta(currentProvider, currentModel);
    return { changed: true, migrated: true, result };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "embeddings",
      operation: "runEmbeddingMaintenance",
    });
    log.warn(`memory-hybrid: embedding-migration: maintenance run failed: ${err}`);
    return { changed: true, migrated: false };
  }
}
