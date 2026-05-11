/**
 * OpenClaw Hybrid Memory Client SDK
 * Official TypeScript/JavaScript SDK for interacting with OpenClaw Hybrid Memory
 */

export interface MemoryClientConfig {
	/** Base URL for the memory API (default: http://localhost:7777) */
	baseUrl?: string;
	/** GraphQL endpoint path (default: /plugins/memory/graphql) */
	graphqlPath?: string;
	/** API key for authentication (if required) */
	apiKey?: string;
	/** Request timeout in milliseconds */
	timeout?: number;
}

export interface Fact {
	id: string;
	text: string;
	category: string;
	importance: number;
	confidence: number;
	decayClass: string;
	source?: string;
	tags: string[];
	createdAt: number;
	updatedAt?: number;
	expiresAt?: number;
	supersededBy?: string;
	entity?: string;
	key?: string;
	value?: string;
	scope?: string;
	scopeTarget?: string;
	metadata?: Record<string, unknown>;
}

export interface SearchResult {
	fact: Fact;
	score: number;
	matchType: string;
	snippet?: string;
}

export interface MemoryStats {
	totalFacts: number;
	activeFactsCount: number;
	expiredFactsCount: number;
	supersededFactsCount: number;
	factsByCategory: Array<{ category: string; count: number }>;
	factsByDecayClass: Array<{ decayClass: string; count: number }>;
	totalEpisodes: number;
	totalLinks: number;
	databaseSizeBytes: number;
	oldestFactDate?: number;
	newestFactDate?: number;
}

export interface GraphNode {
	id: string;
	label: string;
	category: string;
	importance: number;
	confidence: number;
	decayClass: string;
}

export interface GraphEdge {
	source: string;
	target: string;
	linkType: string;
	weight: number;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface CreateFactInput {
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
}

export interface SearchInput {
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
}

export interface GraphFilterInput {
	categories?: string[];
	decayClasses?: string[];
	minImportance?: number;
	linkTypes?: string[];
	maxDepth?: number;
	startNodeIds?: string[];
	scope?: string;
}

/**
 * OpenClaw Memory Client
 * Main SDK class for interacting with OpenClaw Hybrid Memory
 */
export class MemoryClient {
	private baseUrl: string;
	private graphqlPath: string;
	private apiKey?: string;
	private timeout: number;

	constructor(config: MemoryClientConfig = {}) {
		this.baseUrl = config.baseUrl || "http://localhost:7777";
		this.graphqlPath = config.graphqlPath || "/plugins/memory/graphql";
		this.apiKey = config.apiKey;
		this.timeout = config.timeout || 30000;
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey) {
			headers["Authorization"] = `Bearer ${this.apiKey}`;
		}
		return headers;
	}

