/**
 * Memory graph API + explorer page (Issue #788).
 */

import type { DatabaseSync } from "node:sqlite";
import type { GraphConnectedStats } from "../backends/facts-db/links.js";
import type { FactsDB } from "../backends/facts-db.js";
import { expandGraph, type GraphExpansionStats, resolveGraphHubDegreeCap } from "../services/graph-retrieval.js";
import { nowIso } from "../utils/dates.js";

interface MemoryGraphNode {
  id: string;
  label: string;
  category: string;
  importance: number;
  decayClass: string;
  provenance?: unknown;
}

function parseProvenance(raw: string | null): unknown | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface MemoryGraphEdge {
  source: string;
  target: string;
  linkType: string;
  strength: number;
  /**
   * Relationship layer this edge belongs to (#2128). Only "explicit" (memory_links rows) is
   * materialized as graph edges today; semantic/provenance/metadata-derived layers are surfaced
   * separately (memory_health, provenance_json) but not yet promoted into this graph payload.
   * Present on every edge so the dashboard can label/style edges honestly as more layers land.
   */
  layer: "explicit";
}

/** Coverage counters so a sampled subgraph is never mistaken for "the whole graph" (#2126, #2128). */
interface GraphCoverage {
  totalActiveFacts: number;
  totalExplicitLinks: number;
  selectedNodes: number;
  selectedEdges: number;
  /** Nodes in the returned payload with no edge among the returned edges. */
  orphanNodesInView: number;
  /** 1-hop neighbors skipped because a seed node's degree exceeded the hub cap. */
  hubsSkipped: number;
}

interface GraphPayload {
  generatedAt: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  coverage: GraphCoverage;
}

interface GraphRecallPayload extends GraphPayload {
  activated: string[];
  /** Hub-guard observability for recall graph (Issue #1192). */
  graphHubGuard?: {
    configuredCap: number | null | undefined;
    effectiveCap: number | null;
    connected: GraphConnectedStats;
    expansion: GraphExpansionStats;
  };
}

function toGraphNode(entry: {
  id: string;
  text: string;
  category: string;
  importance: number;
  decayClass?: string | null;
  provenanceJson?: string | null;
}): MemoryGraphNode {
  return {
    id: entry.id,
    label: entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text,
    category: entry.category,
    importance: entry.importance,
    decayClass: entry.decayClass ?? "stable",
    provenance: parseProvenance(entry.provenanceJson ?? null),
  };
}

function toGraphEdges(
  edges: Array<{ source: string; target: string; linkType: string; strength: number }>,
): MemoryGraphEdge[] {
  return edges.map((e) => ({
    source: e.source,
    target: e.target,
    linkType: e.linkType,
    strength: e.strength,
    layer: "explicit" as const,
  }));
}

function countOrphansInView(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): number {
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  return nodes.filter((n) => !connected.has(n.id)).length;
}

/** Shared "active fact"/"explicit link" totals for the coverage block (dedupes the identical COUNT
 * queries previously repeated in collectGraphPayload and collectGraphRecallPayload). */
function countGraphCoverageTotals(
  db: DatabaseSync,
  nowSec: number,
): { totalActiveFacts: number; totalExplicitLinks: number } {
  const totalActiveRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .get(nowSec) as { cnt: number };
  const totalLinksRow = db.prepare("SELECT COUNT(*) AS cnt FROM memory_links").get() as { cnt: number };
  return { totalActiveFacts: totalActiveRow.cnt, totalExplicitLinks: totalLinksRow.cnt };
}

/**
 * mode="connected" (default): recent facts plus their direct explicit-link neighbors, so a
 * link-rich corpus reliably shows edges instead of a near-always-empty recency-only sample
 * (#2126 — on an append-heavy store, recently-created facts are rarely linked to each other yet).
 * mode="recent": the original recency-only node sample, for callers that specifically want that.
 */
