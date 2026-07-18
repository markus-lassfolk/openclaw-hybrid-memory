/**
 * Procedure refinery — ranked triage batches over the procedure backlog (Issue #2147).
 * Turns a raw backlog count into a bounded, ranked, deduplicated review batch by
 * combining the existing procedure clustering + risk-scoring building blocks.
 */
import type { DatabaseSync } from "node:sqlite";
import { listProcedures } from "../backends/facts-db/procedures/crud.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { ProcedureEntry } from "../types/memory.js";
import type {
  ProcedureTriageBatchItem,
  ProcedureTriageBatchReport,
  ProcedureTriageOptions,
  ProcedureTriageRecommendedAction,
} from "../types/procedure-triage-types.js";
import { determineRiskLevel, parseRecipeOrRaw } from "../utils/procedure-risk.js";
import { type ClusterableProcedureItem, clusterProcedureItems } from "./procedure-cluster.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Stable cluster id derived from the representative procedure's task-pattern slug — stable across triage runs so triage decisions persist. */
function clusterId(representative: ProcedureEntry): string {
  return `cluster-${slugify(representative.taskPattern) || representative.id.slice(0, 12)}`;
}

function recommendAction(
  representative: ProcedureEntry,
  count: number,
  risk: "low" | "medium" | "high",
): ProcedureTriageRecommendedAction {
  if (representative.promotedToSkill || representative.skillPath) return "no_action";
  if (risk === "high" && (representative.failureCount ?? 0) > 0) return "file_issue";
  if (count >= 3 || (representative.successCount ?? 0) >= 5) return "promote_to_skill";
  if (count >= 2) return "promote_to_wrapper";
  return "no_action";
}

function explain(representative: ProcedureEntry, count: number, risk: string): string {
  const parts: string[] = [];
  if (count > 1) parts.push(`repeated ${count} times`);
  if ((representative.failureCount ?? 0) > 0) parts.push(`${representative.failureCount} recorded failure(s)`);
  if (risk !== "low") parts.push(`${risk} risk surface`);
  if ((representative.successCount ?? 0) >= 5) parts.push(`${representative.successCount} successful uses`);
  return parts.join("; ") || "occasional, low-signal procedure";
}

export interface ProcedureTriageDeps {
  db: DatabaseSync;
  loomStore: LoomStore;
}

export function rankProcedureCandidates(
  deps: ProcedureTriageDeps,
  opts: ProcedureTriageOptions = {},
): ProcedureTriageBatchReport {
  const { db, loomStore } = deps;
  const all = listProcedures(db, 1000);
  const backlog = all.filter((p) => !p.promotedToSkill);

  const items: ClusterableProcedureItem[] = backlog.map((p) => ({
    procedure: { id: p.id, taskPattern: p.taskPattern, successCount: p.successCount, confidence: p.confidence },
    payload: { skillSlug: slugify(p.taskPattern) || p.id },
  }));
  const clusters =
    opts.cluster === false
      ? items.map((i) => ({ representative: i, relatedProcedureIds: [], threshold: 1 }))
      : clusterProcedureItems(items, 0.6);

  const byId = new Map(backlog.map((p) => [p.id, p]));
  const batch: ProcedureTriageBatchItem[] = [];
  for (const cluster of clusters) {
    const representative = byId.get(cluster.representative.procedure.id);
    if (!representative) continue;
    const risk = determineRiskLevel(representative, parseRecipeOrRaw(representative.recipeJson));
    const count = cluster.relatedProcedureIds.length + 1;
    const id = clusterId(representative);
    const priorDecision = loomStore.getProcedureTriageDecision(id);
    if (priorDecision && priorDecision.decision === "no_action") continue;

    batch.push({
      clusterId: id,
      representativeProcedureId: representative.id,
      taskPattern: representative.taskPattern,
      count,
      successCount: representative.successCount,
      confidence: representative.confidence,
      risk,
      why: explain(representative, count, risk),
      recommendedAction: priorDecision?.decision ?? recommendAction(representative, count, risk),
      existingWrapper: representative.skillPath ?? null,
      relatedProcedureIds: cluster.relatedProcedureIds,
    });
  }

  batch.sort((a, b) => {
    const weight = (x: ProcedureTriageBatchItem) => (x.risk === "high" ? 3 : x.risk === "medium" ? 2 : 1) + x.count;
    return weight(b) - weight(a);
  });

  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 20;
  return { backlog: backlog.length, recommendedBatch: batch.slice(0, batchSize) };
}
