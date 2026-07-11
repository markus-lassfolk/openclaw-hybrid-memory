/** Typed fetch helpers for the Memory Graph app (documents live in ./documents for parity tests). */
import { gqlRequest } from "./client";
import * as D from "./documents";
import type {
  ContradictionPair,
  FactDetail,
  GraphData,
  GraphInsights,
  LinkRecord,
  MemoryStats,
  RecallEvent,
  SearchHit,
  SuggestedLink,
  TopicCluster,
} from "./types";

export async function fetchGraph(maxNodes: number): Promise<{ graph: GraphData; stats: MemoryStats }> {
  return gqlRequest<{ graph: GraphData; stats: MemoryStats }>(D.GRAPH_QUERY, { filter: { maxNodes } });
}

/** A node's surroundings (the node itself + linked facts to `depth`), for expansion + find-focus. */
export async function fetchNeighborhood(startNodeIds: string[], maxDepth = 1, maxNodes = 150): Promise<GraphData> {
  const data = await gqlRequest<{ graph: GraphData }>(D.NEIGHBORHOOD_QUERY, {
    filter: { startNodeIds, maxDepth, maxNodes },
  });
  return data.graph;
}

/** Server-side search over the FULL store (not just the loaded top-N). */
export async function searchMemories(query: string, limit = 8): Promise<SearchHit[]> {
  const data = await gqlRequest<{ search: SearchHit[] }>(D.SEARCH_QUERY, { input: { query, limit } });
  return data.search;
}

/** Recall history for ActivityFeed hydration (newest first; ownership-gated server-side). */
export async function fetchRecentRecalls(limit = 15): Promise<RecallEvent[]> {
  const data = await gqlRequest<{ recentRecallEvents: RecallEvent[] }>(D.RECENT_RECALLS_QUERY, { limit });
  return data.recentRecallEvents;
}

/** Labeled topic clusters (server-side connected components) for naming Louvain hulls. */
export async function fetchTopicClusters(minSize = 2): Promise<TopicCluster[]> {
  const data = await gqlRequest<{ topicClusters: TopicCluster[] }>(D.TOPIC_CLUSTERS_QUERY, { minSize });
  return data.topicClusters;
}

export interface FactWithLinks extends FactDetail {
  links: LinkRecord[];
  linkedFrom: LinkRecord[];
}

export async function fetchFact(id: string): Promise<FactWithLinks | null> {
  const data = await gqlRequest<{ fact: FactWithLinks | null }>(D.FACT_QUERY, { id });
  return data.fact;
}

export async function fetchInsights(limit: number): Promise<GraphInsights> {
  const data = await gqlRequest<{ memoryGraphInsights: GraphInsights }>(D.INSIGHTS_QUERY, { limit });
  return data.memoryGraphInsights;
}

export async function fetchSuggestedLinks(threshold: number, limit: number): Promise<SuggestedLink[]> {
  const data = await gqlRequest<{ suggestedLinks: SuggestedLink[] }>(D.SUGGESTED_LINKS_QUERY, { threshold, limit });
  return data.suggestedLinks;
}

// --- Curation mutations ---

export async function createFact(input: {
  text: string;
  category?: string;
  importance?: number;
  tags?: string[];
}): Promise<{ id: string }> {
  const data = await gqlRequest<{ createFact: { id: string } }>(D.CREATE_FACT_MUTATION, { input });
  return data.createFact;
}

export async function updateFactText(id: string, text: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ updateFact: { id: string } }>(D.UPDATE_FACT_MUTATION, { input: { id, text } });
  return data.updateFact;
}

export async function deleteFact(id: string): Promise<boolean> {
  const data = await gqlRequest<{ deleteFact: boolean }>(D.DELETE_FACT_MUTATION, { id });
  return data.deleteFact;
}

export async function pinFact(id: string, reason?: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ pinFact: { id: string } }>(D.PIN_FACT_MUTATION, { id, reason });
  return data.pinFact;
}

export async function unpinFact(id: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ unpinFact: { id: string } }>(D.UNPIN_FACT_MUTATION, { id });
  return data.unpinFact;
}

export async function createLink(
  sourceId: string,
  targetId: string,
  linkType: string,
  weight: number,
): Promise<LinkRecord> {
  const data = await gqlRequest<{ createLink: LinkRecord }>(D.CREATE_LINK_MUTATION, {
    sourceId,
    targetId,
    linkType,
    weight,
  });
  return data.createLink;
}

export async function updateLink(id: string, linkType?: string, weight?: number): Promise<LinkRecord> {
  const data = await gqlRequest<{ updateLink: LinkRecord }>(D.UPDATE_LINK_MUTATION, { id, linkType, weight });
  return data.updateLink;
}

export async function deleteLink(id: string): Promise<boolean> {
  const data = await gqlRequest<{ deleteLink: boolean }>(D.DELETE_LINK_MUTATION, { id });
  return data.deleteLink;
}

export async function acceptSuggestedLink(
  sourceId: string,
  targetId: string,
  linkType = "RELATED_TO",
  weight = 0.7,
): Promise<LinkRecord> {
  const data = await gqlRequest<{ acceptSuggestedLink: LinkRecord }>(D.ACCEPT_SUGGESTED_LINK_MUTATION, {
    sourceId,
    targetId,
    linkType,
    weight,
  });
  return data.acceptSuggestedLink;
}

/** Resolve a contradiction: keepFactId supersedes the other fact; omitted = keep both ("kept"). */
export async function resolveContradiction(
  id: string,
  keepFactId?: string,
): Promise<{ id: string; resolution: string }> {
  const data = await gqlRequest<{ resolveContradiction: { id: string; resolution: string } }>(
    D.RESOLVE_CONTRADICTION_MUTATION,
    { id, keepFactId },
  );
  return data.resolveContradiction;
}

export type { ContradictionPair };
