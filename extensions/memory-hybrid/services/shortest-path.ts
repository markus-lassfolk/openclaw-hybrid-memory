/**
 * Shortest-Path Traversal Service (Issue #140).
 *
 * Finds the shortest path between two facts/entities in the memory graph via
 * bidirectional BFS on the memory_links table.  Both outgoing (getLinksFrom)
 * and incoming (getLinksTo) edges are traversed so the graph is treated as
 * undirected for reachability purposes.
 *
 * Usage:
 *   const result = findShortestPath(factsDb, startId, endId, { maxDepth: 5 });
 *   // result.steps = ordered list of PathStep; result.hops = step count
 */

import type { MemoryEntry } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One edge traversed in the shortest path. */
export interface PathStep {
  /** Fact we traversed FROM. */
  fromFactId: string;
  /** Fact we arrived AT. */
  toFactId: string;
  /** Edge type (e.g. RELATED_TO, PART_OF, CAUSED_BY). */
  linkType: string;
  /** Edge strength 0–1. */
  strength: number;
}

/** Returned by findShortestPath when a path is found. */
export interface ShortestPathResult {
  /** Ordered steps from fromFactId to toFactId. Empty when from === to (0 hops). */
  steps: PathStep[];
  /** Number of hops (= steps.length). */
  hops: number;
  /** Resolved start fact ID. */
  fromFactId: string;
  /** Resolved end fact ID. */
  toFactId: string;
  /** The MemoryEntry objects along the path (index 0 = start, last = end). */
  chain: MemoryEntry[];
}

/** Minimal interface the service needs from FactsDB. */
export interface ShortestPathLookup {
  getById(id: string): MemoryEntry | null;
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }>;
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>;
  /** Optional: resolve entity name → facts. Used by resolveInput. */
  lookup?(entity: string): Array<{ entry: MemoryEntry; score: number }>;
}

