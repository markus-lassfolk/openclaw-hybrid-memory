import type { VectorDB } from "../backends/vector-db.js";

export async function deleteVectorsForFactIds(
  vectorDb: Pick<VectorDB, "delete">,
  factIds: readonly string[],
  options: {
    operation: string;
    logger?: { warn?: (msg: string) => void };
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
