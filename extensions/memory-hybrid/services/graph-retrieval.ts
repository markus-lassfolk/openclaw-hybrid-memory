/**
 * GraphRAG Retrieval Service (Issue #145).
 *
 * Provides BFS-based graph expansion starting from seed facts found by semantic/FTS5
 * search.  Each expanded fact is annotated with its hop count, link path, and a
 * distance-decayed score so callers can rank direct matches above graph-expanded ones.
 *
 * Usage:
 *   const expanded = expandGraph(factsDb, seedResults, { maxDepth: 2 });
 *   // direct results have hopCount=0; graph-expanded have hopCount>=1
 */

import type { MemoryEntry } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One step in the path from the original seed fact to a graph-expanded fact.
 * Represents the traversal edge used to move from `fromFactId` to the next node.
 */
export interface LinkPathStep {
  /** Fact we traversed FROM (seed or intermediate). */
  fromFactId: string;
  /** Fact we arrived AT. */
  toFactId: string;
  /** Edge type (e.g. RELATED_TO, PART_OF, CAUSED_BY). */
  linkType: string;
  /** Edge strength 0–1. */
  strength: number;
}

/** A seed fact or a graph-expanded fact with expansion metadata. */
export interface GraphExpandedResult {
  factId: string;
  entry: MemoryEntry;
  /** "direct" = came from the original search; "graph" = found via BFS traversal. */
  expansionSource: "direct" | "graph";
  /** 0 for direct results, ≥1 for graph-expanded. */
  hopCount: number;
  /**
   * Ordered list of link steps from the seed fact to this fact.
   * Empty for direct results.  For a 2-hop result: [seed→A, A→this].
   */
  linkPath: LinkPathStep[];
  /** Relevance score: seed score × HOP_SCORE_DECAY[hopCount]. */
  score: number;
}

/** Minimal interface the graph-retrieval service needs from FactsDB. */
export interface GraphFactLookup {
  getById(id: string, options?: { asOf?: number; scopeFilter?: unknown }): MemoryEntry | null;
  getByIds(ids: string[], options?: { asOf?: number; scopeFilter?: unknown }): Map<string, MemoryEntry>;
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }>;
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>;
}

