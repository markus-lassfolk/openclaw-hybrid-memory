/**
 * Every GraphQL document the Memory Graph app sends, in one dependency-free module.
 *
 * Deliberately imports NOTHING: the plugin's schema-drift test
 * (tests/graph-app-schema-parity.test.ts) imports this file directly and validates each document
 * against the live schema, so a field rename/removal on either side fails CI instead of surfacing
 * as a runtime "Cannot query field" in the browser. Add every new document to ALL_GRAPHQL_DOCUMENTS.
 */

export const GRAPH_NODE_FIELDS = `
  id label category importance confidence decayClass strength
  recallCount accessCount lastAccessedAt reinforcedCount
  pinned degree superseded contradicted clusterId tags entity expiresAt createdAt
`;

export const GRAPH_QUERY = `
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

/** Same node/edge selection as GRAPH_QUERY but without stats — used for neighborhood expansion. */
export const NEIGHBORHOOD_QUERY = `
  query Neighborhood($filter: GraphFilterInput) {
    graph(filter: $filter) {
      nodes { ${GRAPH_NODE_FIELDS} }
      edges { id source target linkType weight }
    }
  }
`;

export const FACT_QUERY = `
  query Fact($id: ID!) {
    fact(id: $id) {
      id text why category importance confidence decayClass source tags entity createdAt
      links { id sourceId targetId linkType weight }
      linkedFrom { id sourceId targetId linkType weight }
    }
  }
`;

export const INSIGHTS_QUERY = `
  query Insights($limit: Int) {
    memoryGraphInsights(limit: $limit) {
      orphanFacts { id text category importance }
      weakLinks { id sourceId targetId linkType weight }
      contradictions { id factNew { id text } factOld { id text } detectedAt }
      staleImportantFacts { id text category importance }
    }
  }
`;

export const SUGGESTED_LINKS_QUERY = `
  query Suggested($threshold: Float, $limit: Int) {
    suggestedLinks(threshold: $threshold, limit: $limit) {
      sourceId targetId sourceText targetText similarity
    }
  }
`;

/** Server-side search over the FULL store (not just loaded nodes) for find-and-focus. */
export const SEARCH_QUERY = `
  query Search($input: SearchInput!) {
    search(input: $input) {
      score
      fact { id text category }
    }
  }
`;

/** Recall history (ownership-gated server-side) for ActivityFeed hydration on load. */
export const RECENT_RECALLS_QUERY = `
  query RecentRecalls($limit: Int) {
    recentRecallEvents(limit: $limit) {
      query source sessionKey occurredAt
      hits { factId score }
    }
  }
`;

/** Labeled topic clusters for naming the Louvain hulls. */
export const TOPIC_CLUSTERS_QUERY = `
  query TopicClusters($minSize: Int) {
    topicClusters(minSize: $minSize) {
      id label factCount factIds
    }
  }
`;

// --- Mutations ---

export const CREATE_FACT_MUTATION = "mutation Create($input: CreateFactInput!) { createFact(input: $input) { id } }";

export const UPDATE_FACT_MUTATION = "mutation Update($input: UpdateFactInput!) { updateFact(input: $input) { id } }";

export const DELETE_FACT_MUTATION = "mutation Del($id: ID!) { deleteFact(id: $id) }";

export const PIN_FACT_MUTATION = "mutation Pin($id: ID!, $reason: String) { pinFact(id: $id, reason: $reason) { id } }";

export const UNPIN_FACT_MUTATION = "mutation Unpin($id: ID!) { unpinFact(id: $id) { id } }";

export const CREATE_LINK_MUTATION = `
  mutation Link($sourceId: ID!, $targetId: ID!, $linkType: String!, $weight: Float) {
    createLink(sourceId: $sourceId, targetId: $targetId, linkType: $linkType, weight: $weight) {
      id sourceId targetId linkType weight
    }
  }
`;

export const UPDATE_LINK_MUTATION = `
  mutation UpdLink($id: ID!, $linkType: String, $weight: Float) {
    updateLink(id: $id, linkType: $linkType, weight: $weight) { id sourceId targetId linkType weight }
  }
