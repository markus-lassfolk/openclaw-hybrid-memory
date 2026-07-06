/**
 * GraphQL Server for OpenClaw Hybrid Memory
 * Provides GraphQL API endpoint with subscriptions support
 */

interface MemoryPluginContext {
  config?: unknown;
  [key: string]: unknown;
}

import { createSchema, createYoga, type YogaInitialContext } from "graphql-yoga";
import type { FactsDB } from "../backends/facts-db.js";
import { scopedRowMatchesFilter } from "../backends/facts-db/scope-sql.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryScope, ScopeFilter } from "../types/memory.js";
import { graphqlSchema } from "./graphql-schema.js";
import { graphqlPubSub } from "./graphql-pubsub.js";
import { pluginLogger } from "../utils/logger.js";
import { scopeFilterFromIdentityHeaders } from "../utils/scope-filter.js";
import { isLinkVisible, resolvers, type GraphQLContext } from "./graphql-resolvers.js";

type FactSubscriptionPayload = { fact: unknown; category?: string; scope?: string };
type FactUpdatedPayload = { fact: unknown; factId?: string; category?: string };
type FactDeletedPayload = { id: string; category?: string; scope?: string; scopeTarget?: string | null };
type LinkCreatedPayload = { link: unknown; sourceId?: string; targetId?: string };
type StatsUpdatedPayload = { stats: unknown };

const pubSub = graphqlPubSub;

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

function factScopeTarget(fact: unknown, fallback?: string | null): string | null | undefined {
  const v = recordValue(fact, "scopeTarget");
  return typeof v === "string" || v === null ? (v as string | null) : fallback;
}

/**
 * SECURITY: every subscription payload carries a live fact/link — never trust the schema
 * argument filters alone (matchesFactCreatedSubscription etc. only filter on caller-supplied
 * category/scope, which defaults to "match everything" when omitted). This re-derives
 * visibility from the caller's own resolved scopeFilter, same as every query resolver.
 */
export function isFactPayloadVisible(
  fact: unknown,
  fallbackScope: string | undefined,
  scopeFilter: ScopeFilter,
): boolean {
  const scope = (factScope(fact, fallbackScope) ?? "global") as MemoryScope;
  return scopedRowMatchesFilter(scope, factScopeTarget(fact) ?? null, scopeFilter);
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
            subscribe: (_parent: unknown, args: { category?: string; scope?: string }, context: GraphQLContext) =>
              filterAsyncIterator(
                pubSub.subscribe("factCreated"),
                (payload) =>
                  matchesFactCreatedSubscription(payload, args) &&
                  isFactPayloadVisible(payload.fact, payload.scope, context.scopeFilter),
              ),
            resolve: (payload: FactSubscriptionPayload) => payload.fact,
          },
          factUpdated: {
            subscribe: (_parent: unknown, args: { factId?: string; category?: string }, context: GraphQLContext) =>
              filterAsyncIterator(
                pubSub.subscribe("factUpdated"),
                (payload) =>
                  matchesFactUpdatedSubscription(payload, args) &&
                  isFactPayloadVisible(payload.fact, undefined, context.scopeFilter),
              ),
            resolve: (payload: FactUpdatedPayload) => payload.fact,
          },
          factDeleted: {
            subscribe: (_parent: unknown, args: { category?: string }, context: GraphQLContext) =>
              filterAsyncIterator(
                pubSub.subscribe("factDeleted"),
                (payload) =>
                  matchesFactDeletedSubscription(payload, args) &&
                  scopedRowMatchesFilter(
                    (payload.scope ?? "global") as MemoryScope,
                    payload.scopeTarget ?? null,
                    context.scopeFilter,
                  ),
              ),
            resolve: (payload: FactDeletedPayload) => payload.id,
          },
          linkCreated: {
            subscribe: (_parent: unknown, args: { sourceId?: string; targetId?: string }, context: GraphQLContext) =>
              filterAsyncIterator(pubSub.subscribe("linkCreated"), (payload) => {
                const sourceId = linkEndpoint(payload.link, "sourceId", payload.sourceId);
                const targetId = linkEndpoint(payload.link, "targetId", payload.targetId);
                return (
                  matchesLinkCreatedSubscription(payload, args) &&
                  !!sourceId &&
                  !!targetId &&
                  isLinkVisible(context.factsDb, { sourceId, targetId }, context.scopeFilter)
                );
              }),
            resolve: (payload: LinkCreatedPayload) => payload.link,
          },
          statsUpdated: {
            // Unlike the fact/link subscriptions above, this has no scope filter — `stats` is an
            // opaque, scope-less payload today (see publishStatsUpdated below) and there is
            // currently no publisher wired up anywhere in the plugin. If a per-tenant stats
            // feature is ever built, its payload will need scope info attached so this can gate
            // on context.scopeFilter the same way the other subscriptions do.
            subscribe: () => pubSub.subscribe("statsUpdated"),
            resolve: (payload: StatsUpdatedPayload) => payload.stats,
          },
        },
      },
    }),
    context: (initialContext: YogaInitialContext): GraphQLContext => ({
      factsDb,
      vectorDb,
      pluginContext,
      // SECURITY: resolvers must scope every fact read through this filter — see resolveScopeFilter
      // in tools/public-api-routes.ts for the REST equivalent. Missing identity headers default to
      // global-only visibility (fail closed), matching the REST API's behavior.
      scopeFilter: scopeFilterFromIdentityHeaders((name) => initialContext.request.headers.get(name)),
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
    // The dashboard's own graph explorer calls this endpoint via a same-origin relative
    // fetch('/graphql', ...) — no legitimate caller needs cross-origin access. A wildcard
    // origin here would let any webpage open in the same browser read the full memory store
    // via fetch() (classic localhost CSRF pattern), since reads require no auth token.
    // Disabling CORS means the browser enforces same-origin policy on responses instead.
    cors: false,
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
export function publishFactCreated(pubSub: typeof graphqlPubSub, fact: unknown, category?: string, scope?: string) {
  pubSub.publish("factCreated", { fact, category, scope });
}

/**
 * Publish fact updated event
 */
export function publishFactUpdated(pubSub: typeof graphqlPubSub, fact: unknown) {
  pubSub.publish("factUpdated", { fact, factId: factId(fact), category: factCategory(fact) });
}

/**
 * Publish fact deleted event
 */
export function publishFactDeleted(pubSub: typeof graphqlPubSub, id: string, category?: string) {
  pubSub.publish("factDeleted", { id, category });
}

/**
 * Publish stats updated event
 */
export function publishLinkCreated(pubSub: typeof graphqlPubSub, link: unknown) {
  pubSub.publish("linkCreated", {
    link,
    sourceId: linkEndpoint(link, "sourceId"),
    targetId: linkEndpoint(link, "targetId"),
  });
}

export function publishStatsUpdated(pubSub: typeof graphqlPubSub, stats: unknown) {
  pubSub.publish("statsUpdated", { stats });
}