/** Options for findShortestPath. */
export interface ShortestPathOptions {
  /** Maximum path length in edges (default: 5, hard-capped by config). */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Find the shortest path between two facts via bidirectional BFS.
 *
 * The graph is treated as undirected — both getLinksFrom and getLinksTo are
 * traversed in each BFS step.
 *
 * @param db  - A FactsDB-compatible lookup interface.
 * @param startId - Fact ID to start from.
 * @param endId   - Fact ID to reach.
 * @param options - Optional: maxDepth (default 5).
 * @returns ShortestPathResult if a path is found within maxDepth, null otherwise.
 */
export function findShortestPath(
  db: ShortestPathLookup,
  startId: string,
  endId: string,
  options: ShortestPathOptions = {},
): ShortestPathResult | null {
  const maxDepth = Math.max(0, options.maxDepth ?? 5);

  // Same start and end → trivial path
  if (startId === endId) {
    const entry = db.getById(startId);
    if (!entry) return null;
    return { steps: [], hops: 0, fromFactId: startId, toFactId: endId, chain: [entry] };
  }

  // Both endpoints must exist
  if (!db.getById(startId) || !db.getById(endId)) return null;

  if (maxDepth === 0) return null;

  // fwd: factId → ordered path (PathStep[]) from startId to that factId
  const fwd = new Map<string, PathStep[]>();
  // bwd: factId → ordered path (PathStep[]) from that factId to endId
  const bwd = new Map<string, PathStep[]>();

  fwd.set(startId, []);
  bwd.set(endId, []);

  let fwdFrontier: string[] = [startId];
  let bwdFrontier: string[] = [endId];

  // Alternate expanding forward (odd hops) and backward (even hops).
  // Each outer iteration spends 1 hop in one direction.
  for (let hop = 1; hop <= maxDepth; hop++) {
    if (hop % 2 === 1) {
      // Expand forward by 1 hop
      const next: string[] = [];
      for (const nodeId of fwdFrontier) {
        const pathToNode = fwd.get(nodeId)!;
        for (const { neighborId, linkType, strength } of getNeighbors(db, nodeId)) {
          if (fwd.has(neighborId)) continue; // already visited forward
          const step: PathStep = { fromFactId: nodeId, toFactId: neighborId, linkType, strength };
          const newPath = [...pathToNode, step];
          fwd.set(neighborId, newPath);
          next.push(neighborId);
          if (bwd.has(neighborId)) {
            return buildResult(db, startId, endId, newPath, bwd.get(neighborId)!);
          }
        }
      }
      fwdFrontier = next;
    } else {
      // Expand backward by 1 hop
      const next: string[] = [];
      for (const nodeId of bwdFrontier) {
        const pathFromNode = bwd.get(nodeId)!;
        for (const { neighborId, linkType, strength } of getNeighbors(db, nodeId)) {
          if (bwd.has(neighborId)) continue; // already visited backward
          // Step goes FROM neighborId TO nodeId (closer to end)
          const step: PathStep = { fromFactId: neighborId, toFactId: nodeId, linkType, strength };
          const newPath = [step, ...pathFromNode];
          bwd.set(neighborId, newPath);
          next.push(neighborId);
          if (fwd.has(neighborId)) {
            return buildResult(db, startId, endId, fwd.get(neighborId)!, newPath);
          }
        }
      }
      bwdFrontier = next;
    }

    if (fwdFrontier.length === 0 && bwdFrontier.length === 0) break;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entity name resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an input string to a fact ID.
 *
 * Strategy:
 * 1. If the input matches a known fact ID (getById succeeds) → return it.
 * 2. Otherwise treat as entity name: call db.lookup(input) and return the
 *    first result's ID, or null if none found or lookup unavailable.
 *
 * @param db    - FactsDB-compatible lookup interface.
 * @param input - Raw user input (fact ID or entity name).
 * @returns Resolved fact ID, or null if not resolvable.
 */
export function resolveInput(db: ShortestPathLookup, input: string): string | null {
  if (!input || !input.trim()) return null;
  const trimmed = input.trim();

  // Try as a direct fact ID first
  if (db.getById(trimmed)) return trimmed;

  // Try as entity name via lookup
  if (db.lookup) {
    const results = db.lookup(trimmed);
    if (results.length > 0) return results[0].entry.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a shortest path as a human-readable chain string.
 *
 * @example
 * formatPath([{ fromFactId: "abc", toFactId: "def", linkType: "RELATED_TO", strength: 0.8 }])
 * // "abc… —[RELATED_TO]→ def…"
 */
export function formatPath(steps: PathStep[]): string {
  if (steps.length === 0) return "(same fact)";
  const parts: string[] = [`${steps[0].fromFactId.slice(0, 8)}\u2026`];
  for (const step of steps) {
    parts.push(`\u2014[${step.linkType}]\u2192`);
    parts.push(`${step.toFactId.slice(0, 8)}\u2026`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect all neighbors (outgoing + incoming) of a node as a flat list. */
function getNeighbors(
  db: ShortestPathLookup,
  nodeId: string,
): Array<{ neighborId: string; linkType: string; strength: number }> {
  const result: Array<{ neighborId: string; linkType: string; strength: number }> = [];
  for (const link of db.getLinksFrom(nodeId)) {
    result.push({ neighborId: link.targetFactId, linkType: link.linkType, strength: link.strength });
  }
  for (const link of db.getLinksTo(nodeId)) {
    result.push({ neighborId: link.sourceFactId, linkType: link.linkType, strength: link.strength });
  }
  return result;
}

/** Combine forward + backward paths into a ShortestPathResult. */
function buildResult(
  db: ShortestPathLookup,
  startId: string,
  endId: string,
  fwdPath: PathStep[],
  bwdPath: PathStep[],
): ShortestPathResult {
  const steps = [...fwdPath, ...bwdPath];
  // Build chain: all unique fact IDs in traversal order
  const ids: string[] = [startId];
  for (const step of steps) {
    if (step.toFactId !== ids[ids.length - 1]) ids.push(step.toFactId);
  }
  const chain: MemoryEntry[] = [];
  for (const id of ids) {
    const entry = db.getById(id);
    if (entry) chain.push(entry);
  }
  return { steps, hops: steps.length, fromFactId: startId, toFactId: endId, chain };
}
