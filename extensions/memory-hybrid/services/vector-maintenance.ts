import type { VectorDB } from "../backends/vector-db.js";

export async function deleteVectorsForFactIds(
  vectorDb: Pick<VectorDB, "delete">,
  factIds: readonly string[],
  options: {
    operation: string;
    logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  },
): Promise<{ attempted: number; deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const id of factIds) {
    try {
      if (await vectorDb.delete(id)) deleted++;
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err : new Error(String(err));
      options.logger?.warn?.(`memory-hybrid: ${options.operation} vector delete failed for ${id}: ${error.message}`);
    }
  }
  return { attempted: factIds.length, deleted, failed };
}

export async function cleanupEvictedVector(options: {
  vectorDb: Pick<VectorDB, "delete">;
  evictedFactId?: string | null;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void; debug?: (message: string) => void };
  context: string;
}): Promise<boolean> {
  const { evictedFactId } = options;
  if (!evictedFactId) return false;
  try {
    const deleted = await options.vectorDb.delete(evictedFactId);
    if (deleted) {
      options.logger?.info?.(`memory-hybrid: ${options.context} evicted fact ${evictedFactId}, vector deleted`);
    }
    return deleted;
  } catch (err) {
    options.logger?.warn?.(`memory-hybrid: failed to delete vector for evicted fact ${evictedFactId}: ${err}`);
    return false;
  }
}
