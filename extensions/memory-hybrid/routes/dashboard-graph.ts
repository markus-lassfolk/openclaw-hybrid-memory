/**
 * Memory graph API + explorer page (Issue #788).
 */

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
}

interface GraphPayload {
  generatedAt: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
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

export function collectGraphPayload(factsDb: FactsDB, days: number, maxNodes: number): GraphPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * 86400;
  const capped = Math.min(2000, Math.max(20, maxNodes));
  const db = factsDb.getRawDb();
  const rows = db
    .prepare(
      "SELECT id, text, category, importance, decay_class, provenance_json FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(nowSec, cutoff, capped) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    decay_class: string | null;
    provenance_json: string | null;
  }>;
  const idSet = new Set(rows.map((r) => r.id));
  const allEdges = factsDb.getAllEdges(12000);
  const edges = allEdges.filter((e) => idSet.has(e.source) && idSet.has(e.target)).slice(0, 2000);
  const nodes: MemoryGraphNode[] = rows.map((r) => ({
    id: r.id,
    label: r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text,
    category: r.category,
    importance: r.importance,
    decayClass: r.decay_class ?? "stable",
    provenance: parseProvenance(r.provenance_json),
  }));
  return {
    generatedAt: nowIso(),
    nodes,
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      linkType: e.linkType,
      strength: e.strength,
    })),
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
    return { generatedAt: nowIso(), nodes: [], edges: [], activated: [] };
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
  for (const id of ids) {
    const f = entryMap.get(id);
    if (!f) continue;
    nodes.push({
      id: f.id,
      label: f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text,
      category: f.category,
      importance: f.importance,
      decayClass: f.decayClass ?? "stable",
      provenance: parseProvenance(f.provenanceJson ?? null),
    });
  }
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const allEdges = factsDb.getAllEdges(10000);
  const edges = allEdges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)).slice(0, 2000);
  return {
    generatedAt: nowIso(),
    nodes,
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      linkType: e.linkType,
      strength: e.strength,
    })),
    activated: seeds,
    graphHubGuard: {
      configuredCap: hubDegreeCap,
      effectiveCap: resolveGraphHubDegreeCap(hubDegreeCap),
      connected,
      expansion,
    },
  };
}
