// @ts-nocheck
/**
 * Tests for multi-model retrieval integration (Issue #158).
 *
 * Tests RRF merge across models, single-model fallback, and the cosine similarity
 * search in the fact_embeddings table. No actual Ollama/OpenAI instances required.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import {
	type FactsDbWithEmbeddings,
	runRetrievalPipeline,
} from "../services/retrieval-orchestrator.js";

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeMockProvider(
	modelName: string,
	dims: number,
	vec?: number[],
): EmbeddingProvider {
	const vector = vec ?? Array.from({ length: dims }, (_, i) => (i + 1) / dims);
	return {
		modelName,
		dimensions: dims,
		embed: vi.fn().mockResolvedValue(vector),
		embedBatch: vi.fn().mockResolvedValue([vector]),
	};
}

/** Mock VectorDB that returns empty results (no LanceDB needed). */
function makeMockVectorDb(): VectorDB {
	return {
		search: vi.fn().mockResolvedValue([]),
		add: vi.fn().mockResolvedValue(undefined),
		addBatch: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		count: vi.fn().mockResolvedValue(0),
	} as unknown as VectorDB;
}

function storeTestFact(db: FactsDB, text: string): string {
	const result = db.store({
		text,
		category: "fact",
		importance: 0.7,
		source: "test",
		entity: null,
		key: null,
		value: null,
	});
	return result.id;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "multi-model-retrieval-test-"));
	factsDb = new FactsDB(join(tmpDir, "test.db"));
});

afterEach(() => {
	factsDb.close();
	rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// FactsDbWithEmbeddings interface compliance
// ---------------------------------------------------------------------------

describe("FactsDB satisfies FactsDbWithEmbeddings", () => {
	it("has getEmbeddingsByModel method", () => {
		expect(typeof factsDb.getEmbeddingsByModel).toBe("function");
	});

	it("getEmbeddingsByModel returns typed records", () => {
		const factId = storeTestFact(factsDb, "test fact");
		factsDb.storeEmbedding(
			factId,
			"domain-model",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);

		const results = factsDb.getEmbeddingsByModel("domain-model");
		expect(results).toHaveLength(1);
		expect(results[0].factId).toBe(factId);
		expect(results[0].embedding).toBeInstanceOf(Float32Array);
	});
});

// ---------------------------------------------------------------------------
// EmbeddingRegistry — multi-model RRF integration
// ---------------------------------------------------------------------------

describe("EmbeddingRegistry isMultiModel()", () => {
	it("returns false with no additional models", () => {
		const primary = makeMockProvider("text-embedding-3-small", 4);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
		expect(registry.isMultiModel()).toBe(false);
	});

	it("returns true with one or more additional models", () => {
		const primary = makeMockProvider("text-embedding-3-small", 4);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
				text: async () => "",
			}),
		);

		registry.register({
			name: "nomic-embed-text",
			provider: "ollama",
			dimensions: 3,
			role: "domain",
		});
		expect(registry.isMultiModel()).toBe(true);

		vi.unstubAllGlobals();
	});
});

// ---------------------------------------------------------------------------
// runRetrievalPipeline — single-model fallback (backward compat)
// ---------------------------------------------------------------------------

