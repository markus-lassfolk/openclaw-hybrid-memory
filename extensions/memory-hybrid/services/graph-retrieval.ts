/**
 * GraphRAG Retrieval Service (Issue #145).
 *
 * Provides BFS-based graph expansion starting from seed facts found by semantic/FTS5
 * search.  Each expanded fact is annotated with its hop count, link path, and a
 * distance-decayed score so callers can rank direct matches above graph-expanded ones.
 *
 * Usage:
 *   const { results: expanded } = expandGraph(factsDb, seedResults, { maxDepth: 2 });
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

/** Counters for graph BFS hub-guard behaviour (Issue #1192). */
export type GraphExpansionStats = {
  /** Traversable link endpoints considered before per-hop fanout trimming. */
  nodesConsidered: number;
  /** Link endpoints dropped due to per-hop fanout cap (or CTE paths rejected by hub validation). */
  nodesSkipped: number;
  /** Nodes where a per-hop fanout cap was applied (iterative BFS only; CTE uses degree skip in SQL). */
  hubsSkipped: number;
};

/** Default when `hubDegreeCap` is omitted from config / expand options. */
export const DEFAULT_GRAPH_HUB_DEGREE_CAP = 500;

/** Resolve effective hub guard: `undefined` → default cap; `null` → disabled. */
export function resolveGraphHubDegreeCap(hubDegreeCap: number | null | undefined): number | null {
  if (hubDegreeCap === undefined) return DEFAULT_GRAPH_HUB_DEGREE_CAP;
  return hubDegreeCap;
}

/** Internal BFS metadata stored per discovered node. */
interface NodeMeta {
  hopCount: number;
  /** Ordered path from the original seed to this node. */
  steps: LinkPathStep[];
  /** factId of the seed that originated this traversal path. */
  seedId: string;
  /**
   * #1192: cumulative hub-attenuation multiplier accumulated over the path. Starts at 1.0.
   * Each hop traversed *through* a node whose degree exceeded `hubDegreeCap` multiplies this
   * by `(1 - hubScorePenalty)`. The final score is `seedScore * decay * hubAttenuation`.
   */
  hubAttenuation: number;
}

/** Minimal interface the graph-retrieval service needs from FactsDB. */
export interface GraphFactLookup {
  getById(id: string, options?: { asOf?: number; scopeFilter?: unknown }): MemoryEntry | null;
  getByIds(ids: string[], options?: { asOf?: number; scopeFilter?: unknown }): Map<string, MemoryEntry>;
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }>;
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>;
  /** When present (real FactsDB), prefer recursive CTE expansion with per-hop hub guards validated on paths. */
  expandGraphWithCTE?(
    seedFactIds: string[],
    maxDepth: number,
    options?: {
      asOf?: number;
      scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
      hubDegreeCap?: number | null;
    },
  ): Array<{ factId: string; seedId: string; hopCount: number; path: string }>;
}

type GetByIdOpts = { asOf?: number; scopeFilter?: unknown };

/** Keep only links whose far endpoint is visible under the same scope/asOf as graph expansion. */
function filterLinksByEndpointScope(
  factsDb: GraphFactLookup,
  fromLinks: ReturnType<GraphFactLookup["getLinksFrom"]>,
  toLinks: ReturnType<GraphFactLookup["getLinksTo"]>,
  scopeOpts?: GetByIdOpts,
): {
  from: ReturnType<GraphFactLookup["getLinksFrom"]>;
  to: ReturnType<GraphFactLookup["getLinksTo"]>;
} {
  if (!scopeOpts || (scopeOpts.scopeFilter == null && scopeOpts.asOf == null)) {
    return { from: fromLinks, to: toLinks };
  }
  return {
    from: fromLinks.filter((l) => factsDb.getById(l.targetFactId, scopeOpts) != null),
    to: toLinks.filter((l) => factsDb.getById(l.sourceFactId, scopeOpts) != null),
  };
}