`;

export const DELETE_LINK_MUTATION = "mutation DelLink($id: ID!) { deleteLink(id: $id) }";

export const ACCEPT_SUGGESTED_LINK_MUTATION = `
  mutation Accept($sourceId: ID!, $targetId: ID!, $linkType: String, $weight: Float) {
    acceptSuggestedLink(sourceId: $sourceId, targetId: $targetId, linkType: $linkType, weight: $weight) {
      id sourceId targetId linkType weight
    }
  }
`;

export const RESOLVE_CONTRADICTION_MUTATION = `
  mutation Resolve($id: ID!, $keepFactId: ID) {
    resolveContradiction(id: $id, keepFactId: $keepFactId) { id resolution }
  }
`;

// --- Subscriptions (live overlay) ---

const FACT_FIELDS = `
  id text category importance confidence decayClass tags entity createdAt expiresAt
  recallCount accessCount lastAccessedAt reinforcedCount pinned supersededBy
`;
const LINK_FIELDS = "id sourceId targetId linkType weight";

export const FACT_CREATED_SUBSCRIPTION = `subscription { factCreated { ${FACT_FIELDS} } }`;
export const FACT_UPDATED_SUBSCRIPTION = `subscription { factUpdated { ${FACT_FIELDS} } }`;
export const FACT_DELETED_SUBSCRIPTION = "subscription { factDeleted }";
export const LINK_CREATED_SUBSCRIPTION = `subscription { linkCreated { ${LINK_FIELDS} } }`;
export const LINK_UPDATED_SUBSCRIPTION = `subscription { linkUpdated { ${LINK_FIELDS} } }`;
export const RECALL_OCCURRED_SUBSCRIPTION =
  "subscription { recallOccurred { query source sessionKey occurredAt hits { factId score } } }";

/** Every document above, named, for the plugin-side schema parity test. */
export const ALL_GRAPHQL_DOCUMENTS: ReadonlyArray<{ name: string; document: string }> = [
  { name: "GRAPH_QUERY", document: GRAPH_QUERY },
  { name: "NEIGHBORHOOD_QUERY", document: NEIGHBORHOOD_QUERY },
  { name: "FACT_QUERY", document: FACT_QUERY },
  { name: "INSIGHTS_QUERY", document: INSIGHTS_QUERY },
  { name: "SUGGESTED_LINKS_QUERY", document: SUGGESTED_LINKS_QUERY },
  { name: "SEARCH_QUERY", document: SEARCH_QUERY },
  { name: "RECENT_RECALLS_QUERY", document: RECENT_RECALLS_QUERY },
  { name: "TOPIC_CLUSTERS_QUERY", document: TOPIC_CLUSTERS_QUERY },
  { name: "CREATE_FACT_MUTATION", document: CREATE_FACT_MUTATION },
  { name: "UPDATE_FACT_MUTATION", document: UPDATE_FACT_MUTATION },
  { name: "DELETE_FACT_MUTATION", document: DELETE_FACT_MUTATION },
  { name: "PIN_FACT_MUTATION", document: PIN_FACT_MUTATION },
  { name: "UNPIN_FACT_MUTATION", document: UNPIN_FACT_MUTATION },
  { name: "CREATE_LINK_MUTATION", document: CREATE_LINK_MUTATION },
  { name: "UPDATE_LINK_MUTATION", document: UPDATE_LINK_MUTATION },
  { name: "DELETE_LINK_MUTATION", document: DELETE_LINK_MUTATION },
  { name: "ACCEPT_SUGGESTED_LINK_MUTATION", document: ACCEPT_SUGGESTED_LINK_MUTATION },
  { name: "RESOLVE_CONTRADICTION_MUTATION", document: RESOLVE_CONTRADICTION_MUTATION },
  { name: "FACT_CREATED_SUBSCRIPTION", document: FACT_CREATED_SUBSCRIPTION },
  { name: "FACT_UPDATED_SUBSCRIPTION", document: FACT_UPDATED_SUBSCRIPTION },
  { name: "FACT_DELETED_SUBSCRIPTION", document: FACT_DELETED_SUBSCRIPTION },
  { name: "LINK_CREATED_SUBSCRIPTION", document: LINK_CREATED_SUBSCRIPTION },
  { name: "LINK_UPDATED_SUBSCRIPTION", document: LINK_UPDATED_SUBSCRIPTION },
  { name: "RECALL_OCCURRED_SUBSCRIPTION", document: RECALL_OCCURRED_SUBSCRIPTION },
];
