import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";

const ORPHAN_RECONCILE_VECTOR_BATCH = 1000;

/**
 * Return LanceDB vector IDs with no corresponding active SQLite fact.
 */
export async function findOrphanVectorIds(
  factsDb: Pick<FactsDB, "filterActiveFactIds">,
  vectorDb: Pick<VectorDB, "getAllIds"> & Partial<Pick<VectorDB, "isLanceDbAvailable">>,
): Promise<string[]> {
  if (typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
    return [];
  }
  if (typeof vectorDb.getAllIds !== "function") {
    return [];
  }
  const vectorIds = await vectorDb.getAllIds();
  if (vectorIds.length === 0) return [];

  const orphans: string[] = [];
  for (let i = 0; i < vectorIds.length; i += ORPHAN_RECONCILE_VECTOR_BATCH) {
    const batch = vectorIds.slice(i, i + ORPHAN_RECONCILE_VECTOR_BATCH);
    const active = factsDb.filterActiveFactIds(batch);
    for (const id of batch) {
      if (!active.has(id.toLowerCase())) orphans.push(id);
    }
  }
  return orphans;
}

/**
 * Delete LanceDB vectors whose fact IDs are not active in SQLite.
 * Uses batched SQLite lookups so the full facts table is not loaded into memory.
 */
export async function reconcileOrphanVectors(
  factsDb: Pick<FactsDB, "filterActiveFactIds">,
  vectorDb: Pick<VectorDB, "getAllIds" | "delete"> & Partial<Pick<VectorDB, "deleteMany" | "isLanceDbAvailable">>,
  options: {
    operation: string;
    logger?: { warn?: (message: string) => void; info?: (message: string) => void };
  },
): Promise<{ orphanVectorsRemoved: number; failed: number; orphansFound: number }> {
  if (typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
    return { orphanVectorsRemoved: 0, failed: 0, orphansFound: 0 };
  }

  const orphans = await findOrphanVectorIds(factsDb, vectorDb);
  if (orphans.length === 0) {
    return { orphanVectorsRemoved: 0, failed: 0, orphansFound: 0 };
  }

  options.logger?.info?.(`memory-hybrid: ${options.operation} — reconciling ${orphans.length} orphaned vector(s)...`);
  const cleanup = await deleteVectorsForFactIds(vectorDb, orphans, options);
  return {
    orphanVectorsRemoved: cleanup.deleted,
    failed: cleanup.failed,
    orphansFound: orphans.length,
  };
}

export async function deleteVectorsForFactIds(
  vectorDb: Pick<VectorDB, "delete"> & Partial<Pick<VectorDB, "deleteMany" | "isLanceDbAvailable">>,
  factIds: readonly string[],
  options: {
    operation: string;
    logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  },
): Promise<{ attempted: number; deleted: number; failed: number }> {
  const uniqueIds = [...new Set(factIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (uniqueIds.length === 0) return { attempted: 0, deleted: 0, failed: 0 };
  if (typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
    return { attempted: 0, deleted: 0, failed: 0 };
  }

  if (typeof vectorDb.deleteMany === "function") {
    try {
      const deleted = await vectorDb.deleteMany(uniqueIds);
      if (deleted === 0 && typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
        return { attempted: 0, deleted: 0, failed: 0 };
      }
      const normalizedDeleted = Number.isFinite(deleted)
        ? Math.max(0, Math.min(uniqueIds.length, Math.floor(deleted)))
        : 0;
      return {
        attempted: uniqueIds.length,
        deleted: normalizedDeleted,
        // Keep failed semantics aligned with the per-id path: only count hard errors.
        failed: 0,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.logger?.warn?.(`memory-hybrid: ${options.operation} vector bulk delete failed: ${error.message}`);
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const id of uniqueIds) {
    try {
      if (await vectorDb.delete(id)) deleted++;
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err : new Error(String(err));
      options.logger?.warn?.(`memory-hybrid: ${options.operation} vector delete failed for ${id}: ${error.message}`);
    }
  }
  return { attempted: uniqueIds.length, deleted, failed };
}

export async function cleanupEvictedVector(options: {
  vectorDb: Pick<VectorDB, "delete">;
  evictedFactId?: string | null;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  context: string;
}): Promise<boolean> {
  const { evictedFactId } = options;
  if (!evictedFactId) return false;
  const deleted = await deleteVectorForFactId({
    vectorDb: options.vectorDb,
    factId: evictedFactId,
    logger: options.logger,
    context: options.context,
  });
  if (deleted) {
    options.logger?.info?.(`memory-hybrid: ${options.context} evicted fact ${evictedFactId}, vector deleted`);
  }
  return deleted;
}

export async function deleteVectorForFactId(options: {
  vectorDb: Pick<VectorDB, "delete">;
  factId: string;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  context: string;
}): Promise<boolean> {
  try {
    return await options.vectorDb.delete(options.factId);
  } catch (err) {
    options.logger?.warn?.(`memory-hybrid: ${options.context} vector delete failed for ${options.factId}: ${err}`);
    return false;
  }
}

export async function storeCanonicalVectorForFact(options: {
  vectorDb: Pick<VectorDB, "store"> & Partial<Pick<VectorDB, "isLanceDbAvailable">>;
  factsDb: {
    setEmbeddingModel: (id: string, model: string | null) => void;
    storeEmbedding: (
      factId: string,
      model: string,
      variant: string,
      embedding: Float32Array,
      dimensions: number,
    ) => void;
  };
  factId: string;
  text: string;
  why?: string | null;
  vector: number[];
  importance: number;
  category: string;
  embeddingModel: string;
}): Promise<string> {
  const storedId = await options.vectorDb.store({
    text: options.text,
    why: options.why,
    vector: options.vector,
    importance: options.importance,
    category: options.category,
    id: options.factId,
  });
  const canPersistEmbeddingModel =
    typeof options.vectorDb.isLanceDbAvailable === "function" ? options.vectorDb.isLanceDbAvailable() : true;
  if (canPersistEmbeddingModel) {
    try {
      options.factsDb.setEmbeddingModel(options.factId, options.embeddingModel);
      options.factsDb.storeEmbedding(
        options.factId,
        options.embeddingModel,
        "canonical",
        new Float32Array(options.vector),
        options.vector.length,
      );
    } catch {
      // LanceDB is already updated. Do not make callers treat vector storage as
      // failed; higher-level callers may run their own canonical SQLite
      // embedding retry after this helper returns successfully.
    }
  }
  return storedId;
}
