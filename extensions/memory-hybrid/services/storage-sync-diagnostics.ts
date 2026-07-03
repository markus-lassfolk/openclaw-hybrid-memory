import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { findOrphanVectorIds } from "./vector-maintenance.js";

export type StorageSyncSnapshot = {
  sqliteActiveFacts: number;
  lanceRowCount: number;
  lanceIdListLength: number;
  lanceUniqueIds: number;
  duplicateIdExtraRows: number;
  canonicalEmbeddings: number;
  vectorOrphans: string[];
  sqliteOrphans: string[];
  hasIdSetDrift: boolean;
  hasRowCountDrift: boolean;
  hasEmbeddingDrift: boolean;
  /** Row-count drift with no ID-set orphans (fragments/duplicate rows). */
  hasStructuralDrift: boolean;
};

export function analyzeStorageSyncFromIds(args: {
  sqliteActiveFacts: number;
  lanceRowCount: number;
  lanceIdList: string[];
  canonicalEmbeddings: number;
  vectorOrphans: string[];
  sqliteOrphans: string[];
}): StorageSyncSnapshot {
  const lanceUniqueIds = new Set(args.lanceIdList).size;
  const duplicateIdExtraRows = Math.max(0, args.lanceIdList.length - lanceUniqueIds);
  const hasIdSetDrift = args.vectorOrphans.length > 0 || args.sqliteOrphans.length > 0;
  const hasRowCountDrift =
    args.lanceRowCount !== args.sqliteActiveFacts ||
    args.lanceIdList.length !== args.sqliteActiveFacts ||
    args.lanceRowCount !== args.canonicalEmbeddings;
  const hasEmbeddingDrift = args.canonicalEmbeddings !== args.lanceRowCount;
  const hasStructuralDrift =
    !hasIdSetDrift &&
    (duplicateIdExtraRows > 0 || args.lanceRowCount > args.sqliteActiveFacts);

  return {
    sqliteActiveFacts: args.sqliteActiveFacts,
    lanceRowCount: args.lanceRowCount,
    lanceIdListLength: args.lanceIdList.length,
    lanceUniqueIds,
    duplicateIdExtraRows,
    canonicalEmbeddings: args.canonicalEmbeddings,
    vectorOrphans: args.vectorOrphans,
    sqliteOrphans: args.sqliteOrphans,
    hasIdSetDrift,
    hasRowCountDrift,
    hasEmbeddingDrift,
    hasStructuralDrift,
  };
}

export async function collectStorageSyncSnapshot(
  factsDb: Pick<FactsDB, "getCount" | "getAllIds" | "filterActiveFactIds" | "countCanonicalEmbeddings">,
  vectorDb: Pick<VectorDB, "count" | "getAllIds"> & Partial<Pick<VectorDB, "isLanceDbAvailable">>,
): Promise<StorageSyncSnapshot | null> {
  if (typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
    return null;
  }

  const sqliteActiveFacts = factsDb.getCount();
  const lanceRowCount = await vectorDb.count();
  const lanceIdList = await vectorDb.getAllIds();
  const vectorIdSet = new Set(lanceIdList);
  const sqliteIds = factsDb.getAllIds();
  const vectorOrphans = await findOrphanVectorIds(factsDb, vectorDb);
  const sqliteOrphans = sqliteIds.filter((id) => !vectorIdSet.has(id));
  const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();

  return analyzeStorageSyncFromIds({
    sqliteActiveFacts,
    lanceRowCount,
    lanceIdList,
    canonicalEmbeddings,
    vectorOrphans,
    sqliteOrphans,
  });
}

export function formatStorageSyncSummary(snapshot: StorageSyncSnapshot): string {
  return (
    `sqliteActiveFacts=${snapshot.sqliteActiveFacts} ` +
    `lanceRows=${snapshot.lanceRowCount} lanceIdsListed=${snapshot.lanceIdListLength} ` +
    `lanceUniqueIds=${snapshot.lanceUniqueIds} canonicalEmbeddings=${snapshot.canonicalEmbeddings}` +
    (snapshot.duplicateIdExtraRows > 0 ? ` duplicateIdExtraRows=${snapshot.duplicateIdExtraRows}` : "")
  );
}

export const STORAGE_REPAIR_REMEDIATION = "openclaw hybrid-mem storage repair";
export const STORAGE_OPTIMIZE_REMEDIATION = "openclaw hybrid-mem storage optimize";
export const STORAGE_REBUILD_ALIASES_REMEDIATION = "openclaw hybrid-mem storage rebuild-aliases";
