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

type FactSubscriptionPayload = { fact: unknown; category?: string; scope?: string };
type FactUpdatedPayload = { fact: unknown; factId?: string; category?: string };
type FactDeletedPayload = { id: string; category?: string };
type LinkCreatedPayload = { link: unknown; sourceId?: string; targetId?: string };
type StatsUpdatedPayload = { stats: unknown };

// PubSub for subscriptions
const pubSub = createPubSub<{
  factCreated: [FactSubscriptionPayload];
  factUpdated: [FactUpdatedPayload];
  factDeleted: [FactDeletedPayload];
  linkCreated: [LinkCreatedPayload];
  statsUpdated: [StatsUpdatedPayload];
}>();

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function optionalMatches(expected: unknown, actual: unknown): boolean {
  return expected == null || expected === "" || actual === expected;
}

function factCategory(fact: unknown, fallback?: string): string | undefined {
  return typeof recordValue(fact, "category") === "string" ? (recordValue(fact, "category") as string) : fallback;
}

function factScope(fact: unknown, fallback?: string): string | undefined {
  return typeof recordValue(fact, "scope") === "string" ? (recordValue(fact, "scope") as string) : fallback;
}

function factId(fact: unknown): string | undefined {
  return typeof recordValue(fact, "id") === "string" ? (recordValue(fact, "id") as string) : undefined;
}

function linkEndpoint(link: unknown, key: "sourceId" | "targetId", fallback?: string): string | undefined {
  const direct = recordValue(link, key);
  return typeof direct === "string" ? direct : fallback;
}

export function matchesFactCreatedSubscription(
  payload: FactSubscriptionPayload,
  args: { category?: string; scope?: string },
): boolean {
  return (
    optionalMatches(args.category, factCategory(payload.fact, payload.category)) &&
    optionalMatches(args.scope, factScope(payload.fact, payload.scope))
  );
}

export function matchesFactUpdatedSubscription(
  payload: FactUpdatedPayload,
  args: { factId?: string; category?: string },
): boolean {
  return (
    optionalMatches(args.factId, payload.factId ?? factId(payload.fact)) &&
    optionalMatches(args.category, factCategory(payload.fact, payload.category))
  );
}

export function matchesFactDeletedSubscription(payload: FactDeletedPayload, args: { category?: string }): boolean {
  return optionalMatches(args.category, payload.category);
}

export function matchesLinkCreatedSubscription(
  payload: LinkCreatedPayload,
  args: { sourceId?: string; targetId?: string },
): boolean {
  return (
    optionalMatches(args.sourceId, linkEndpoint(payload.link, "sourceId", payload.sourceId)) &&
    optionalMatches(args.targetId, linkEndpoint(payload.link, "targetId", payload.targetId))
  );
}

async function* filterAsyncIterator<T>(source: AsyncIterable<T>, predicate: (payload: T) => boolean): AsyncIterable<T> {
  for await (const payload of source) {
    if (predicate(payload)) yield payload;
  }
}

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
            subscribe: (_parent: unknown, args: { category?: string; scope?: string }) =>
              filterAsyncIterator(pubSub.subscribe("factCreated"), (payload) =>
                matchesFactCreatedSubscription(payload, args),
              ),
            resolve: (payload: FactSubscriptionPayload) => payload.fact,
          },
          factUpdated: {
            subscribe: (_parent: unknown, args: { factId?: string; category?: string }) =>
              filterAsyncIterator(pubSub.subscribe("factUpdated"), (payload) =>
                matchesFactUpdatedSubscription(payload, args),
              ),
            resolve: (payload: FactUpdatedPayload) => payload.fact,
          },
          factDeleted: {
            subscribe: (_parent: unknown, args: { category?: string }) =>
              filterAsyncIterator(pubSub.subscribe("factDeleted"), (payload) =>
                matchesFactDeletedSubscription(payload, args),
              ),
            resolve: (payload: FactDeletedPayload) => payload.id,
          },
          linkCreated: {
            subscribe: (_parent: unknown, args: { sourceId?: string; targetId?: string }) =>
              filterAsyncIterator(pubSub.subscribe("linkCreated"), (payload) =>
                matchesLinkCreatedSubscription(payload, args),
              ),
            resolve: (payload: LinkCreatedPayload) => payload.link,
          },
          statsUpdated: {
            subscribe: () => pubSub.subscribe("statsUpdated"),
            resolve: (payload: StatsUpdatedPayload) => payload.stats,
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
  pubSub.publish("factUpdated", { fact, factId: factId(fact), category: factCategory(fact) });
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
export function publishLinkCreated(pubSub: ReturnType<typeof createPubSub>, link: unknown) {
  pubSub.publish("linkCreated", {
    link,
    sourceId: linkEndpoint(link, "sourceId"),
    targetId: linkEndpoint(link, "targetId"),
  });
}

export function publishStatsUpdated(pubSub: ReturnType<typeof createPubSub>, stats: unknown) {
  pubSub.publish("statsUpdated", { stats });
}
