/**
 * Embedding migration service: re-generate embeddings when the model or provider changes.
 * Handles LanceDB table swap when vector dimensions differ between old and new model.
 *
 * Issue #153: Migration tooling for switching embedding models.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "./embeddings.js";
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
   * Progress callback fired after each batch.
   * @param completed  Facts processed so far (embedded or skipped).
   * @param total      Total facts in SQLite.
   */
  onProgress?: (completed: number, total: number) => void;
  /** Logger for structured output. Falls back to console when not provided. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface MigrateEmbeddingsResult {
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

export interface EmbeddingMaintenanceResult {
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
export async function migrateEmbeddings(
  opts: MigrateEmbeddingsOptions,
): Promise<MigrateEmbeddingsResult> {
  const { factsDb, vectorDb, embeddings, batchSize = 50, onProgress, logger } = opts;

  const log = logger ?? { info: console.info, warn: console.warn };

  const facts = factsDb.getAll({ includeSuperseded: false });
  const total = facts.length;
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  log.info(
    `memory-hybrid: embedding-migration: starting — ${total} facts, ` +
      `model=${embeddings.modelName}, batchSize=${batchSize}`,
  );

  const initialGeneration = vectorDb.getCloseGeneration();

  for (let i = 0; i < facts.length; i += batchSize) {
    // Abort if the VectorDB was closed (hot-reload or shutdown)
    if (vectorDb.getCloseGeneration() !== initialGeneration) {
      log.warn(
        `memory-hybrid: embedding-migration: aborted at ${migrated + skipped}/${total} — VectorDB closed during migration`,
      );
      break;
    }

    const batch = facts.slice(i, i + batchSize);
    const texts = batch.map((f) => f.text);

    // Attempt batch embed first; fall back to per-fact embeds on failure
    let vectors: (number[] | null)[];
    try {
      const batchResult = await embeddings.embedBatch(texts);
      vectors = batchResult;
    } catch (batchErr) {
      capturePluginError(batchErr instanceof Error ? batchErr : new Error(String(batchErr)), {
        subsystem: "embeddings",
        operation: "migration-embed-batch",
      });
      log.warn(
        `memory-hybrid: embedding-migration: batch embed failed at offset ${i} — falling back to per-fact embeds: ${batchErr}`,
      );
      vectors = await Promise.all(
        batch.map(async (fact) => {
          try {
            return await embeddings.embed(fact.text);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "embeddings",
              operation: "migration-embed-single",
            });
            errors.push(`fact ${fact.id}: embed failed — ${String(err)}`);
            return null;
          }
        }),
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const fact = batch[j];
      const vec = vectors[j];

      if (vec === null || !vec || vec.length === 0) {
        skipped++;
        continue;
      }

      try {
        // Remove stale entry so dimension-changed stores succeed
        try {
          await vectorDb.delete(fact.id);
        } catch {
          // Entry may not exist — expected on first migration
        }

        const isDuplicate = await vectorDb.hasDuplicate(vec);
        if (!isDuplicate) {
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

    const processed = Math.min(i + batchSize, total);
    onProgress?.(processed, total);

    // Periodic progress log for large datasets
    if (total >= 100 && processed % 100 === 0) {
      log.info(
        `memory-hybrid: embedding-migration: ${processed}/${total} processed ` +
          `(${migrated} migrated, ${errors.length} errors)`,
      );
    }
  }

  log.info(
    `memory-hybrid: embedding-migration: complete — ` +
      `${migrated} migrated, ${skipped} skipped, ${errors.length} errors (total ${total})`,
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
 * On config change the meta record is always updated to reflect the new provider/model
 * (regardless of `autoMigrate`), so subsequent runs don't re-detect the same change.
 *
 * @returns `changed`  — whether provider or model differed from the recorded values.
 *          `migrated` — whether re-embedding was actually performed.
 *          `result`   — migration stats when `migrated` is `true`.
 */
export async function runEmbeddingMaintenance(
  opts: EmbeddingMaintenanceOptions,
): Promise<EmbeddingMaintenanceResult> {
  const { factsDb, currentProvider, currentModel, autoMigrate, logger } = opts;
  const log = logger ?? { info: console.info, warn: console.warn };

  let changed = false;

  try {
    const previousMeta = factsDb.getEmbeddingMeta();

    if (previousMeta) {
      changed =
        previousMeta.provider !== currentProvider ||
        previousMeta.model !== currentModel;
    }

    // Persist current config — first run records initial state; subsequent changes overwrite.
    if (!previousMeta || changed) {
      factsDb.setEmbeddingMeta(currentProvider, currentModel);
    }
  } catch (err) {
    log.warn(
      `memory-hybrid: embedding-migration: failed to read/write embedding metadata (non-fatal): ${err}`,
    );
    // Cannot determine whether change happened — skip migration to be safe
    return { changed: false, migrated: false };
  }

  if (!changed) {
    return { changed: false, migrated: false };
  }

  log.info(
    `memory-hybrid: embedding config changed — ` +
      `now using provider=${currentProvider}, model=${currentModel}`,
  );

  if (!autoMigrate) {
    log.warn(
      `memory-hybrid: embedding.autoMigrate=false — skipping automatic re-embedding. ` +
        `Set embedding.autoMigrate=true in plugin config to automatically re-generate ` +
        `embeddings when the model changes, or run the maintenance command manually.`,
    );
    return { changed: true, migrated: false };
  }

  log.info(
    `memory-hybrid: embedding.autoMigrate=true — starting re-embedding of existing facts...`,
  );

  try {
    const result = await migrateEmbeddings(opts);
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