describe("runRetrievalPipeline — single-model backward compatibility", () => {
	it("runs without embeddingRegistry parameter", async () => {
		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"test query",
			null,
			rawDb,
			vectorDb,
			factsDb,
		);

		expect(result).toHaveProperty("fused");
		expect(result).toHaveProperty("packed");
		expect(result).toHaveProperty("entries");
		expect(result.fused).toHaveLength(0); // no facts stored, empty result
	});

	it("returns empty result when no facts are stored", async () => {
		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"anything",
			null,
			rawDb,
			vectorDb,
			factsDb,
		);

		expect(result.fused).toHaveLength(0);
		expect(result.packed).toHaveLength(0);
		expect(result.tokensUsed).toBe(0);
	});

	it("does not break when embeddingRegistry is null", async () => {
		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"test",
			null,
			rawDb,
			vectorDb,
			factsDb,
			{
				embeddingRegistry: null,
				factsDbForEmbeddings: null,
			},
		);

		expect(result).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Multi-model cosine similarity search
// ---------------------------------------------------------------------------

describe("Multi-model semantic search via fact_embeddings", () => {
	it("finds facts when query vector matches stored embedding", async () => {
		// Store a fact and its embedding
		const factId = storeTestFact(factsDb, "The user prefers dark mode");
		// A unit vector along first dimension
		factsDb.storeEmbedding(
			factId,
			"nomic-embed-text",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);

		// Primary provider returns zero vector (won't match anything via LanceDB mock)
		const primary = makeMockProvider("text-embedding-3-small", 4, [0, 0, 0, 0]);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

		// Additional model returns a vector that matches what we stored
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ embeddings: [[1, 0, 0, 0]] }), // perfect match
			text: async () => "",
		} as Response);
		vi.stubGlobal("fetch", mockFetch);

		registry.register({
			name: "nomic-embed-text",
			provider: "ollama",
			dimensions: 4,
			role: "domain",
		});

		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"dark mode preference",
			null, // skip primary semantic (no LanceDB)
			rawDb,
			vectorDb,
			factsDb,
			{
				config: {
					strategies: ["semantic", "fts5"],
					rrf_k: 60,
					ambientBudgetTokens: 2000,
					explicitBudgetTokens: 4000,
					graphWalkDepth: 0,
					semanticTopK: 10,
					fts5TopK: 10,
				},
				budgetTokens: 4000,
				aliasDb: null,
				embeddingRegistry: registry,
				factsDbForEmbeddings: factsDb,
			},
		);

		// The fact should be found via multi-model semantic search
		const foundIds = result.fused.map((r) => r.factId);
		expect(foundIds).toContain(factId);

		vi.unstubAllGlobals();
	});

	it("excludes facts with low cosine similarity (below 0.3 threshold)", async () => {
		const factId = storeTestFact(factsDb, "Orthogonal fact");
		// Orthogonal vector: [0, 1, 0, 0] vs query [1, 0, 0, 0] → cosine = 0
		factsDb.storeEmbedding(
			factId,
			"nomic-embed-text",
			"canonical",
			new Float32Array([0, 1, 0, 0]),
			4,
		);

		const primary = makeMockProvider("text-embedding-3-small", 4, [0, 0, 0, 0]);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ embeddings: [[1, 0, 0, 0]] }), // query vector
			text: async () => "",
		} as Response);
		vi.stubGlobal("fetch", mockFetch);

		registry.register({
			name: "nomic-embed-text",
			provider: "ollama",
			dimensions: 4,
			role: "domain",
		});

		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"orthogonal query",
			null,
			rawDb,
			vectorDb,
			factsDb,
			{
				config: {
					strategies: ["semantic"],
					rrf_k: 60,
					ambientBudgetTokens: 2000,
					explicitBudgetTokens: 4000,
					graphWalkDepth: 0,
					semanticTopK: 10,
					fts5TopK: 10,
				},
				budgetTokens: 4000,
				aliasDb: null,
				embeddingRegistry: registry,
				factsDbForEmbeddings: factsDb,
			},
		);

		// Orthogonal vectors → no match above threshold
		const foundIds = result.fused.map((r) => r.factId);
		expect(foundIds).not.toContain(factId);

		vi.unstubAllGlobals();
	});

	it("merges results from multiple models via RRF", async () => {
		const factA = storeTestFact(factsDb, "Python programming tips");
		const factB = storeTestFact(factsDb, "TypeScript best practices");

		// factA is aligned with model-1 query; factB is aligned with model-2 query
		factsDb.storeEmbedding(
			factA,
			"model-1",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);
		factsDb.storeEmbedding(
			factB,
			"model-2",
			"canonical",
			new Float32Array([0, 1, 0, 0]),
			4,
		);

		const primary = makeMockProvider("text-embedding-3-small", 4, [0, 0, 0, 0]);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

		let callCount = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			callCount++;
			// First model query → matches factA; second → matches factB
			const vec = callCount === 1 ? [1, 0, 0, 0] : [0, 1, 0, 0];
			return Promise.resolve({
				ok: true,
				json: async () => ({ embeddings: [vec] }),
				text: async () => "",
			} as Response);
		});
		vi.stubGlobal("fetch", mockFetch);

		registry.register({
			name: "model-1",
			provider: "ollama",
			dimensions: 4,
			role: "general",
		});
		registry.register({
			name: "model-2",
			provider: "ollama",
			dimensions: 4,
			role: "domain",
		});

		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"programming",
			null,
			rawDb,
			vectorDb,
			factsDb,
			{
				config: {
					strategies: ["semantic"],
					rrf_k: 60,
					ambientBudgetTokens: 2000,
					explicitBudgetTokens: 4000,
					graphWalkDepth: 0,
					semanticTopK: 10,
					fts5TopK: 10,
				},
				budgetTokens: 4000,
				aliasDb: null,
				embeddingRegistry: registry,
				factsDbForEmbeddings: factsDb,
			},
		);

		const foundIds = result.fused.map((r) => r.factId);
		// Both facts should appear in fused results (from different model lanes)
		expect(foundIds).toContain(factA);
		expect(foundIds).toContain(factB);

		vi.unstubAllGlobals();
	});

	it("RRF ordering: fact appearing in both models ranks above facts appearing in only one", async () => {
		// factShared is embedded under both model-1 and model-2
		// factOnlyA is embedded under model-1 only
		// factOnlyB is embedded under model-2 only
		//
		// When each model ranks factShared at position 1 and the single-model fact at position 2:
		//   factShared RRF score = 1/(60+1) + 1/(60+1) ≈ 0.0328  (appears in 2 strategies)
		//   factOnlyA  RRF score = 1/(60+2)             ≈ 0.0161  (appears in 1 strategy)
		//   factOnlyB  RRF score = 1/(60+2)             ≈ 0.0161  (appears in 1 strategy)
		// Expected order: factShared first, then factOnlyA and factOnlyB (tied, any order).

		const factShared = storeTestFact(factsDb, "Machine learning fundamentals");
		const factOnlyA = storeTestFact(factsDb, "Python syntax guide");
		const factOnlyB = storeTestFact(factsDb, "Neural network architecture");

		// model-1 embedding space: factShared ≈ query, factOnlyA second
		factsDb.storeEmbedding(
			factShared,
			"model-1",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);
		factsDb.storeEmbedding(
			factOnlyA,
			"model-1",
			"canonical",
			new Float32Array([0.9, 0.1, 0, 0]),
			4,
		);

		// model-2 embedding space: factShared ≈ query, factOnlyB second
		factsDb.storeEmbedding(
			factShared,
			"model-2",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);
		factsDb.storeEmbedding(
			factOnlyB,
			"model-2",
			"canonical",
			new Float32Array([0.9, 0.1, 0, 0]),
			4,
		);

		const primary = makeMockProvider("text-embedding-3-small", 4, [0, 0, 0, 0]);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

		// Both models embed the query as [1, 0, 0, 0] — pointing toward factShared
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ embeddings: [[1, 0, 0, 0]] }),
			text: async () => "",
		} as Response);
		vi.stubGlobal("fetch", mockFetch);

		registry.register({
			name: "model-1",
			provider: "ollama",
			dimensions: 4,
			role: "general",
		});
		registry.register({
			name: "model-2",
			provider: "ollama",
			dimensions: 4,
			role: "domain",
		});

		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"machine learning",
			null,
			rawDb,
			vectorDb,
			factsDb,
			{
				config: {
					strategies: ["semantic"],
					rrf_k: 60,
					ambientBudgetTokens: 2000,
					explicitBudgetTokens: 4000,
					graphWalkDepth: 0,
					semanticTopK: 10,
					fts5TopK: 10,
				},
				budgetTokens: 4000,
				aliasDb: null,
				embeddingRegistry: registry,
				factsDbForEmbeddings: factsDb,
			},
		);

		const foundIds = result.fused.map((r) => r.factId);

		// All three facts must be present in the fused results
		expect(foundIds).toContain(factShared);
		expect(foundIds).toContain(factOnlyA);
		expect(foundIds).toContain(factOnlyB);

		// factShared must appear before both single-model facts (RRF cross-model boost)
		const idxShared = foundIds.indexOf(factShared);
		const idxOnlyA = foundIds.indexOf(factOnlyA);
		const idxOnlyB = foundIds.indexOf(factOnlyB);
		expect(idxShared).toBeLessThan(idxOnlyA);
		expect(idxShared).toBeLessThan(idxOnlyB);

		// Verify the raw RRF scores satisfy the expected math
		const scoreShared = result.fused.find(
			(r) => r.factId === factShared,
		)?.rrfScore;
		const scoreOnlyA = result.fused.find(
			(r) => r.factId === factOnlyA,
		)?.rrfScore;
		const scoreOnlyB = result.fused.find(
			(r) => r.factId === factOnlyB,
		)?.rrfScore;

		// factShared gets contributions from two model lanes; each single-model fact gets one
		expect(scoreShared).toBeGreaterThan(scoreOnlyA);
		expect(scoreShared).toBeGreaterThan(scoreOnlyB);

		// The two single-model facts were each ranked #2 in their respective model lanes
		const expectedSingleScore = 1 / (60 + 2);
		expect(scoreOnlyA).toBeCloseTo(expectedSingleScore, 5);
		expect(scoreOnlyB).toBeCloseTo(expectedSingleScore, 5);

		// factShared gets rank-1 contribution from both model-1 and model-2
		const expectedSharedScore = 1 / (60 + 1) + 1 / (60 + 1);
		expect(scoreShared).toBeCloseTo(expectedSharedScore, 5);

		vi.unstubAllGlobals();
	});

	it("skips multi-model search when registry has no additional models", async () => {
		const factId = storeTestFact(factsDb, "test");
		factsDb.storeEmbedding(
			factId,
			"nomic-embed-text",
			"canonical",
			new Float32Array([1, 0, 0, 0]),
			4,
		);

		const primary = makeMockProvider("text-embedding-3-small", 4, [0, 0, 0, 0]);
		const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
		// No additional models registered → isMultiModel() = false

		const rawDb = factsDb.getRawDb();
		const vectorDb = makeMockVectorDb();

		const result = await runRetrievalPipeline(
			"test",
			null,
			rawDb,
			vectorDb,
			factsDb,
			{
				config: {
					strategies: ["semantic"],
					rrf_k: 60,
					ambientBudgetTokens: 2000,
					explicitBudgetTokens: 4000,
					graphWalkDepth: 0,
					semanticTopK: 10,
					fts5TopK: 10,
				},
				budgetTokens: 4000,
				aliasDb: null,
				embeddingRegistry: registry,
				factsDbForEmbeddings: factsDb,
			},
		);

		// Single-model mode: no multi-model results (LanceDB also returns empty)
		expect(result.fused).toHaveLength(0);
	});
});
