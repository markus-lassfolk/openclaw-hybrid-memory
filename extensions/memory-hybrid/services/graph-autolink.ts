import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { GraphConfig } from "../config.js";
import type { MemoryEntry, MemoryScope } from "../types/memory.js";
import { findSimilarByEmbedding } from "./vector-search.js";

export type GraphAutoLinkDeps = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  vector?: number[];
  text: string;
  entity: string | null;
  key: string | null;
  newFactId: string;
  scope?: MemoryScope;
  scopeTarget?: string | null;
};

/**
 * Create semantic RELATED_TO links using embedding similarity when a vector is available.
 * Falls back to entity/FTS classification similarity when embedding search is unavailable.
 */
export async function autoLinkSemanticallySimilarFacts(
  deps: GraphAutoLinkDeps,
  graph: GraphConfig,
): Promise<number> {
  if (!graph.enabled || !graph.autoLink) return 0;

  const scope = deps.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (deps.scopeTarget ?? null);
  let candidates: MemoryEntry[] = [];

  if (deps.vector && deps.vector.length > 0) {
    candidates = await findSimilarByEmbedding(
      deps.vectorDb,
      deps.factsDb,
      deps.vector,
      graph.autoLinkLimit,
      graph.autoLinkSimilarityThreshold,
      { scope, scopeTarget },
    );
  } else {
    candidates = deps.factsDb.findSimilarForClassification(
      deps.text,
      deps.entity,
      deps.key,
      graph.autoLinkLimit,
      scope,
      scopeTarget,
    );
  }

  let linked = 0;
  for (const candidate of candidates) {
    if (candidate.id === deps.newFactId) continue;
    deps.factsDb.createOrStrengthenRelatedLink(deps.newFactId, candidate.id, graph.autoLinkStrength);
    linked++;
  }
  return linked;
}
