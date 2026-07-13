import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { nowIso } from "../utils/dates.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { appendVectorLifecycleAuditEvent } from "./vector-lifecycle-audit.js";
import { reconcileOrphanVectors, storeCanonicalVectorForFact } from "./vector-maintenance.js";

export type StorageRepairPolicy = "conservative" | "balanced" | "aggressive";

export type StorageRepairReport = {
  policy: StorageRepairPolicy;
  maxFixes: number;
  startedAt: string;
  vectorlessBefore: number;
  reembedded: number;
  optimize: { compacted: number; removedFragments: number; freedBytes: number; timedOut?: boolean };
  reconcile: {
    vectorOrphans: number;
    vectorOrphansDeleted: number;
    sqliteOrphans: number;
    sqliteOrphansRebuilt: number;
    sqliteOrphansSkipped: number;
  };
  /**
   * Duplicate live Lance rows for a still-active fact id (structural drift). VectorDB.store()'s
   * EEXIST-recovery path only fires on an actual LanceDB write error, but LanceDB never rejects a
   * second add() for a pre-existing id — it silently appends a second live row instead. The vector-
   * orphan reconcile above only removes rows for ids with no matching active fact, so a duplicate
   * for a still-valid id survives untouched without this pass.
   */
  dedupe: { duplicateIds: number; deduplicated: number };
  vectorlessAfter: number;
  errors: string[];
};

export function resolveStorageRepairBudget(policy: StorageRepairPolicy, maxFixes: number): number {
  if (policy === "conservative") return 0;
  if (policy === "balanced") return maxFixes;
  return Math.max(maxFixes, 2000);
}

