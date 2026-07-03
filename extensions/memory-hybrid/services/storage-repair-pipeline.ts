import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { nowIso } from "../utils/dates.js";
import { appendVectorLifecycleAuditEvent } from "./vector-lifecycle-audit.js";
import { reconcileOrphanVectors } from "./vector-maintenance.js";

export type StorageRepairPolicy = "conservative" | "balanced" | "aggressive";

export type StorageRepairReport = {
  policy: StorageRepairPolicy;
  maxFixes: number;
  startedAt: string;
  vectorlessBefore: number;
  reembedded: number;
  optimize: { compacted: number; removedFragments: number; freedBytes: number };
  reconcile: {
    vectorOrphans: number;
    vectorOrphansDeleted: number;
    sqliteOrphans: number;
    sqliteOrphansRebuilt: number;
    sqliteOrphansSkipped: number;
  };
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
    vectorlessAfter: 0,
    errors: [],
  };

  if (!args.skipReembed) {
    const candidates = args.factsDb.listVectorlessActiveFacts({ limit: Math.max(200, maxFixes) });
    const allowedRebuilds = resolveStorageRepairBudget(policy, maxFixes);
    for (const fact of candidates.slice(0, allowedRebuilds)) {
      try {
        const vec = await args.embeddings.embed(fact.text);
        await args.vectorDb.store({
          id: fact.id,
          text: fact.text,
          vector: vec,
          importance: 0.5,
          category: fact.category,
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
    const sqliteIds = new Set(args.factsDb.getAllIds());
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
        await args.vectorDb.store({
          id: fact.id,
          text: fact.text,
          vector: vec,
          importance: fact.importance ?? 0.5,
          category: fact.category,
        });
        report.reconcile.sqliteOrphansRebuilt++;
      } catch (err) {
        report.errors.push(`rebuild sqlite orphan ${id}: ${String(err)}`);
      }
    }
    report.reconcile.sqliteOrphansSkipped += Math.max(0, sqliteOrphans.length - rebuildLimit);
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
