import type { VectorDB } from "../backends/vector-db.js";

export async function deleteVectorsForFactIds(
  vectorDb: Pick<VectorDB, "delete">,
  factIds: readonly string[],
  options: {
    operation: string;
    logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  },
): Promise<{ attempted: number; deleted: number; failed: number }> {
  const uniqueIds = [...new Set(factIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (uniqueIds.length === 0) return { attempted: 0, deleted: 0, failed: 0 };

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
  factsDb: { setEmbeddingModel: (id: string, model: string | null) => void };
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
    options.factsDb.setEmbeddingModel(options.factId, options.embeddingModel);
  }
  return storedId;
}