function ctePathMatchesHubGuards(
  factsDb: GraphFactLookup,
  path: LinkPathStep[],
  linksCache: Map<
    string,
    { from: ReturnType<GraphFactLookup["getLinksFrom"]>; to: ReturnType<GraphFactLookup["getLinksTo"]> }
  >,
  scopeOpts: GetByIdOpts | undefined,
  traversalCap: number | null,
): boolean {
  for (const step of path) {
    const fromId = step.fromFactId;
    const toId = step.toFactId;

    let cached = linksCache.get(fromId);
    if (!cached) {
      const rawFrom = factsDb.getLinksFrom(fromId);
      const rawTo = factsDb.getLinksTo(fromId);
      cached = filterLinksByEndpointScope(factsDb, rawFrom, rawTo, scopeOpts);
      linksCache.set(fromId, cached);
    }

    const outOk = filterTraversableLinks(cached.from, traversalCap).some(
      (l) => l.targetFactId === toId && l.linkType === step.linkType,
    );
    if (outOk) continue;
    const inOk = filterTraversableLinks(cached.to, traversalCap).some(
      (l) => l.sourceFactId === toId && l.linkType === step.linkType,
    );
    if (!inOk) return false;
  }
  return true;
}

/** Options for graph expansion. */
export interface GraphRetrievalOptions {
  /** Maximum BFS depth (0 = no expansion, just returns seeds). Default: 2. */
  maxDepth?: number;
  /** Maximum number of expanded (non-seed) results to append. Default: 20. */
  maxExpandedResults?: number;
  /** Scope filter forwarded to factsDb.getById. */
  scopeFilter?: unknown;
  /** Point-in-time filter (epoch seconds) forwarded to factsDb.getById. */
  asOf?: number;
  /**
   * Hub guard threshold (see `graph.hubDegreeCap` in config). When omitted, uses {@link DEFAULT_GRAPH_HUB_DEGREE_CAP}.
   * `null` disables per-hop fanout trimming and CTE/SQL degree skip (not recommended).
   */
  hubDegreeCap?: number | null;
  /**
   * #1192: when set, traversing a node whose degree exceeds `hubDegreeCap` no longer skips the
   * link entirely. Instead, the descendants' composite score is multiplied by `(1 - hubScorePenalty)`
   * once per hub hop. `null` (default) keeps the legacy hard-skip behaviour.
   */
  hubScorePenalty?: number | null;
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

export function filterTraversableLinks<
  T extends {
    linkType: string;
    strength?: number;
    id?: string;
    targetFactId?: string;
    sourceFactId?: string;
  },
>(links: T[], traversalCap: number | null, stats?: GraphExpansionStats, options?: { mode?: "skip" | "penalty" }): T[] {
  const traversable = links.filter((link) => link.linkType !== "CONTRADICTS");
  if (stats) stats.nodesConsidered += traversable.length;
  if (traversalCap === null || traversable.length <= traversalCap) return traversable;

  // High-degree DERIVED_FROM fanout is usually provenance/event lineage. Do not let it swamp
  // recall expansion; keep semantic/non-provenance links from the hub instead.
  const nonProvenance = traversable.filter((link) => link.linkType !== "DERIVED_FROM");
  const candidates = nonProvenance.length > 0 ? nonProvenance : traversable;
  const sorted = [...candidates].sort((a, b) => {
    const ds = (b.strength ?? 0) - (a.strength ?? 0);
    if (ds !== 0) return ds;
    const endA = a.targetFactId ?? a.sourceFactId ?? "";
    const endB = b.targetFactId ?? b.sourceFactId ?? "";
    const ka = `${a.linkType}\0${endA}\0${a.id ?? ""}`;
    const kb = `${b.linkType}\0${endB}\0${b.id ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // #1192: in penalty mode the caller plans to attenuate scores rather than drop links.
  // Returning the full sorted candidate set lets the BFS apply a multiplier instead of skipping.
  if (options?.mode === "penalty") {
    if (stats) stats.hubsSkipped += 1;
    return sorted;
  }
  const sliced = sorted.slice(0, traversalCap);
  if (stats) {
    stats.nodesSkipped += traversable.length - sliced.length;
    stats.hubsSkipped += 1;
  }
  return sliced;
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
 * **Performance:** When `expandGraphWithCTE` is available (FactsDB), uses a recursive CTE for expansion
 * and validates each returned path against the same per-hop hub guards as iterative BFS. Custom/mock
 * lookups without CTE use iterative BFS only.
 *
 * @param factsDb - FactsDB-compatible interface.
 * @param seedResults - Initial results from semantic/FTS5 search.
 * @param options - Expansion options.
 * @returns Combined direct + expanded results plus hub-guard counters. Direct (seed) results are returned
 * in the original seed order; graph-expanded results follow, ordered by hopCount
 * (1-hop, then 2-hop, etc.) and within each hop by decayed score desc. No global
 * resort by score or best-path deduplication across multiple seeds/paths.
 */
export function expandGraph(
  factsDb: GraphFactLookup,
  seedResults: Array<{ factId: string; score: number; entry: MemoryEntry }>,
  options: GraphRetrievalOptions = {},
): { results: GraphExpandedResult[]; stats: GraphExpansionStats } {
  const {
    maxDepth = 2,
    maxExpandedResults = 20,
    scopeFilter,
    asOf,
    hubDegreeCap: hubCapOpt,
    hubScorePenalty: hubScorePenaltyOpt = null,
  } = options;
  const traversalCap = resolveGraphHubDegreeCap(hubCapOpt);
  const hubScorePenalty =
    typeof hubScorePenaltyOpt === "number" && hubScorePenaltyOpt > 0 && hubScorePenaltyOpt < 1
      ? hubScorePenaltyOpt
      : null;
  const filterMode: "skip" | "penalty" = hubScorePenalty != null ? "penalty" : "skip";
  const stats: GraphExpansionStats = { nodesConsidered: 0, nodesSkipped: 0, hubsSkipped: 0 };

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
    return { results: directResults, stats };
  }

  const seedScoreMap = new Map<string, number>(seedResults.map((s) => [s.factId, s.score]));
  const seedIds = seedResults.map((s) => s.factId);
  const maxSeedScore = Math.max(...seedResults.map((s) => s.score), 0.5);
  const expandedResults: GraphExpandedResult[] = [];

  const cteScopeFilter =
    scopeFilter && typeof scopeFilter === "object"
      ? (scopeFilter as { userId?: string; agentId?: string; sessionId?: string })
      : undefined;

  if (factsDb.expandGraphWithCTE) {
    const expansionRows = factsDb.expandGraphWithCTE(seedIds, maxDepth, {
      asOf,
      scopeFilter: cteScopeFilter,
      hubDegreeCap: traversalCap,
    });

    const cteCandidates = expansionRows.filter((r) => r.hopCount > 0).length;

    // Pre-fetch all links for nodes that appear in paths to avoid N+1 queries
    const nodesInPaths = new Set<string>();
    const parsedPaths = new Map<number, LinkPathStep[]>();

    for (let i = 0; i < expansionRows.length; i++) {
      const row = expansionRows[i];
      if (row.hopCount === 0) continue;
      try {
        const linkPath = JSON.parse(row.path) as LinkPathStep[];
        parsedPaths.set(i, linkPath);
        for (const step of linkPath) {
          nodesInPaths.add(step.fromFactId);
        }
      } catch {
        // Skip invalid paths
      }
    }

    // Batch-fetch all links for nodes in paths
    const linksCache = new Map<
      string,
      { from: ReturnType<GraphFactLookup["getLinksFrom"]>; to: ReturnType<GraphFactLookup["getLinksTo"]> }
    >();
    for (const nodeId of nodesInPaths) {
      const rawFrom = factsDb.getLinksFrom(nodeId);
      const rawTo = factsDb.getLinksTo(nodeId);
      const scoped = filterLinksByEndpointScope(factsDb, rawFrom, rawTo, getByIdOpts);
      linksCache.set(nodeId, scoped);
    }

    let cteRejected = 0;
    for (let i = 0; i < expansionRows.length; i++) {
      const row = expansionRows[i];
      if (row.hopCount === 0) continue;

      const linkPath = parsedPaths.get(i);
      if (!linkPath) {
        cteRejected++;
        continue;
      }

      if (!ctePathMatchesHubGuards(factsDb, linkPath, linksCache, getByIdOpts, traversalCap)) {
        cteRejected++;
        continue;
      }

      const entry = factsDb.getById(row.factId, getByIdOpts);
      if (!entry) continue;

      const seedScore = seedScoreMap.get(row.seedId) ?? maxSeedScore;
      const decay = HOP_SCORE_DECAY[row.hopCount] ?? HOP_SCORE_DECAY[HOP_SCORE_DECAY.length - 1];
      const score = seedScore * decay;

      expandedResults.push({
        factId: row.factId,
        entry,
        expansionSource: "graph",
        hopCount: row.hopCount,
        linkPath,
        score,
      });
    }
    stats.nodesConsidered = cteCandidates;
    stats.nodesSkipped = cteRejected;
    stats.hubsSkipped = 0;
  } else {
    // Iterative BFS keeps traversal guards explicit: high-degree provenance hubs are
    // intentionally not expanded through, because they can swamp recall results.
    {
      const nodeMeta = new Map<string, NodeMeta>();
      for (const s of seedResults) {
        nodeMeta.set(s.factId, { hopCount: 0, steps: [], seedId: s.factId, hubAttenuation: 1 });
      }

      let frontier: string[] = [...seedIds];

      function tryAddNode(
        candidateId: string,
        hop: number,
        steps: LinkPathStep[],
        seedId: string,
        hubAttenuation: number,
        nextFrontier: string[],
        visibleIds: Set<string>,
      ): void {
        if (!visibleIds.has(candidateId)) return;
        const existing = nodeMeta.get(candidateId);
        const newSeedScore = seedScoreMap.get(seedId) ?? 0;
        if (!existing) {
          nodeMeta.set(candidateId, { hopCount: hop, steps, seedId, hubAttenuation });
          nextFrontier.push(candidateId);
          return;
        }
        if (hop < existing.hopCount) {
          nodeMeta.set(candidateId, { hopCount: hop, steps, seedId, hubAttenuation });
          nextFrontier.push(candidateId);
          return;
        }
        if (hop === existing.hopCount && newSeedScore > (seedScoreMap.get(existing.seedId) ?? 0)) {
          nodeMeta.set(candidateId, { hopCount: hop, steps, seedId, hubAttenuation });
        }
      }

      for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
        const nextFrontier: string[] = [];
        const candidateMoves: Array<{
          candidateId: string;
          steps: LinkPathStep[];
          seedId: string;
          hubAttenuation: number;
        }> = [];

        for (const fromId of frontier) {
          const fromMeta = nodeMeta.get(fromId)!;

          // --- Outgoing edges: fromId → targetId ---
          const rawOut = factsDb.getLinksFrom(fromId);
          const outIsHub =
            traversalCap !== null && rawOut.filter((l) => l.linkType !== "CONTRADICTS").length > traversalCap;
          const outLinks = filterTraversableLinks(rawOut, traversalCap, stats, { mode: filterMode });
          const outAttenuation =
            hubScorePenalty != null && outIsHub
              ? fromMeta.hubAttenuation * (1 - hubScorePenalty)
              : fromMeta.hubAttenuation;
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
              hubAttenuation: outAttenuation,
            });
          }

          // --- Incoming edges: sourceId → fromId ---
          const rawIn = factsDb.getLinksTo(fromId);
          const inIsHub =
            traversalCap !== null && rawIn.filter((l) => l.linkType !== "CONTRADICTS").length > traversalCap;
          const inLinks = filterTraversableLinks(rawIn, traversalCap, stats, { mode: filterMode });
          const inAttenuation =
            hubScorePenalty != null && inIsHub
              ? fromMeta.hubAttenuation * (1 - hubScorePenalty)
              : fromMeta.hubAttenuation;
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
              hubAttenuation: inAttenuation,
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
          tryAddNode(move.candidateId, hop, move.steps, move.seedId, move.hubAttenuation, nextFrontier, visibleIds);
        }

        frontier = nextFrontier;
      }

      for (const [factId, meta] of nodeMeta) {
        if (meta.hopCount === 0) continue; // already in directResults

        const entry = factsDb.getById(factId, getByIdOpts);
        if (!entry) continue;

        const seedScore = seedScoreMap.get(meta.seedId) ?? maxSeedScore;
        const decay = HOP_SCORE_DECAY[meta.hopCount] ?? HOP_SCORE_DECAY[HOP_SCORE_DECAY.length - 1];
        const score = seedScore * decay * meta.hubAttenuation;

        expandedResults.push({
          factId,
          entry,
          expansionSource: "graph",
          hopCount: meta.hopCount,
          linkPath: meta.steps,
          score,
        });
      }
    }
  }

  // Sort expanded: by hopCount asc, then score desc.
  expandedResults.sort((a, b) => (a.hopCount !== b.hopCount ? a.hopCount - b.hopCount : b.score - a.score));

  const trimmed = expandedResults.slice(0, maxExpandedResults);

  // Combine: direct first (preserve original order), then expanded.
  return { results: [...directResults, ...trimmed], stats };
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
