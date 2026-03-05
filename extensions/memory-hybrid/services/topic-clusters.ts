/**
 * Topic Cluster Detection (Issue #146).
 *
 * Detects and labels topic clusters — groups of densely interconnected facts
 * forming natural knowledge domains. Uses BFS connected-component analysis on
 * the memory_links graph.
 *
 * Usage:
 *   const result = detectClusters(factsDb, { minClusterSize: 3 });
 *   // result.clusters: TopicCluster[] sorted by size desc
 */

import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A detected topic cluster of interconnected facts. */
export interface TopicCluster {
  /** UUID for this cluster. */
  id: string;
  /** 2-3 word label derived from dominant entity/tags in cluster. */
  label: string;
  /** Fact IDs belonging to this cluster (sorted for stability). */
  factIds: string[];
  /** Number of facts (= factIds.length). */
  factCount: number;
  /** Epoch seconds when cluster was first detected. */
  createdAt: number;
  /** Epoch seconds when cluster was last updated. */
  updatedAt: number;
}

/** Options for cluster detection. */
export interface ClusterDetectionOptions {
  /** Minimum number of facts to form a cluster (default: 3). */
  minClusterSize?: number;
  /** Reserved: model for label generation; null = rule-based only (default: null). */
  labelModel?: string | null;
  /**
   * Map from canonical component key (sorted IDs joined by ",") to existing cluster metadata.
   * Enables stable cluster IDs and createdAt timestamps across incremental re-runs.
   */
  existingClusterIds?: Map<string, { id: string; createdAt: number }>;
}

/** Result of a cluster detection run. */
export interface ClusterDetectionResult {
  /** Detected clusters above minClusterSize threshold, sorted by size desc. */
  clusters: TopicCluster[];
  /** Number of linked facts that belong to no cluster (below threshold). */
  isolatedFacts: number;
  /** Total number of unique fact IDs that appear in at least one link. */
  totalLinkedFacts: number;
}

/**
 * Minimal FactsDB interface needed for cluster detection.
 * FactsDB already satisfies this interface.
 */
export interface ClusterFactLookup {
  /**
   * Get all unique fact IDs that participate in at least one memory link
   * (as source or target).
   */
  getAllLinkedFactIds(): string[];
  /**
   * Get all edges in the memory_links graph as [sourceFactId, targetFactId] pairs.
   * Used for building the adjacency map in one efficient DB query.
   */
  getAllLinks(): Array<{ sourceFactId: string; targetFactId: string }>;
  /** Get a fact entry by ID. Returns null when not found or expired. */
  getById(id: string): MemoryEntry | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a bidirectional adjacency map from edge pairs.
 * Nodes with no edges are seeded from factIds to ensure they appear in the map
 * even when getAllLinks() returns no edges for them (isolated case).
 */
function buildAdjacency(
  factIds: string[],
  edges: Array<{ sourceFactId: string; targetFactId: string }>,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();

  // Seed all known nodes
  for (const id of factIds) {
    if (!adj.has(id)) adj.set(id, new Set());
  }

  // Add edges (bidirectional)
  for (const { sourceFactId, targetFactId } of edges) {
    if (!adj.has(sourceFactId)) adj.set(sourceFactId, new Set());
    if (!adj.has(targetFactId)) adj.set(targetFactId, new Set());
    adj.get(sourceFactId)!.add(targetFactId);
    adj.get(targetFactId)!.add(sourceFactId);
  }

  return adj;
}

/**
 * BFS from startId, collecting all reachable fact IDs.
 * Marks visited nodes in the shared `visited` set.
 */
function bfsComponent(
  startId: string,
  adj: Map<string, Set<string>>,
  visited: Set<string>,
): string[] {
  const component: string[] = [];
  const queue: string[] = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    component.push(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return component;
}

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

/**
 * Generate a 2-3 word label for a cluster using a rule-based approach.
 *
 * Priority:
 * 1. Most frequent entity across cluster members
 * 2. Most frequent tag across cluster members
 * 3. Most frequent category
 * 4. Generic fallback "knowledge cluster"
 */
export function generateClusterLabel(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "knowledge cluster";

  // 1. Entity frequency
  const entityCounts = new Map<string, number>();
  for (const entry of entries) {
    const e = entry.entity?.trim();
    if (e) entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
  }
  if (entityCounts.size > 0) {
    const topEntity = [...entityCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Limit to 3 words, lowercase
    return topEntity.split(/[\s_-]+/).slice(0, 3).join(" ").toLowerCase();
  }

  // 2. Tag frequency (entry.tags is already string[] | null after DB mapping)
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    for (const tag of tags) {
      const t = tag.trim();
      if (t) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    const topTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return topTag.split(/[\s_-]+/).slice(0, 3).join(" ").toLowerCase();
  }

  // 3. Category frequency
  const categoryCounts = new Map<string, number>();
  for (const entry of entries) {
    const cat = entry.category;
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }
  if (categoryCounts.size > 0) {
    const topCat = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return `${topCat} cluster`;
  }

  return "knowledge cluster";
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * Detect topic clusters by BFS connected-component analysis on the memory_links graph.
 *
 * Algorithm:
 * 1. Load all fact IDs that participate in at least one link.
 * 2. Build a bidirectional adjacency map from all links.
 * 3. BFS from each unvisited fact to find connected components.
 * 4. Filter components below minClusterSize.
 * 5. Generate a rule-based label for each cluster.
 *
 * @param factsDb  FactsDB-compatible interface (ClusterFactLookup).
 * @param options  Detection options.
 * @returns        ClusterDetectionResult with clusters sorted by size desc.
 */
export function detectClusters(
  factsDb: ClusterFactLookup,
  options: ClusterDetectionOptions = {},
): ClusterDetectionResult {
  const { minClusterSize = 3, existingClusterIds } = options;

  const linkedFactIds = factsDb.getAllLinkedFactIds();
  const totalLinkedFacts = linkedFactIds.length;

  if (totalLinkedFacts === 0) {
    return { clusters: [], isolatedFacts: 0, totalLinkedFacts: 0 };
  }

  // Build adjacency from all links at once (efficient: single DB query)
  const allEdges = factsDb.getAllLinks();
  const adj = buildAdjacency(linkedFactIds, allEdges);

  // BFS connected-component analysis
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const factId of adj.keys()) {
    if (!visited.has(factId)) {
      components.push(bfsComponent(factId, adj, visited));
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let isolatedFacts = 0;
  const clusters: TopicCluster[] = [];

  for (const component of components) {
    if (component.length < minClusterSize) {
      isolatedFacts += component.length;
      continue;
    }

    const sortedIds = [...component].sort();
    const componentKey = sortedIds.join(",");
    const existing = existingClusterIds?.get(componentKey);
    const clusterId = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;

    // Load entries for label generation (skips missing/expired facts)
    const entries: MemoryEntry[] = [];
    for (const id of sortedIds) {
      const entry = factsDb.getById(id);
      if (entry) entries.push(entry);
    }

    clusters.push({
      id: clusterId,
      label: generateClusterLabel(entries),
      factIds: sortedIds,
      factCount: sortedIds.length,
      createdAt,
      updatedAt: now,
    });
  }

  // Sort by size descending (largest cluster first)
  clusters.sort((a, b) => b.factCount - a.factCount);

  return { clusters, isolatedFacts, totalLinkedFacts };
}
