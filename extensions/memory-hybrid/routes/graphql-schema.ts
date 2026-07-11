/**
 * GraphQL Schema for OpenClaw Hybrid Memory
 * Provides flexible querying of facts, episodes, links, and graph relationships
 */

export const graphqlSchema = `#graphql
  # Scalar types
  scalar DateTime
  scalar JSON

  # Core memory fact
  type Fact {
    id: ID!
    text: String!
    category: String!
    importance: Float!
    confidence: Float!
    decayClass: String!
    source: String
    tags: [String!]!
    createdAt: DateTime!
    updatedAt: DateTime
    expiresAt: DateTime
    supersededBy: ID
    embedding: [Float!]

    # Structured fields
    entity: String
    key: String
    value: String

    # Relationships
    links: [Link!]!
    linkedFrom: [Link!]!
    supersedes: Fact
    supersededByFact: Fact

    # Metadata
    scope: String
    scopeTarget: String
    metadata: JSON
  }

  # Episode tracking
  type Episode {
    id: ID!
    sessionId: String!
    turnId: String
    timestamp: DateTime!
    summary: String
    facts: [Fact!]!
    metadata: JSON
  }

  # Link between facts (graph relationships)
  type Link {
    id: ID!
    sourceId: ID!
    targetId: ID!
    linkType: String!
    weight: Float
    createdAt: DateTime!

    # Navigation
    source: Fact!
    target: Fact!
    metadata: JSON
  }

  # Search result with relevance scoring
  type SearchResult {
    fact: Fact!
    score: Float!
    matchType: String!
    snippet: String
  }

  # Statistics and analytics
  type MemoryStats {
    totalFacts: Int!
    activeFactsCount: Int!
    expiredFactsCount: Int!
    supersededFactsCount: Int!
    factsByCategory: [CategoryCount!]!
    factsByDecayClass: [DecayClassCount!]!
    totalEpisodes: Int!
    totalLinks: Int!
    databaseSizeBytes: Int!
    oldestFactDate: DateTime
    newestFactDate: DateTime
  }

  type CategoryCount {
    category: String!
    count: Int!
  }

  type DecayClassCount {
    decayClass: String!
    count: Int!
  }

  # A single recalled fact and the score it was ranked with (live overlay recall pulses).
  type RecallHit {
    factId: ID!
    score: Float!
  }

  # A recall that just happened — auto-recall injection or an explicit memory_recall.
  type RecallEvent {
    query: String
    source: String!
    sessionKey: String
    agentId: String
    occurredAt: DateTime!
    hits: [RecallHit!]!
  }

  # Graph structure for visualization
  type GraphData {
    nodes: [GraphNode!]!
    edges: [GraphEdge!]!
  }

  type GraphNode {
    id: ID!
    label: String!
    category: String!
    importance: Float!
    confidence: Float!
    decayClass: String!
    factCount: Int
  }

  type GraphEdge {
    source: ID!
    target: ID!
    linkType: String!
    weight: Float!
  }

  # Input types for mutations
  input CreateFactInput {
    text: String!
    category: String
    importance: Float
    confidence: Float
    decayClass: String
    source: String
    tags: [String!]
    entity: String
    key: String
    value: String
    scope: String
    scopeTarget: String
    expiresAt: DateTime
  }

  input UpdateFactInput {
    id: ID!
    text: String
    category: String
    importance: Float
    confidence: Float
    tags: [String!]
    expiresAt: DateTime
  }

  input SearchInput {
    query: String!
    categories: [String!]
    decayClasses: [String!]
    tags: [String!]
    minImportance: Float
    minConfidence: Float
    limit: Int
    offset: Int
    includeSuperseded: Boolean
    includeExpired: Boolean
    scope: String
    scopeTarget: String
  }

  input GraphFilterInput {
    categories: [String!]
    decayClasses: [String!]
    minImportance: Float
    linkTypes: [String!]
    maxDepth: Int
    startNodeIds: [ID!]
    scope: String
    # Clamped to [20, 2000], default 400 — matches the REST /api/graph route's maxNodes bound.
    maxNodes: Int
  }

  # Queries
  type Query {
    # Fact queries
    fact(id: ID!): Fact
    facts(
      limit: Int
      offset: Int
      category: String
      decayClass: String
      tags: [String!]
      scope: String
      includeSuperseded: Boolean
      includeExpired: Boolean
    ): [Fact!]!

    # Search
    search(input: SearchInput!): [SearchResult!]!
    semanticSearch(query: String!, limit: Int, scope: String): [SearchResult!]!

    # Episodes
    episode(id: ID!): Episode
    episodes(limit: Int, offset: Int, sessionId: String): [Episode!]!

    # Links and relationships
    link(id: ID!): Link
    links(sourceId: ID, targetId: ID, linkType: String, limit: Int): [Link!]!
    relatedFacts(factId: ID!, maxDepth: Int, linkTypes: [String!], limit: Int): [Fact!]!

    # Graph visualization
    graph(filter: GraphFilterInput): GraphData!

    # Statistics
    stats: MemoryStats!

    # Entity lookup
    entityFacts(entity: String!, key: String, limit: Int): [Fact!]!
  }

  # Mutations
  type Mutation {
    # Fact operations
    createFact(input: CreateFactInput!): Fact!
    updateFact(input: UpdateFactInput!): Fact!
    deleteFact(id: ID!): Boolean!
    supersedeFact(oldFactId: ID!, newFactId: ID!): Fact!

    # Link operations
    createLink(sourceId: ID!, targetId: ID!, linkType: String!, weight: Float): Link!
    deleteLink(id: ID!): Boolean!

    # Bulk operations
    importFacts(facts: [CreateFactInput!]!): [Fact!]!
    pruneFacts(olderThan: DateTime, category: String): Int!

    # Maintenance
    consolidateFacts(categoryPattern: String): Int
    recomputeEmbeddings(factIds: [ID!]): Boolean
  }

  # Subscriptions for real-time updates
  type Subscription {
    # Real-time fact changes
    factCreated(category: String, scope: String): Fact!
    factUpdated(factId: ID, category: String): Fact!
    factDeleted(category: String): ID!

    # Real-time link changes
    linkCreated(sourceId: ID, targetId: ID): Link!
    linkUpdated(sourceId: ID, targetId: ID): Link!

    # Real-time recall activity — which memories were just called upon (with per-fact scores).
    # Hits are scope-filtered per subscriber before delivery.
    recallOccurred(sessionKey: String): RecallEvent!

    # Statistics updates
    statsUpdated: MemoryStats!
  }
`;
