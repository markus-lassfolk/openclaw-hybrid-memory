/**
 * GraphQL Server for OpenClaw Hybrid Memory
 * Provides GraphQL API endpoint with subscriptions support
 */

interface MemoryPluginContext {
  config?: unknown;
  [key: string]: unknown;
}

import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { graphqlSchema } from "./graphql-schema.js";
import { pluginLogger } from "../utils/logger.js";
import { resolvers, type GraphQLContext } from "./graphql-resolvers.js";

// PubSub for subscriptions
const pubSub = createPubSub<{
  factCreated: [{ fact: unknown; category?: string; scope?: string }];
  factUpdated: [{ fact: unknown }];
  factDeleted: [{ id: string; category?: string }];
  linkCreated: [{ link: unknown }];
  statsUpdated: [{ stats: unknown }];
}>();

/**
 * Create GraphQL Yoga server instance
 */
export function createGraphQLServer(
  factsDb: FactsDB,
  vectorDb: VectorDB | undefined,
  pluginContext: MemoryPluginContext,
) {
  const yoga = createYoga<GraphQLContext>({
    schema: createSchema({
      typeDefs: graphqlSchema,
      resolvers: {
        ...resolvers,
        Subscription: {
          factCreated: {
            subscribe: () => pubSub.subscribe("factCreated"),
            resolve: (payload: { fact: unknown }) => payload.fact,
          },
          factUpdated: {
            subscribe: () => pubSub.subscribe("factUpdated"),
            resolve: (payload: { fact: unknown }) => payload.fact,
          },
          factDeleted: {
            subscribe: () => pubSub.subscribe("factDeleted"),
            resolve: (payload: { id: string }) => payload.id,
          },
          linkCreated: {
            subscribe: () => pubSub.subscribe("linkCreated"),
            resolve: (payload: { link: unknown }) => payload.link,
          },
          statsUpdated: {
            subscribe: () => pubSub.subscribe("statsUpdated"),
            resolve: (payload: { stats: unknown }) => payload.stats,
          },
        },
      },
    }),
    context: (): GraphQLContext => ({
      factsDb,
      vectorDb,
      pluginContext,
    }),
    graphiql: {
      title: "OpenClaw Hybrid Memory GraphQL API",
      defaultQuery: `# Welcome to OpenClaw Hybrid Memory GraphQL API
#
# Example queries:

# Get all facts with pagination
query GetFacts {
  facts(limit: 10, offset: 0) {
    id
    text
    category
    importance
    confidence
    createdAt
    tags
  }
}

# Search for memories
query SearchMemories {
  search(input: {
    query: "user preferences"
    limit: 5
  }) {
    fact {
      id
      text
      category
    }
    score
    matchType
  }
}

# Get memory statistics
query GetStats {
  stats {
    totalFacts
    activeFactsCount
    factsByCategory {
      category
      count
    }
  }
}

# Visualize memory graph
query GetGraph {
  graph(filter: {
    minImportance: 0.5
    categories: ["preference", "decision"]
  }) {
    nodes {
      id
      label
      category
      importance
    }
    edges {
      source
      target
      linkType
    }
  }
}

# Create a new fact
mutation CreateFact {
  createFact(input: {
    text: "User prefers dark mode"
    category: "preference"
    importance: 0.8
    tags: ["ui", "preference"]
  }) {
    id
    text
    createdAt
  }
}

# Subscribe to new facts (WebSocket)
subscription WatchNewFacts {
  factCreated(category: "preference") {
    id
    text
    category
  }
}
`,
    },
    cors: {
      origin: "*",
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
    },
    logging: {
      debug: (...args) => pluginLogger.debug(args.map(String).join(" ")),
      info: (...args) => pluginLogger.info(args.map(String).join(" ")),
      warn: (...args) => pluginLogger.warn(args.map(String).join(" ")),
      error: (...args) => pluginLogger.error(args.map(String).join(" ")),
    },
  });

  return { yoga, pubSub };
}

/**
 * Publish fact created event
 */
export function publishFactCreated(
  pubSub: ReturnType<typeof createPubSub>,
  fact: unknown,
  category?: string,
  scope?: string,
) {
  pubSub.publish("factCreated", { fact, category, scope });
}

/**
 * Publish fact updated event
 */
export function publishFactUpdated(pubSub: ReturnType<typeof createPubSub>, fact: unknown) {
  pubSub.publish("factUpdated", { fact });
}

/**
 * Publish fact deleted event
 */
export function publishFactDeleted(pubSub: ReturnType<typeof createPubSub>, id: string, category?: string) {
  pubSub.publish("factDeleted", { id, category });
}

/**
 * Publish stats updated event
 */
export function publishStatsUpdated(pubSub: ReturnType<typeof createPubSub>, stats: unknown) {
  pubSub.publish("statsUpdated", { stats });
}