/** Options for graph expansion. */
interface GraphRetrievalOptions {
  /** Maximum BFS depth (0 = no expansion, just returns seeds). Default: 2. */
  maxDepth?: number;
  /** Maximum number of expanded (non-seed) results to append. Default: 20. */
  maxExpandedResults?: number;
  /** Scope filter forwarded to factsDb.getById. */
  scopeFilter?: unknown;
  /** Point-in-time filter (epoch seconds) forwarded to factsDb.getById. */
  asOf?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Per-hop score decay multipliers.
 * Index 0 = direct (no decay), 1 = 1-hop, 2 = 2-hop, 3 = 3-hop.
 * Beyond index 3, the last value is reused.
 */
export const HOP_SCORE_DECAY: readonly number[] = [1.0, 0.7, 0.5, 0.35];

// ---------------------------------------------------------------------------
// BFS state types (internal)
// ---------------------------------------------------------------------------

/** Internal BFS metadata stored per discovered node. */
interface NodeMeta {
  hopCount: number;
  /** Ordered path from the original seed to this node. */
  steps: LinkPathStep[];
  /** factId of the seed that originated this traversal path. */
  seedId: string;
}

// ---------------------------------------------------------------------------
// Core expansion function
// ---------------------------------------------------------------------------

/**
 * Expand from a set of seed results via BFS on the memory_links graph.
 *
 * Both outgoing (getLinksFrom) and incoming (getLinksTo) edges are traversed
 * so the expansion is bidirectional — matching the behaviour of
 * FactsDB.getConnectedFactIds.
 *
 * Results are ranked: direct matches appear first (hopCount=0), then 1-hop,
 * then 2-hop, etc., each with a distance-decayed score.
 *
 * @param factsDb - FactsDB-compatible interface.
 * @param seedResults - Initial results from semantic/FTS5 search.
 * @param options - Expansion options.
 * @returns Combined direct + expanded results. Direct (seed) results are returned
 * in the original seed order; graph-expanded results follow, ordered by hopCount
 * (1-hop, then 2-hop, etc.) and within each hop by decayed score desc. No global
 * resort by score or best-path deduplication across multiple seeds/paths.
 */
export function expandGraph(
  factsDb: GraphFactLookup,
  seedResults: Array<{ factId: string; score: number; entry: MemoryEntry }>,
  options: GraphRetrievalOptions = {},
): GraphExpandedResult[] {
  const { maxDepth = 2, maxExpandedResults = 20, scopeFilter, asOf } = options;

  const getByIdOpts = scopeFilter != null || asOf != null ? { asOf, scopeFilter } : undefined;

  // Build direct results first.
  const directResults: GraphExpandedResult[] = seedResults.map((s) => ({
    factId: s.factId,
    entry: s.entry,
    expansionSource: "direct",
    hopCount: 0,
    linkPath: [],
    score: s.score,
  }));

  if (maxDepth === 0 || seedResults.length === 0) {
    return directResults;
  }

  const seedScoreMap = new Map<string, number>(seedResults.map((s) => [s.factId, s.score]));

  // BFS: track discovered nodes by factId → NodeMeta.
  const nodeMeta = new Map<string, NodeMeta>();
  for (const s of seedResults) {
    nodeMeta.set(s.factId, { hopCount: 0, steps: [], seedId: s.factId });
  }

  // frontier holds the factIds to expand in the next hop.
  let frontier: string[] = seedResults.map((s) => s.factId);

  /** Only add a candidate if it is visible (scope/asOf) and either new or a better path. */
  function tryAddNode(
    candidateId: string,
    hop: number,
    steps: LinkPathStep[],
    seedId: string,
    nextFrontier: string[],
    visibleIds: Set<string>,
  ): void {
    if (!visibleIds.has(candidateId)) return;
    const existing = nodeMeta.get(candidateId);
    const newSeedScore = seedScoreMap.get(seedId) ?? 0;
    if (!existing) {
      nodeMeta.set(candidateId, { hopCount: hop, steps, seedId });
      nextFrontier.push(candidateId);
      return;
    }
    if (hop < existing.hopCount) {
      nodeMeta.set(candidateId, { hopCount: hop, steps, seedId });
      nextFrontier.push(candidateId);
      return;
    }
    if (hop === existing.hopCount && newSeedScore > (seedScoreMap.get(existing.seedId) ?? 0)) {
      nodeMeta.set(candidateId, { hopCount: hop, steps, seedId });
    }
  }

  for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    const candidateMoves: Array<{
      candidateId: string;
      steps: LinkPathStep[];
      seedId: string;
    }> = [];

    for (const fromId of frontier) {
      const fromMeta = nodeMeta.get(fromId)!;

      // --- Outgoing edges: fromId → targetId ---
      const outLinks = factsDb.getLinksFrom(fromId);
      for (const link of outLinks) {
        const steps: LinkPathStep[] = [
          ...fromMeta.steps,
          {
            fromFactId: fromId,
            toFactId: link.targetFactId,
            linkType: link.linkType,
            strength: link.strength,
          },
        ];
        candidateMoves.push({
          candidateId: link.targetFactId,
          steps,
          seedId: fromMeta.seedId,
        });
      }

      // --- Incoming edges: sourceId → fromId (we discover sourceId) ---
      const inLinks = factsDb.getLinksTo(fromId);
      for (const link of inLinks) {
        const steps: LinkPathStep[] = [
          ...fromMeta.steps,
          {
            fromFactId: fromId,
            toFactId: link.sourceFactId,
            linkType: link.linkType,
            strength: link.strength,
          },
        ];
        candidateMoves.push({
          candidateId: link.sourceFactId,
          steps,
          seedId: fromMeta.seedId,
        });
      }
    }

    if (candidateMoves.length === 0) {
      frontier = nextFrontier;
      continue;
    }

    const candidateIds = Array.from(new Set(candidateMoves.map((m) => m.candidateId)));
    const visible = factsDb.getByIds(candidateIds, getByIdOpts);
    const visibleIds = new Set(visible.keys());
    for (const move of candidateMoves) {
      tryAddNode(move.candidateId, hop, move.steps, move.seedId, nextFrontier, visibleIds);
    }

    frontier = nextFrontier;
  }

  // Build expanded results (non-seed nodes only).
  const expandedResults: GraphExpandedResult[] = [];
  const maxSeedScore = Math.max(...seedResults.map((s) => s.score), 0.5);
  for (const [factId, meta] of nodeMeta) {
    if (meta.hopCount === 0) continue; // already in directResults

    const entry = factsDb.getById(factId, getByIdOpts);
    if (!entry) continue;

    const seedScore = seedScoreMap.get(meta.seedId) ?? maxSeedScore;
    const decay = HOP_SCORE_DECAY[meta.hopCount] ?? HOP_SCORE_DECAY[HOP_SCORE_DECAY.length - 1];
    const score = seedScore * decay;

    expandedResults.push({
      factId,
      entry,
      expansionSource: "graph",
      hopCount: meta.hopCount,
      linkPath: meta.steps,
      score,
    });
  }

  // Sort expanded: by hopCount asc, then score desc.
  expandedResults.sort((a, b) => (a.hopCount !== b.hopCount ? a.hopCount - b.hopCount : b.score - a.score));

  const trimmed = expandedResults.slice(0, maxExpandedResults);

  // Combine: direct first (preserve original order), then expanded.
  return [...directResults, ...trimmed];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a link path as a human-readable string for display in results.
 *
 * @example
 * formatLinkPath([{ fromFactId: "abc123", toFactId: "def456", linkType: "RELATED_TO", strength: 0.8 }])
 * // "via RELATED_TO from abc123…"
 */
export function formatLinkPath(linkPath: LinkPathStep[]): string {
  if (linkPath.length === 0) return "";
  return linkPath.map((step) => `via ${step.linkType} from ${step.fromFactId.slice(0, 8)}\u2026`).join(" \u2192 ");
}
