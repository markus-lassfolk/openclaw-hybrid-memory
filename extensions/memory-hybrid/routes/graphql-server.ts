/**
 * GraphQL Server for OpenClaw Hybrid Memory
 * Provides GraphQL API endpoint with subscriptions support
 */

import { createYoga, createPubSub } from "graphql-yoga";
import type { FactsDB } from "../backends/facts-db/facts-db-layer1.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryPluginContext } from "../api/memory-plugin-api.js";
import { graphqlSchema } from "./graphql-schema.js";
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
		schema: {
			typeDefs: graphqlSchema,
			resolvers: {
				...resolvers,
				Subscription: {
					factCreated: {
						subscribe: (_parent, args: { category?: string; scope?: string }) => {
							return pubSub.subscribe("factCreated", (payload) => {
								if (args.category && payload.category !== args.category) {
									return false;
								}
								if (args.scope && payload.scope !== args.scope) {
									return false;
								}
								return true;
							});
						},
						resolve: (payload: { fact: unknown }) => payload.fact,
					},
					factUpdated: {
						subscribe: (_parent, args: { factId?: string; category?: string }) => {
							return pubSub.subscribe("factUpdated", (payload: { fact: { id: string; category: string } }) => {
								if (args.factId && payload.fact.id !== args.factId) {
									return false;
								}
								if (args.category && payload.fact.category !== args.category) {
									return false;
								}
								return true;
							});
						},
						resolve: (payload: { fact: unknown }) => payload.fact,
					},
					factDeleted: {
						subscribe: (_parent, args: { category?: string }) => {
							return pubSub.subscribe("factDeleted", (payload) => {
								if (args.category && payload.category !== args.category) {
									return false;
								}
								return true;
							});
						},
						resolve: (payload: { id: string }) => payload.id,
					},
					linkCreated: {
						subscribe: (_parent, args: { sourceId?: string; targetId?: string }) => {
							return pubSub.subscribe("linkCreated", (payload: { link: { sourceId: string; targetId: string } }) => {
								if (args.sourceId && payload.link.sourceId !== args.sourceId) {
									return false;
								}
								if (args.targetId && payload.link.targetId !== args.targetId) {
									return false;
								}
								return true;
							});
						},
						resolve: (payload: { link: unknown }) => payload.link,
					},
					statsUpdated: {
						subscribe: () => pubSub.subscribe("statsUpdated"),
						resolve: (payload: { stats: unknown }) => payload.stats,
					},
				},
			},
		},
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
			credentials: true,
			methods: ["GET", "POST", "OPTIONS"],
		},
		logging: {
			debug: (...args) => console.log("[GraphQL]", ...args),
			info: (...args) => console.log("[GraphQL]", ...args),
			warn: (...args) => console.warn("[GraphQL]", ...args),
			error: (...args) => console.error("[GraphQL]", ...args),
		},
	});

	return { yoga, pubSub };
}

/**
 * Publish fact created event
 */
export function publishFactCreated(pubSub: ReturnType<typeof createPubSub>, fact: unknown, category?: string, scope?: string) {
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
