import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { isClassificationArtifactForStorage } from "./capture-utils.js";
import { deleteVectorsForFactIds } from "./vector-maintenance.js";

export interface ClassificationArtifactCleanupResult {
  scanned: number;
  matched: number;
  superseded: number;
  vectorAttempted: number;
  vectorDeleted: number;
  vectorFailed: number;
  dryRun: boolean;
  matchedIds: string[];
}

export async function cleanupClassificationArtifacts(
  factsDb: Pick<FactsDB, "getAll" | "supersede">,
  vectorDb: Pick<VectorDB, "delete"> & Partial<Pick<VectorDB, "deleteMany" | "isLanceDbAvailable">>,
  opts: { dryRun?: boolean; logger?: { warn?: (message: string) => void; info?: (message: string) => void } } = {},
): Promise<ClassificationArtifactCleanupResult> {
  const dryRun = opts.dryRun === true;
  const facts = factsDb.getAll({ includeSuperseded: true }) as MemoryEntry[];
  const matches = facts.filter((fact) => fact.supersededAt == null && isClassificationArtifactForStorage(fact.text));
  const matchedIds = matches.map((fact) => fact.id);

  let superseded = 0;
  let vectorAttempted = 0;
  let vectorDeleted = 0;
  let vectorFailed = 0;

  if (!dryRun && matchedIds.length > 0) {
    const supersededIds: string[] = [];
    for (const id of matchedIds) {
      if (factsDb.supersede(id, null)) {
        superseded += 1;
        supersededIds.push(id);
      }
    }
    const vectorCleanup = await deleteVectorsForFactIds(vectorDb, supersededIds, {
      operation: "classification-artifacts-cleanup",
      logger: opts.logger,
    });
    vectorAttempted = vectorCleanup.attempted;
    vectorDeleted = vectorCleanup.deleted;
    vectorFailed = vectorCleanup.failed;
  }

  return {
    scanned: facts.length,
    matched: matches.length,
    superseded,
    vectorAttempted,
    vectorDeleted,
    vectorFailed,
    dryRun,
    matchedIds,
  };
}
