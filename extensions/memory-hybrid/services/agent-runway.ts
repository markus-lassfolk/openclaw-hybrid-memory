/**
 * Agent Runway API — compact preflight context (Issue #2145), front door to the Loom.
 * Composes active tasks, goals, fragile surfaces, and a Loom summary (beliefs, live
 * checks, open loops, drift, attention) into one bounded, deterministic bundle.
 */
import type { DatabaseSync } from "node:sqlite";
import { getContradictions, isFactVerified } from "../backends/facts-db/contradictions.js";
import { listProcedures } from "../backends/facts-db/procedures/crud.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type {
  RunwayActiveTaskSummary,
  RunwayBundle,
  RunwayFragileSurface,
  RunwayGoalSummary,
  RunwayLoomSummary,
  RunwayOptions,
} from "../types/runway-types.js";
import { determineRiskLevel, parseRecipeOrRaw } from "../utils/procedure-risk.js";
import { rankAttention } from "./attention-steward.js";
import { listActiveGoals } from "./goal-registry.js";

export interface AgentRunwayDeps {
  factsDb: FactsDB;
  loomStore: LoomStore | null;
  serendipityStore?: SerendipityStore | null;
  goalsDir?: string;
}

interface ProjectRow {
  entity: string;
  key: string;
  value: string;
  created_at: number;
}

function readActiveTaskSummaries(db: DatabaseSync, maxItems: number): RunwayActiveTaskSummary[] {
  const rows = db
    .prepare(
      `SELECT entity, key, value, created_at FROM facts
       WHERE category = 'project' AND superseded_at IS NULL AND entity IS NOT NULL
       ORDER BY entity, created_at DESC`,
    )
    .all() as unknown as ProjectRow[];

  const byEntity = new Map<string, Map<string, string>>();
  const latestAt = new Map<string, number>();
  for (const row of rows) {
    const values = byEntity.get(row.entity) ?? new Map<string, string>();
    if (!values.has(row.key)) values.set(row.key, row.value);
    byEntity.set(row.entity, values);
    if (!latestAt.has(row.entity)) latestAt.set(row.entity, row.created_at);
  }

  const entries = Array.from(byEntity.entries())
    .sort((a, b) => (latestAt.get(b[0]) ?? 0) - (latestAt.get(a[0]) ?? 0))
    .slice(0, maxItems);

  return entries.map(([entity, values]) => ({
    label: entity,
    status: values.get("status") ?? "unknown",
    next: values.get("next") ?? null,
    updated: values.get("task_updated") ?? new Date((latestAt.get(entity) ?? 0) * 1000).toISOString(),
    relatedGoal: values.get("related_goal") ?? null,
    source: "facts_ledger",
  }));
}

function readFragileSurfaces(db: DatabaseSync, maxItems: number): RunwayFragileSurface[] {
  const procedures = listProcedures(db, 300);
  const fragile = procedures
    .filter((p) => (p.failureCount ?? 0) > 0)
    .map((p) => ({ proc: p, risk: determineRiskLevel(p, parseRecipeOrRaw(p.recipeJson)) }))
    .filter((x) => x.risk !== "low")
    .sort((a, b) => (b.proc.failureCount ?? 0) - (a.proc.failureCount ?? 0))
    .slice(0, maxItems);
  return fragile.map((x) => ({
    name: x.proc.taskPattern.slice(0, 80),
    risk: `${x.risk} risk — ${x.proc.failureCount} recorded failure(s)`,
    recommendedProcedureId: x.proc.id,
  }));
}

function buildLoomSummary(
  loomStore: LoomStore | null,
  serendipityStore: SerendipityStore | null | undefined,
  maxItems: number,
  scope?: string,
): RunwayLoomSummary {
  if (!loomStore) {
    return {
      topClaims: [],
      mustLiveCheck: [],
      openLoops: [],
      driftWarnings: [],
      recommendedProcedures: [],
      attentionTop: [],
    };
  }
  const claims = loomStore.listClaims({ limit: 200 }).filter((c) => c.status !== "superseded");
  const topClaims = claims
    .filter((c) => c.status === "verified" || c.status === "contradicted")
    .slice(0, maxItems)
    .map((c) => ({ id: c.id, entity: c.entity, predicate: c.predicate, value: c.value, status: c.status }));

  const mustLiveCheck = loomStore
    .listUnsatisfiedLiveChecks()
    .slice(0, maxItems)
    .map((c) => ({
      claimId: c.id,
      text: `${c.entity} ${c.predicate}${c.liveCheckReason ? ` — ${c.liveCheckReason}` : ""}`,
    }));

  const openLoops = loomStore
    .listOpenLoops({ status: ["open", "waiting", "blocked", "ready"], limit: maxItems })
    .map((l) => ({ id: l.id, title: l.title, status: l.status }));

  const driftWarnings = loomStore
    .listDriftFindings({ status: ["open", "acknowledged"], limit: maxItems })
    .map((f) => ({ id: f.id, oldText: f.oldText.slice(0, 100), severity: f.severity }));

  const attentionTop = rankAttention({ loomStore, serendipityStore }, { limit: maxItems, scope }).items.map((i) => ({
    targetKind: i.targetKind,
    targetId: i.targetId,
    title: i.title,
    category: i.category,
  }));

  return { topClaims, mustLiveCheck, openLoops, driftWarnings, recommendedProcedures: [], attentionTop };
}

export async function buildRunway(
  deps: AgentRunwayDeps,
  opts: RunwayOptions & { maxItemsPerSection: number },
): Promise<RunwayBundle> {
  const { factsDb, loomStore, serendipityStore, goalsDir } = deps;
  const db = factsDb.getRawDb();
  const maxItems = opts.maxItemsPerSection;

  const activeTasks = readActiveTaskSummaries(db, maxItems);

  let goals: RunwayGoalSummary[] = [];
  if (goalsDir) {
    try {
      const active = await listActiveGoals(goalsDir);
      goals = active.slice(0, maxItems).map((g) => ({
        id: g.id,
        label: g.label,
        status: g.status,
        priority: g.priority,
        currentBlockers: g.currentBlockers,
      }));
    } catch {
      goals = [];
    }
  }

  const fragileSurfaces = readFragileSurfaces(db, maxItems);

  const contradictedIds = new Set(
    getContradictions(db, undefined, 200)
      .filter((c) => !c.resolved)
      .flatMap((c) => [c.factIdOld, c.factIdNew]),
  );
  const warnings: string[] = ["Memory is context, not proof; verify live state before acting."];
  if (contradictedIds.size > 0) {
    warnings.push(`${contradictedIds.size} fact(s) have unresolved contradictions.`);
  }
  const highImportanceFacts = factsDb.getAll({ includeSuperseded: false }).filter((f) => (f.importance ?? 0) >= 0.8);
  const staleHighImportance = highImportanceFacts.filter((f) => !isFactVerified(db, f.id) && contradictedIds.has(f.id));
  if (staleHighImportance.length > 0) {
    warnings.push(`${staleHighImportance.length} high-importance fact(s) are stale/contradicted and unverified.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    agent: opts.agent ?? null,
    activeTasks,
    goals,
    recentIncidents: [],
    corrections: [],
    fragileSurfaces,
    warnings,
    loom: buildLoomSummary(loomStore, serendipityStore, maxItems, opts.scope),
  };
}