export async function runStorageRepairPipeline(args: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  policy?: StorageRepairPolicy;
  maxFixes?: number;
  operation?: string;
  resolvedSqlitePath?: string;
  skipReembed?: boolean;
}): Promise<StorageRepairReport> {
  const policy = args.policy ?? "balanced";
  const maxFixes = args.maxFixes ?? 200;
  const operation = args.operation ?? "storage-repair";
  const report: StorageRepairReport = {
    policy,
    maxFixes,
    startedAt: nowIso(),
    vectorlessBefore: args.factsDb.countVectorlessActiveFacts(),
    reembedded: 0,
    optimize: { compacted: 0, removedFragments: 0, freedBytes: 0 },
    reconcile: {
      vectorOrphans: 0,
      vectorOrphansDeleted: 0,
      sqliteOrphans: 0,
      sqliteOrphansRebuilt: 0,
      sqliteOrphansSkipped: 0,
    },
    dedupe: { duplicateIds: 0, deduplicated: 0 },
    vectorlessAfter: 0,
    errors: [],
  };

  if (!args.skipReembed) {
    const candidates = args.factsDb.listVectorlessActiveFacts({ limit: Math.max(200, maxFixes) });
    const allowedRebuilds = resolveStorageRepairBudget(policy, maxFixes);
    for (const fact of candidates.slice(0, allowedRebuilds)) {
      try {
        const vec = await args.embeddings.embed(fact.text);
        await storeCanonicalVectorForFact({
          vectorDb: args.vectorDb,
          factsDb: args.factsDb,
          factId: fact.id,
          text: fact.text,
          vector: vec,
          importance: fact.importance ?? 0.5,
          category: fact.category,
          embeddingModel: args.embeddings.modelName,
        });
        report.reembedded++;
      } catch (err) {
        report.errors.push(`reembed ${fact.id}: ${String(err)}`);
      }
    }
  }

  try {
    report.optimize = await args.vectorDb.optimize();
  } catch (err) {
    report.errors.push(`optimize: ${String(err)}`);
  }

  try {
    const vectorIds = await args.vectorDb.getAllIds();
    const vectorIdSet = new Set(vectorIds);
    const reconcileResult = await reconcileOrphanVectors(args.factsDb, args.vectorDb, {
      operation: `${operation}-reconcile`,
    });
    report.reconcile.vectorOrphans = reconcileResult.orphansFound;
    report.reconcile.vectorOrphansDeleted = reconcileResult.orphanVectorsRemoved;
    // listExpectedVectorFactIds() (not getAllIds()) — same expected-vector population contract
    // storage-sync-diagnostics.ts uses (#2080), so structured (key/value) facts, which are never
    // meant to have a vector, aren't misclassified as orphans here and repaired unnecessarily.
    const sqliteIds = new Set(args.factsDb.listExpectedVectorFactIds());
    const sqliteOrphans = Array.from(sqliteIds).filter((id) => !vectorIdSet.has(id));
    report.reconcile.sqliteOrphans = sqliteOrphans.length;

    const rebuildLimit = Math.min(resolveStorageRepairBudget(policy, maxFixes), sqliteOrphans.length);
    for (const id of sqliteOrphans.slice(0, rebuildLimit)) {
      try {
        const fact = args.factsDb.getById(id);
        if (!fact) {
          report.reconcile.sqliteOrphansSkipped++;
          continue;
        }
        const vec = await args.embeddings.embed(fact.text);
        await storeCanonicalVectorForFact({
          vectorDb: args.vectorDb,
          factsDb: args.factsDb,
          factId: fact.id,
          text: fact.text,
          vector: vec,
          importance: fact.importance ?? 0.5,
          category: fact.category,
          embeddingModel: args.embeddings.modelName,
        });
        report.reconcile.sqliteOrphansRebuilt++;
      } catch (err) {
        report.errors.push(`rebuild sqlite orphan ${id}: ${String(err)}`);
      }
    }
    report.reconcile.sqliteOrphansSkipped += Math.max(0, sqliteOrphans.length - rebuildLimit);

    // Duplicate live rows for an id that still has a matching active fact — see the `dedupe`
    // field doc comment above for why the store()-level EEXIST recovery never catches these.
    // Computed from the pre-reconcile `vectorIds` snapshot; ids with no active fact are excluded
    // below (skip, don't count) since the vector-orphan delete above already cleared every row
    // sharing that id, so there's nothing left here to deduplicate.
    const idCounts = new Map<string, number>();
    for (const id of vectorIds) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    const duplicateIds = Array.from(idCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    report.dedupe.duplicateIds = duplicateIds.length;

    const dedupeLimit = Math.min(resolveStorageRepairBudget(policy, maxFixes), duplicateIds.length);
    for (const id of duplicateIds.slice(0, dedupeLimit)) {
      try {
        const fact = args.factsDb.getById(id);
        if (!fact) continue;
        await args.vectorDb.delete(id); // predicate delete removes every row sharing this id
        const vec = await args.embeddings.embed(fact.text);
        await storeCanonicalVectorForFact({
          vectorDb: args.vectorDb,
          factsDb: args.factsDb,
          factId: fact.id,
          text: fact.text,
          vector: vec,
          importance: fact.importance ?? 0.5,
          category: fact.category,
          embeddingModel: args.embeddings.modelName,
        });
        report.dedupe.deduplicated++;
      } catch (err) {
        report.errors.push(`dedupe ${id}: ${String(err)}`);
      }
    }
  } catch (err) {
    report.errors.push(`reconcile: ${String(err)}`);
  }

  report.vectorlessAfter = args.factsDb.countVectorlessActiveFacts();

  if (args.resolvedSqlitePath) {
    appendVectorLifecycleAuditEvent(args.resolvedSqlitePath, {
      event: "repair_vectors_completed",
      ts: nowIso(),
      details: report as unknown as Record<string, unknown>,
    });
  }

  return report;
}

export async function runStorageStructuralRepair(args: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  resolvedSqlitePath?: string;
  policy?: StorageRepairPolicy;
  maxFixes?: number;
}): Promise<{ optimize: StorageRepairReport["optimize"]; repair: StorageRepairReport | null; errors: string[] }> {
  const errors: string[] = [];
  let optimize: StorageRepairReport["optimize"] = { compacted: 0, removedFragments: 0, freedBytes: 0 };
  try {
    optimize = await args.vectorDb.optimize();
  } catch (err) {
    errors.push(`optimize: ${String(err)}`);
  }

  const repair = await runStorageRepairPipeline({
    factsDb: args.factsDb,
    vectorDb: args.vectorDb,
    embeddings: args.embeddings,
    policy: args.policy ?? "balanced",
    maxFixes: args.maxFixes ?? 200,
    operation: "verify-structural-repair",
    resolvedSqlitePath: args.resolvedSqlitePath,
    skipReembed: true,
  });

  return { optimize, repair, errors: [...errors, ...repair.errors] };
}
