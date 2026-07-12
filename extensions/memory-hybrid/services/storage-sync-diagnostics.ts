import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { normalizeVectorId } from "../utils/vector-id.js";
import { findOrphanVectorIds } from "./vector-maintenance.js";

export type StorageSyncSnapshot = {
  /** All active facts (structured + unstructured) — informational, not directly comparable to Lance. */
  sqliteActiveFacts: number;
  /**
   * Active, unstructured facts — the population that is expected to carry a canonical vector
   * (#2080). Structured key/value facts are intentionally excluded; a structured fact without a
   * Lance row is not drift.
   */
  expectedVectorFacts: number;
  lanceRowCount: number;
  lanceIdListLength: number;
  lanceUniqueIds: number;
  duplicateIdExtraRows: number;
  /**
   * SQLite embedding-cache (fact_embeddings) row count — cache coverage, not vector-store
   * integrity (#2084). A shadow-table re-index does not backfill this per-fact, so it can
   * legitimately lag well behind lanceUniqueIds on a healthy store. Informational only; never
   * gates hasIdSetDrift/hasStructuralDrift.
   */
  canonicalEmbeddings: number;
  /** Lance rows with no corresponding active SQLite fact at all — always a genuine problem. */
  vectorOrphans: string[];
  /** Expected-vector facts with no corresponding Lance row — always a genuine problem. */
  sqliteOrphans: string[];
  /** vectorOrphans.length > 0 || sqliteOrphans.length > 0 — the primary actionable drift signal. */
  hasIdSetDrift: boolean;
  /**
   * @deprecated Alias for `hasIdSetDrift || hasStructuralDrift`, kept for existing callers.
   * The original raw sqliteActiveFacts/lanceRowCount/canonicalEmbeddings comparison it used to
   * compute conflated populations that are not comparable (#2080) — do not reintroduce that.
   */
  hasRowCountDrift: boolean;
  /**
   * Informational cache-coverage gap (canonicalEmbeddings vs lanceUniqueIds). Per #2084,
   * fact_embeddings is a best-effort cache — this is never treated as drift/corruption.
   */
  hasEmbeddingDrift: boolean;
  /** Row-count drift with no ID-set orphans (fragments/duplicate rows). */
  hasStructuralDrift: boolean;
};

export function analyzeStorageSyncFromIds(args: {
  sqliteActiveFacts: number;
  expectedVectorFacts: number;
  lanceRowCount: number;
  lanceIdList: string[];
  canonicalEmbeddings: number;
  vectorOrphans: string[];
  sqliteOrphans: string[];
}): StorageSyncSnapshot {
  const lanceUniqueIds = new Set(args.lanceIdList).size;
  const duplicateIdExtraRows = Math.max(0, args.lanceIdList.length - lanceUniqueIds);
  const hasIdSetDrift = args.vectorOrphans.length > 0 || args.sqliteOrphans.length > 0;
  const hasStructuralDrift = !hasIdSetDrift && (duplicateIdExtraRows > 0 || args.lanceRowCount > lanceUniqueIds);
  const hasRowCountDrift = hasIdSetDrift || hasStructuralDrift;
  const hasEmbeddingDrift = args.canonicalEmbeddings !== lanceUniqueIds;

  return {
    sqliteActiveFacts: args.sqliteActiveFacts,
    expectedVectorFacts: args.expectedVectorFacts,
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
  factsDb: Pick<
    FactsDB,
    | "getCount"
    | "getAllIds"
    | "filterActiveFactIds"
    | "countCanonicalEmbeddings"
    | "countExpectedVectorFacts"
    | "listExpectedVectorFactIds"
  >,
  vectorDb: Pick<VectorDB, "count" | "getAllIds"> & Partial<Pick<VectorDB, "isLanceDbAvailable">>,
): Promise<StorageSyncSnapshot | null> {
  if (typeof vectorDb.isLanceDbAvailable === "function" && !vectorDb.isLanceDbAvailable()) {
    return null;
  }

  const sqliteActiveFacts = factsDb.getCount();
  const expectedVectorFacts = factsDb.countExpectedVectorFacts();
  const lanceRowCount = await vectorDb.count();
  const lanceIdList = await vectorDb.getAllIds();
  const lanceIdSet = new Set(lanceIdList.map((id) => normalizeVectorId(id)));
  const vectorOrphans = await findOrphanVectorIds(factsDb, vectorDb);
  const sqliteOrphans = factsDb.listExpectedVectorFactIds().filter((id) => !lanceIdSet.has(normalizeVectorId(id)));
  const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();

  return analyzeStorageSyncFromIds({
    sqliteActiveFacts,
    expectedVectorFacts,
    lanceRowCount,
    lanceIdList,
    canonicalEmbeddings,
    vectorOrphans,
    sqliteOrphans,
  });
}

export function formatStorageSyncSummary(snapshot: StorageSyncSnapshot): string {
  return (
    `sqliteActiveFacts=${snapshot.sqliteActiveFacts} expectedVectorFacts=${snapshot.expectedVectorFacts} ` +
    `lanceRows=${snapshot.lanceRowCount} lanceIdsListed=${snapshot.lanceIdListLength} ` +
    `lanceUniqueIds=${snapshot.lanceUniqueIds} canonicalEmbeddings=${snapshot.canonicalEmbeddings} (cache coverage, informational)` +
    (snapshot.duplicateIdExtraRows > 0 ? ` duplicateIdExtraRows=${snapshot.duplicateIdExtraRows}` : "")
  );
}

export const STORAGE_REPAIR_REMEDIATION = "openclaw hybrid-mem storage repair";
export const STORAGE_OPTIMIZE_REMEDIATION = "openclaw hybrid-mem storage optimize";
export const STORAGE_REBUILD_ALIASES_REMEDIATION = "openclaw hybrid-mem storage rebuild-aliases";