	private async graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
		const url = `${this.baseUrl}${this.graphqlPath}`;
		const response = await fetch(url, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(this.timeout),
		});

		if (!response.ok) {
			throw new Error(`GraphQL request failed: ${response.statusText}`);
		}

		const result = await response.json();
		if (result.errors) {
			throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
		}

		return result.data;
	}

	/**
	 * Get a single fact by ID
	 */
	async getFact(id: string): Promise<Fact | null> {
		const query = `
			query GetFact($id: ID!) {
				fact(id: $id) {
					id text category importance confidence decayClass
					source tags createdAt updatedAt expiresAt supersededBy
					entity key value scope scopeTarget
				}
			}
		`;
		const data = await this.graphqlRequest<{ fact: Fact | null }>(query, { id });
		return data.fact;
	}

	/**
	 * Get multiple facts with filtering and pagination
	 */
	async getFacts(options: {
		limit?: number;
		offset?: number;
		category?: string;
		decayClass?: string;
		tags?: string[];
		scope?: string;
		includeSuperseded?: boolean;
		includeExpired?: boolean;
	} = {}): Promise<Fact[]> {
		const query = `
			query GetFacts(
				$limit: Int
				$offset: Int
				$category: String
				$decayClass: String
				$tags: [String!]
				$scope: String
				$includeSuperseded: Boolean
				$includeExpired: Boolean
			) {
				facts(
					limit: $limit
					offset: $offset
					category: $category
					decayClass: $decayClass
					tags: $tags
					scope: $scope
					includeSuperseded: $includeSuperseded
					includeExpired: $includeExpired
				) {
					id text category importance confidence decayClass
					source tags createdAt updatedAt expiresAt
					entity key value scope scopeTarget
				}
			}
		`;
		const data = await this.graphqlRequest<{ facts: Fact[] }>(query, options);
		return data.facts;
	}

	/**
	 * Search for memories using hybrid search
	 */
	async search(input: SearchInput): Promise<SearchResult[]> {
		const query = `
			query Search($input: SearchInput!) {
				search(input: $input) {
					fact {
						id text category importance confidence decayClass
						tags createdAt entity key value
					}
					score
					matchType
					snippet
				}
			}
		`;
		const data = await this.graphqlRequest<{ search: SearchResult[] }>(query, { input });
		return data.search;
	}

	/**
	 * Semantic search using vector similarity
	 */
	async semanticSearch(query: string, limit = 20, scope?: string): Promise<SearchResult[]> {
		const gqlQuery = `
			query SemanticSearch($query: String!, $limit: Int, $scope: String) {
				semanticSearch(query: $query, limit: $limit, scope: $scope) {
					fact {
						id text category importance confidence
						tags createdAt
					}
					score
					matchType
				}
			}
		`;
		const data = await this.graphqlRequest<{ semanticSearch: SearchResult[] }>(
			gqlQuery,
			{ query, limit, scope },
		);
		return data.semanticSearch;
	}

	/**
	 * Create a new fact
	 */
	async createFact(input: CreateFactInput): Promise<Fact> {
		const mutation = `
			mutation CreateFact($input: CreateFactInput!) {
				createFact(input: $input) {
					id text category importance confidence decayClass
					source tags createdAt entity key value scope scopeTarget
				}
			}
		`;
		const data = await this.graphqlRequest<{ createFact: Fact }>(mutation, { input });
		return data.createFact;
	}

	/**
	 * Update an existing fact
	 */
	async updateFact(input: {
		id: string;
		text?: string;
		category?: string;
		importance?: number;
		confidence?: number;
		tags?: string[];
		expiresAt?: number;
	}): Promise<Fact> {
		const mutation = `
			mutation UpdateFact($input: UpdateFactInput!) {
				updateFact(input: $input) {
					id text category importance confidence
					tags updatedAt expiresAt
				}
			}
		`;
		const data = await this.graphqlRequest<{ updateFact: Fact }>(mutation, { input });
		return data.updateFact;
	}

	/**
	 * Delete a fact
	 */
	async deleteFact(id: string): Promise<boolean> {
		const mutation = `
			mutation DeleteFact($id: ID!) {
				deleteFact(id: $id)
			}
		`;
		const data = await this.graphqlRequest<{ deleteFact: boolean }>(mutation, { id });
		return data.deleteFact;
	}

	/**
	 * Get memory statistics
	 */
	async getStats(): Promise<MemoryStats> {
		const query = `
			query GetStats {
				stats {
					totalFacts activeFactsCount expiredFactsCount supersededFactsCount
					factsByCategory { category count }
					factsByDecayClass { decayClass count }
					totalEpisodes totalLinks databaseSizeBytes
					oldestFactDate newestFactDate
				}
			}
		`;
		const data = await this.graphqlRequest<{ stats: MemoryStats }>(query);
		return data.stats;
	}

	/**
	 * Get graph visualization data
	 */
	async getGraph(filter?: GraphFilterInput): Promise<GraphData> {
		const query = `
			query GetGraph($filter: GraphFilterInput) {
				graph(filter: $filter) {
					nodes {
						id label category importance confidence decayClass
					}
					edges {
						source target linkType weight
					}
				}
			}
		`;
		const data = await this.graphqlRequest<{ graph: GraphData }>(query, { filter });
		return data.graph;
	}

	/**
	 * Get facts for a specific entity
	 */
	async getEntityFacts(entity: string, key?: string): Promise<Fact[]> {
		const query = `
			query GetEntityFacts($entity: String!, $key: String) {
				entityFacts(entity: $entity, key: $key) {
					id text category importance confidence
					entity key value createdAt tags
				}
			}
		`;
		const data = await this.graphqlRequest<{ entityFacts: Fact[] }>(query, { entity, key });
		return data.entityFacts;
	}

	/**
	 * Import multiple facts in batch
	 */
	async importFacts(facts: CreateFactInput[]): Promise<Fact[]> {
		const mutation = `
			mutation ImportFacts($facts: [CreateFactInput!]!) {
				importFacts(facts: $facts) {
					id text category createdAt
				}
			}
		`;
		const data = await this.graphqlRequest<{ importFacts: Fact[] }>(mutation, { facts });
		return data.importFacts;
	}

	/**
	 * Prune old facts
	 */
	async pruneFacts(olderThan?: number, category?: string): Promise<number> {
		const mutation = `
			mutation PruneFacts($olderThan: DateTime, $category: String) {
				pruneFacts(olderThan: $olderThan, category: $category)
			}
		`;
		const data = await this.graphqlRequest<{ pruneFacts: number }>(mutation, { olderThan, category });
		return data.pruneFacts;
	}
}

export default MemoryClient;
