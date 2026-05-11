/**
 * GraphQL Resolvers for OpenClaw Hybrid Memory
 * Implements all query, mutation, and subscription resolvers
 */

import type { FactsDB } from "../backends/facts-db/facts-db-layer1.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryPluginContext } from "../api/memory-plugin-api.js";
import { searchHybrid } from "../services/search-hybrid.js";

export interface GraphQLContext {
	factsDb: FactsDB;
	vectorDb?: VectorDB;
	pluginContext: MemoryPluginContext;
}

interface GraphQLResolvers {
	Query: Record<string, (parent: unknown, args: unknown, context: GraphQLContext) => unknown>;
	Mutation: Record<string, (parent: unknown, args: unknown, context: GraphQLContext) => unknown>;
	Fact: Record<string, (parent: unknown, args: unknown, context: GraphQLContext) => unknown>;
	Link: Record<string, (parent: unknown, args: unknown, context: GraphQLContext) => unknown>;
	Episode: Record<string, (parent: unknown, args: unknown, context: GraphQLContext) => unknown>;
}

export const resolvers: GraphQLResolvers = {
	Query: {
		// Get a single fact by ID
		fact: async (_parent, args: { id: string }, context) => {
			const fact = context.factsDb.getFactById(args.id);
			return fact || null;
		},

		// Get multiple facts with filtering
		facts: async (_parent, args: {
			limit?: number;
			offset?: number;
			category?: string;
			decayClass?: string;
			tags?: string[];
			scope?: string;
			includeSuperseded?: boolean;
			includeExpired?: boolean;
		}, context) => {
			const { limit = 100, offset = 0, category, decayClass, tags, scope, includeSuperseded = false, includeExpired = false } = args;

			let facts = context.factsDb.getAllFacts();

			// Apply filters
			if (category) {
				facts = facts.filter(f => f.category === category);
			}
			if (decayClass) {
				facts = facts.filter(f => f.decayClass === decayClass);
			}
			if (tags && tags.length > 0) {
				facts = facts.filter(f => tags.some(tag => f.tags?.includes(tag)));
			}
			if (scope) {
				facts = facts.filter(f => f.scope === scope);
			}
			if (!includeSuperseded) {
				facts = facts.filter(f => !f.supersededBy);
			}
			if (!includeExpired) {
				const now = Date.now();
				facts = facts.filter(f => !f.expiresAt || f.expiresAt > now);
			}

			// Sort by createdAt descending
			facts.sort((a, b) => b.createdAt - a.createdAt);

			// Pagination
			return facts.slice(offset, offset + limit);
		},

		// Hybrid search
		search: async (_parent, args: { input: {
			query: string;
			categories?: string[];
			decayClasses?: string[];
			tags?: string[];
			minImportance?: number;
			minConfidence?: number;
			limit?: number;
			offset?: number;
			includeSuperseded?: boolean;
			includeExpired?: boolean;
			scope?: string;
			scopeTarget?: string;
		}}, context) => {
			const { input } = args;
			const { query, limit = 20, offset = 0 } = input;

			// Use the hybrid search service
			const results = await searchHybrid({
				query,
				factsDb: context.factsDb,
				vectorDb: context.vectorDb,
				limit: limit + offset, // Get more for offset
				config: context.pluginContext.config,
			});

			// Apply filters and offset
			let filtered = results;
			if (input.categories) {
				filtered = filtered.filter(r => input.categories?.includes(r.fact.category));
			}
			if (input.minImportance !== undefined) {
				filtered = filtered.filter(r => r.fact.importance >= input.minImportance!);
			}
			if (input.minConfidence !== undefined) {
				filtered = filtered.filter(r => r.fact.confidence >= input.minConfidence!);
			}

			return filtered.slice(offset, offset + limit).map(r => ({
				fact: r.fact,
				score: r.score,
				matchType: r.backend || "hybrid",
				snippet: r.fact.text.substring(0, 200),
			}));
		},

		// Semantic search only
		semanticSearch: async (_parent, args: { query: string; limit?: number; scope?: string }, context) => {
			if (!context.vectorDb) {
				return [];
			}

			const { query, limit = 20, scope } = args;

			// This would call the vector search service
			// For now, delegate to hybrid search
			const results = await searchHybrid({
				query,
				factsDb: context.factsDb,
				vectorDb: context.vectorDb,
				limit,
				config: context.pluginContext.config,
			});

			return results.map(r => ({
				fact: r.fact,
				score: r.score,
				matchType: "semantic",
				snippet: r.fact.text.substring(0, 200),
			}));
		},

		// Entity lookup
		entityFacts: async (_parent, args: { entity: string; key?: string }, context) => {
			let facts = context.factsDb.getAllFacts();
			facts = facts.filter(f => f.entity === args.entity);
			if (args.key) {
				facts = facts.filter(f => f.key === args.key);
			}
			return facts;
		},

		// Statistics
		stats: async (_parent, _args, context) => {
			const allFacts = context.factsDb.getAllFacts();
			const now = Date.now();

			const activeFacts = allFacts.filter(f => !f.supersededBy && (!f.expiresAt || f.expiresAt > now));
			const expiredFacts = allFacts.filter(f => f.expiresAt && f.expiresAt <= now);
			const supersededFacts = allFacts.filter(f => f.supersededBy);

			// Count by category
			const categoryMap = new Map<string, number>();
			for (const fact of activeFacts) {
				categoryMap.set(fact.category, (categoryMap.get(fact.category) || 0) + 1);
			}

			// Count by decay class
			const decayMap = new Map<string, number>();
			for (const fact of activeFacts) {
				decayMap.set(fact.decayClass, (decayMap.get(fact.decayClass) || 0) + 1);
			}

			return {
				totalFacts: allFacts.length,
				activeFactsCount: activeFacts.length,
				expiredFactsCount: expiredFacts.length,
				supersededFactsCount: supersededFacts.length,
				factsByCategory: Array.from(categoryMap.entries()).map(([category, count]) => ({
					category,
					count,
				})),
				factsByDecayClass: Array.from(decayMap.entries()).map(([decayClass, count]) => ({
					decayClass,
					count,
				})),
				totalEpisodes: 0, // TODO: Add episode tracking
				totalLinks: 0, // TODO: Add link counting
				databaseSizeBytes: 0, // TODO: Get actual DB size
				oldestFactDate: allFacts.length > 0 ? Math.min(...allFacts.map(f => f.createdAt)) : null,
				newestFactDate: allFacts.length > 0 ? Math.max(...allFacts.map(f => f.createdAt)) : null,
			};
		},

		// Graph visualization
		graph: async (_parent, args: { filter?: {
			categories?: string[];
			decayClasses?: string[];
			minImportance?: number;
			linkTypes?: string[];
			maxDepth?: number;
			startNodeIds?: string[];
			scope?: string;
		}}, context) => {
			const { filter = {} } = args;
			let facts = context.factsDb.getAllFacts();

			// Apply filters
			if (filter.categories) {
				facts = facts.filter(f => filter.categories?.includes(f.category));
			}
			if (filter.decayClasses) {
				facts = facts.filter(f => filter.decayClasses?.includes(f.decayClass));
			}
			if (filter.minImportance !== undefined) {
				facts = facts.filter(f => f.importance >= filter.minImportance!);
			}
			if (filter.scope) {
				facts = facts.filter(f => f.scope === filter.scope);
			}

			// Build nodes
			const nodes = facts.map(f => ({
				id: f.id,
				label: f.text.substring(0, 50) + (f.text.length > 50 ? "..." : ""),
				category: f.category,
				importance: f.importance,
				confidence: f.confidence,
				decayClass: f.decayClass,
				factCount: 1,
			}));

			// Build edges from supersession relationships
			const edges = facts
				.filter(f => f.supersededBy)
				.map(f => ({
					source: f.id,
					target: f.supersededBy!,
					linkType: "supersedes",
					weight: 1.0,
				}));

			return { nodes, edges };
		},

		// Links
		links: async (_parent, args: { sourceId?: string; targetId?: string; linkType?: string }, _context) => {
			// TODO: Implement link storage and retrieval
			return [];
		},

		relatedFacts: async (_parent, args: { factId: string; maxDepth?: number; linkTypes?: string[] }, _context) => {
			// TODO: Implement graph traversal
			return [];
		},
	},

	Mutation: {
		// Create a new fact
		createFact: async (_parent, args: { input: {
			text: string;
			category?: string;
			importance?: number;
			confidence?: number;
			decayClass?: string;
			source?: string;
			tags?: string[];
			entity?: string;
			key?: string;
			value?: string;
			scope?: string;
			scopeTarget?: string;
			expiresAt?: number;
		}}, context) => {
			const { input } = args;

			const fact = {
				id: crypto.randomUUID(),
				text: input.text,
				category: input.category || "other",
				importance: input.importance ?? 0.5,
				confidence: input.confidence ?? 1.0,
				decayClass: input.decayClass || "episodic",
				source: input.source,
				tags: input.tags || [],
				entity: input.entity,
				key: input.key,
				value: input.value,
				scope: input.scope,
				scopeTarget: input.scopeTarget,
				createdAt: Date.now(),
				expiresAt: input.expiresAt,
			};

			await context.factsDb.store(fact);
			return fact;
		},

		// Update an existing fact
		updateFact: async (_parent, args: { input: {
			id: string;
			text?: string;
			category?: string;
			importance?: number;
			confidence?: number;
			tags?: string[];
			expiresAt?: number;
		}}, context) => {
			const { input } = args;
			const existing = context.factsDb.getFactById(input.id);

			if (!existing) {
				throw new Error(`Fact not found: ${input.id}`);
			}

			const updated = {
				...existing,
				...(input.text !== undefined && { text: input.text }),
				...(input.category !== undefined && { category: input.category }),
				...(input.importance !== undefined && { importance: input.importance }),
				...(input.confidence !== undefined && { confidence: input.confidence }),
				...(input.tags !== undefined && { tags: input.tags }),
				...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
				updatedAt: Date.now(),
			};

			await context.factsDb.store(updated);
			return updated;
		},

		// Delete a fact
		deleteFact: async (_parent, args: { id: string }, context) => {
			const fact = context.factsDb.getFactById(args.id);
			if (!fact) {
				return false;
			}
			context.factsDb.deleteFact(args.id);
			return true;
		},

		// Supersede an old fact with a new one
		supersedeFact: async (_parent, args: { oldFactId: string; newFactId: string }, context) => {
			const oldFact = context.factsDb.getFactById(args.oldFactId);
			const newFact = context.factsDb.getFactById(args.newFactId);

			if (!oldFact || !newFact) {
				throw new Error("Fact not found");
			}

			const updated = {
				...oldFact,
				supersededBy: args.newFactId,
				updatedAt: Date.now(),
			};

			await context.factsDb.store(updated);
			return newFact;
		},

		// Import multiple facts
		importFacts: async (_parent, args: { facts: Array<{
			text: string;
			category?: string;
			importance?: number;
			[key: string]: unknown;
		}>}, context) => {
			const created = [];

			for (const input of args.facts) {
				const fact = {
					id: crypto.randomUUID(),
					text: input.text,
					category: input.category || "other",
					importance: input.importance ?? 0.5,
					confidence: 1.0,
					decayClass: "episodic",
					tags: [],
					createdAt: Date.now(),
				};

				await context.factsDb.store(fact);
				created.push(fact);
			}

			return created;
		},

		// Prune old facts
		pruneFacts: async (_parent, args: { olderThan?: number; category?: string }, context) => {
			const facts = context.factsDb.getAllFacts();
			let toDelete = facts;

			if (args.olderThan) {
				toDelete = toDelete.filter(f => f.createdAt < args.olderThan!);
			}
			if (args.category) {
				toDelete = toDelete.filter(f => f.category === args.category);
			}

			for (const fact of toDelete) {
				context.factsDb.deleteFact(fact.id);
			}

			return toDelete.length;
		},
	},

	// Field resolvers for Fact type
	Fact: {
		links: async (parent: { id: string }, _args, _context) => {
			// TODO: Get outgoing links
			return [];
		},
		linkedFrom: async (parent: { id: string }, _args, _context) => {
			// TODO: Get incoming links
			return [];
		},
		supersedes: async (parent: { supersededBy?: string }, _args, context) => {
			if (!parent.supersededBy) return null;
			return context.factsDb.getFactById(parent.supersededBy) || null;
		},
		supersededByFact: async (parent: { id: string }, _args, context) => {
			const facts = context.factsDb.getAllFacts();
			return facts.find(f => f.supersededBy === parent.id) || null;
		},
	},

	// Field resolvers for Link type
	Link: {
		source: async (parent: { sourceId: string }, _args, context) => {
			return context.factsDb.getFactById(parent.sourceId);
		},
		target: async (parent: { targetId: string }, _args, context) => {
			return context.factsDb.getFactById(parent.targetId);
		},
	},

	// Field resolvers for Episode type
	Episode: {
		facts: async (parent: { id: string }, _args, _context) => {
			// TODO: Implement episode-fact relationships
			return [];
		},
	},
};