export function collectGraphPayload(
  factsDb: FactsDB,
  days: number,
  maxNodes: number,
  opts?: { mode?: "connected" | "recent"; hubDegreeCap?: number | null },
): GraphPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * 86400;
  const capped = Math.min(2000, Math.max(20, maxNodes));
  const db = factsDb.getRawDb();
  const mode = opts?.mode === "recent" ? "recent" : "connected";
  // Reserve headroom for neighbor expansion instead of letting the recency query alone fill the
  // entire node budget (#2126) — on any corpus with >= maxNodes recent facts (the common case),
  // an unreserved budget would leave literally zero room for neighbor expansion, since the seed
  // query would already have consumed the whole cap.
  const seedLimit = mode === "connected" ? Math.max(1, Math.ceil(capped * 0.6)) : capped;

  const recentRows = db
    .prepare(
      "SELECT id, text, category, importance, decay_class, provenance_json FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(nowSec, cutoff, seedLimit) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    decay_class: string | null;
    provenance_json: string | null;
  }>;

  const nodes: MemoryGraphNode[] = recentRows.map((r) =>
    toGraphNode({
      id: r.id,
      text: r.text,
      category: r.category,
      importance: r.importance,
      decayClass: r.decay_class,
      provenanceJson: r.provenance_json,
    }),
  );
  let finalIds = recentRows.map((r) => r.id);
  let hubsSkipped = 0;

  if (mode === "connected" && finalIds.length > 0) {
    // Default matches the codebase-wide hub-degree-cap default (services/graph-retrieval.ts
    // DEFAULT_GRAPH_HUB_DEGREE_CAP, config/utils.ts, collectDashboardConnectedIds below) instead
    // of an unrelated, unconfigurable 500-vs-50 divergence from the sibling /api/graph/recall view
    // (#2134 QA follow-up).
    const hubDegreeCap = opts?.hubDegreeCap === undefined ? 500 : opts.hubDegreeCap;
    const stats: GraphConnectedStats = { nodesConsidered: 0, nodesSkipped: 0, hubsSkipped: 0 };
    const connected = factsDb.getConnectedFactIds(finalIds, 1, { hubDegreeCap, stats });
    hubsSkipped = stats.hubsSkipped;
    const seedSet = new Set(finalIds);
    const neighborIds = connected.filter((id) => !seedSet.has(id));
    const budget = Math.max(0, capped - finalIds.length);
    const chosenNeighbors = neighborIds.slice(0, budget);
    if (chosenNeighbors.length > 0) {
      const neighborEntries = factsDb.getByIds(chosenNeighbors);
      // Only ids that actually resolve to a live, non-expired fact are added to `finalIds` — the
      // edge query below is scoped to `finalIds`, so leaving a skipped/expired id in it would
      // produce edges referencing a node id absent from `nodes` (#2134 QA follow-up). Neighbors
      // come from getConnectedFactIds, which filters superseded_at but not expires_at (unlike the
      // seed query above), so an expiry check is also needed here to match the "active fact"
      // definition used everywhere else in this payload.
      const resolvedNeighborIds: string[] = [];
      for (const id of chosenNeighbors) {
        const entry = neighborEntries.get(id);
        if (!entry) continue;
        if (entry.expiresAt != null && entry.expiresAt <= nowSec) continue;
        resolvedNeighborIds.push(id);
        nodes.push(
          toGraphNode({
            id: entry.id,
            text: entry.text,
            category: entry.category,
            importance: entry.importance,
            decayClass: entry.decayClass,
            provenanceJson: entry.provenanceJson,
          }),
        );
      }
      finalIds = [...finalIds, ...resolvedNeighborIds];
    }
  }

  const rawEdges = factsDb.getEdgesForFactIds(finalIds, 2000);
  const edges = toGraphEdges(rawEdges);

  const { totalActiveFacts, totalExplicitLinks } = countGraphCoverageTotals(db, nowSec);

  return {
    generatedAt: nowIso(),
    nodes,
    edges,
    coverage: {
      totalActiveFacts,
      totalExplicitLinks,
      selectedNodes: nodes.length,
      selectedEdges: edges.length,
      orphanNodesInView: countOrphansInView(nodes, edges),
      hubsSkipped,
    },
  };
}

function collectDashboardConnectedIds(
  factsDb: FactsDB,
  seeds: string[],
  maxDepth: number,
  hubDegreeCap: number | null | undefined,
  stats?: GraphConnectedStats,
): string[] {
  if (seeds.length === 0) return [];
  const cap = hubDegreeCap === undefined ? 500 : hubDegreeCap;
  return factsDb.getConnectedFactIds(seeds, maxDepth, { hubDegreeCap: cap, stats });
}

export function collectGraphRecallPayload(
  factsDb: FactsDB,
  query: string,
  hubDegreeCap?: number | null,
): GraphRecallPayload {
  const q = query.trim();
  if (!q) {
    return {
      generatedAt: nowIso(),
      nodes: [],
      edges: [],
      activated: [],
      coverage: {
        totalActiveFacts: 0,
        totalExplicitLinks: 0,
        selectedNodes: 0,
        selectedEdges: 0,
        orphanNodesInView: 0,
        hubsSkipped: 0,
      },
    };
  }
  const results = factsDb.search(q, 12, {
    includeSuperseded: false,
    reinforcementBoost: 0.1,
    diversityWeight: 1,
  });
  const seeds = results.map((r) => r.entry.id);
  const connected: GraphConnectedStats = { nodesConsidered: 0, nodesSkipped: 0, hubsSkipped: 0 };
  const ids = collectDashboardConnectedIds(factsDb, seeds, 3, hubDegreeCap, connected).slice(0, 2000);
  const seedInputs = results.map((r) => ({ factId: r.entry.id, score: r.score, entry: r.entry }));
  const { stats: expansion } = expandGraph(factsDb, seedInputs, {
    maxDepth: 3,
    maxExpandedResults: 20,
    hubDegreeCap,
  });
  const entryMap = factsDb.getByIds(ids);
  const nodes: MemoryGraphNode[] = [];
  // Only ids that actually resolve to a fact are kept for the edge query below — otherwise a
  // skipped id (no entryMap entry) can still produce an edge referencing a node absent from
  // `nodes` (#2134 QA follow-up, same class of bug as collectGraphPayload above).
  const resolvedIds: string[] = [];
  for (const id of ids) {
    const f = entryMap.get(id);
    if (!f) continue;
    nodes.push(toGraphNode(f));
    resolvedIds.push(id);
  }
  const rawEdges = factsDb.getEdgesForFactIds(resolvedIds, 2000);
  const edges = toGraphEdges(rawEdges);
  const db = factsDb.getRawDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const { totalActiveFacts, totalExplicitLinks } = countGraphCoverageTotals(db, nowSec);
  return {
    generatedAt: nowIso(),
    nodes,
    edges,
    activated: seeds,
    coverage: {
      totalActiveFacts,
      totalExplicitLinks,
      selectedNodes: nodes.length,
      selectedEdges: edges.length,
      orphanNodesInView: countOrphansInView(nodes, edges),
      hubsSkipped: connected.hubsSkipped,
    },
    graphHubGuard: {
      configuredCap: hubDegreeCap,
      effectiveCap: resolveGraphHubDegreeCap(hubDegreeCap),
      connected,
      expansion,
    },
  };
}
