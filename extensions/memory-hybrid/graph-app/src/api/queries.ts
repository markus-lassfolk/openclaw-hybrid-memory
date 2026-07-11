/** GraphQL documents + typed fetch helpers for the Memory Graph app. */
import { gqlRequest } from "./client";
import type {
  ContradictionPair,
  FactDetail,
  GraphData,
  GraphInsights,
  LinkRecord,
  MemoryStats,
  SuggestedLink,
} from "./types";

const GRAPH_NODE_FIELDS = `
  id label category importance confidence decayClass strength
  recallCount accessCount lastAccessedAt reinforcedCount
  pinned degree superseded contradicted clusterId tags entity
`;

const GRAPH_QUERY = `
  query Graph($filter: GraphFilterInput) {
    graph(filter: $filter) {
      nodes { ${GRAPH_NODE_FIELDS} }
      edges { id source target linkType weight }
    }
    stats {
      totalFacts activeFactsCount supersededFactsCount totalLinks
      factsByCategory { category count }
    }
  }
`;

export async function fetchGraph(maxNodes: number): Promise<{ graph: GraphData; stats: MemoryStats }> {
  return gqlRequest<{ graph: GraphData; stats: MemoryStats }>(GRAPH_QUERY, { filter: { maxNodes } });
}

const FACT_QUERY = `
  query Fact($id: ID!) {
    fact(id: $id) {
      id text why category importance confidence decayClass source tags entity createdAt
      links { id sourceId targetId linkType weight }
      linkedFrom { id sourceId targetId linkType weight }
    }
  }
`;

export interface FactWithLinks extends FactDetail {
  links: LinkRecord[];
  linkedFrom: LinkRecord[];
}

export async function fetchFact(id: string): Promise<FactWithLinks | null> {
  const data = await gqlRequest<{ fact: FactWithLinks | null }>(FACT_QUERY, { id });
  return data.fact;
}

const INSIGHTS_QUERY = `
  query Insights($limit: Int) {
    memoryGraphInsights(limit: $limit) {
      orphanFacts { id text category importance }
      weakLinks { id sourceId targetId linkType weight }
      contradictions { id factNew { id text } factOld { id text } detectedAt }
      staleImportantFacts { id text category importance }
    }
  }
`;

export async function fetchInsights(limit: number): Promise<GraphInsights> {
  const data = await gqlRequest<{ memoryGraphInsights: GraphInsights }>(INSIGHTS_QUERY, { limit });
  return data.memoryGraphInsights;
}

const SUGGESTED_LINKS_QUERY = `
  query Suggested($threshold: Float, $limit: Int) {
    suggestedLinks(threshold: $threshold, limit: $limit) {
      sourceId targetId sourceText targetText similarity
    }
  }
`;

export async function fetchSuggestedLinks(threshold: number, limit: number): Promise<SuggestedLink[]> {
  const data = await gqlRequest<{ suggestedLinks: SuggestedLink[] }>(SUGGESTED_LINKS_QUERY, { threshold, limit });
  return data.suggestedLinks;
}

// --- Curation mutations ---

export async function createFact(input: {
  text: string;
  category?: string;
  importance?: number;
  tags?: string[];
}): Promise<{ id: string }> {
  const data = await gqlRequest<{ createFact: { id: string } }>(
    `mutation Create($input: CreateFactInput!) { createFact(input: $input) { id } }`,
    { input },
  );
  return data.createFact;
}

export async function updateFactText(id: string, text: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ updateFact: { id: string } }>(
    `mutation Update($input: UpdateFactInput!) { updateFact(input: $input) { id } }`,
    { input: { id, text } },
  );
  return data.updateFact;
}

export async function deleteFact(id: string): Promise<boolean> {
  const data = await gqlRequest<{ deleteFact: boolean }>(`mutation Del($id: ID!) { deleteFact(id: $id) }`, { id });
  return data.deleteFact;
}

export async function pinFact(id: string, reason?: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ pinFact: { id: string } }>(
    `mutation Pin($id: ID!, $reason: String) { pinFact(id: $id, reason: $reason) { id } }`,
    { id, reason },
  );
  return data.pinFact;
}

export async function unpinFact(id: string): Promise<{ id: string }> {
  const data = await gqlRequest<{ unpinFact: { id: string } }>(
    `mutation Unpin($id: ID!) { unpinFact(id: $id) { id } }`,
    { id },
  );
  return data.unpinFact;
}

export async function createLink(
  sourceId: string,
  targetId: string,
  linkType: string,
  weight: number,
): Promise<LinkRecord> {
  const data = await gqlRequest<{ createLink: LinkRecord }>(
    `mutation Link($sourceId: ID!, $targetId: ID!, $linkType: String!, $weight: Float) {
       createLink(sourceId: $sourceId, targetId: $targetId, linkType: $linkType, weight: $weight) {
         id sourceId targetId linkType weight
       }
     }`,
    { sourceId, targetId, linkType, weight },
  );
  return data.createLink;
}

export async function updateLink(id: string, linkType?: string, weight?: number): Promise<LinkRecord> {
  const data = await gqlRequest<{ updateLink: LinkRecord }>(
    `mutation UpdLink($id: ID!, $linkType: String, $weight: Float) {
       updateLink(id: $id, linkType: $linkType, weight: $weight) { id sourceId targetId linkType weight }
     }`,
    { id, linkType, weight },
  );
  return data.updateLink;
}

export async function deleteLink(id: string): Promise<boolean> {
  const data = await gqlRequest<{ deleteLink: boolean }>(`mutation DelLink($id: ID!) { deleteLink(id: $id) }`, { id });
  return data.deleteLink;
}

export async function acceptSuggestedLink(
  sourceId: string,
  targetId: string,
  linkType = "RELATED_TO",
  weight = 0.7,
): Promise<LinkRecord> {
  const data = await gqlRequest<{ acceptSuggestedLink: LinkRecord }>(
    `mutation Accept($sourceId: ID!, $targetId: ID!, $linkType: String, $weight: Float) {
       acceptSuggestedLink(sourceId: $sourceId, targetId: $targetId, linkType: $linkType, weight: $weight) {
         id sourceId targetId linkType weight
       }
     }`,
    { sourceId, targetId, linkType, weight },
  );
  return data.acceptSuggestedLink;
}

export type { ContradictionPair };
