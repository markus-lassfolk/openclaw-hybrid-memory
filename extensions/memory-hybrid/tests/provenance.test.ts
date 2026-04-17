import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { ProvenanceService } = _testing;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let service: InstanceType<typeof ProvenanceService>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "provenance-test-"));
	service = new ProvenanceService(join(tmpDir, "provenance.db"));
});

afterEach(() => {
	service.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. addEdge — basic insertion
// ---------------------------------------------------------------------------

describe("ProvenanceService.addEdge", () => {
	it("returns a non-empty string id", () => {
		const id = service.addEdge("fact-1", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-abc",
		});
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("returns unique ids for each addEdge call", () => {
		const id1 = service.addEdge("fact-1", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-1",
		});
		const id2 = service.addEdge("fact-1", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "session-2",
		});
		expect(id1).not.toBe(id2);
	});

	it("persists edge retrievable via getEdges", () => {
		service.addEdge("fact-2", {
			edgeType: "DERIVED_FROM",
			sourceType: "event_log",
			sourceId: "event-xyz",
			sourceText: "Original conversation snippet",
		});
		const edges = service.getEdges("fact-2");
		expect(edges).toHaveLength(1);
		expect(edges[0].factId).toBe("fact-2");
		expect(edges[0].edgeType).toBe("DERIVED_FROM");
		expect(edges[0].sourceType).toBe("event_log");
		expect(edges[0].sourceId).toBe("event-xyz");
		expect(edges[0].sourceText).toBe("Original conversation snippet");
	});

	it("stores sourceText as undefined when omitted", () => {
		service.addEdge("fact-3", {
			edgeType: "REFLECTED_FROM",
			sourceType: "reflection",
			sourceId: "reflection-001",
		});
		const edges = service.getEdges("fact-3");
		expect(edges[0].sourceText).toBeUndefined();
	});

	it("accepts all valid edgeType values", () => {
		const edgeTypes = [
			"DERIVED_FROM",
			"CONSOLIDATED_FROM",
			"REFLECTED_FROM",
		] as const;
		for (const edgeType of edgeTypes) {
			service.addEdge(`fact-${edgeType}`, {
				edgeType,
				sourceType: "active_store",
				sourceId: "s1",
			});
		}
		for (const edgeType of edgeTypes) {
			const edges = service.getEdges(`fact-${edgeType}`);
			expect(edges[0].edgeType).toBe(edgeType);
		}
	});

	it("accepts all valid sourceType values", () => {
		const sourceTypes = [
			"event_log",
			"active_store",
			"consolidation",
			"reflection",
		] as const;
		for (const sourceType of sourceTypes) {
			service.addEdge(`fact-src-${sourceType}`, {
				edgeType: "DERIVED_FROM",
				sourceType,
				sourceId: "s1",
			});
		}
		for (const sourceType of sourceTypes) {
			const edges = service.getEdges(`fact-src-${sourceType}`);
			expect(edges[0].sourceType).toBe(sourceType);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. getEdges — multiple edges per fact (consolidation from multiple sources)
// ---------------------------------------------------------------------------

describe("ProvenanceService.getEdges — multiple edges", () => {
	it("returns all edges for a fact with multiple provenance sources", () => {
		service.addEdge("merged-fact", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "fact-a",
			sourceText: "Fact A text",
		});
		service.addEdge("merged-fact", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "fact-b",
			sourceText: "Fact B text",
		});
		service.addEdge("merged-fact", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "fact-c",
			sourceText: "Fact C text",
		});
		const edges = service.getEdges("merged-fact");
		expect(edges).toHaveLength(3);
		const sourceIds = edges.map((e) => e.sourceId).sort();
		expect(sourceIds).toEqual(["fact-a", "fact-b", "fact-c"]);
	});

	it("returns empty array for unknown factId", () => {
		const edges = service.getEdges("nonexistent-fact");
		expect(edges).toHaveLength(0);
	});

	it("does not mix edges from different facts", () => {
		service.addEdge("fact-x", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-x",
		});
		service.addEdge("fact-y", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-y",
		});
		const edgesX = service.getEdges("fact-x");
		const edgesY = service.getEdges("fact-y");
		expect(edgesX).toHaveLength(1);
		expect(edgesX[0].sourceId).toBe("session-x");
		expect(edgesY).toHaveLength(1);
		expect(edgesY[0].sourceId).toBe("session-y");
	});

	it("edges are ordered chronologically (ASC)", () => {
		for (let i = 0; i < 3; i++) {
			service.addEdge("ordered-fact", {
				edgeType: "DERIVED_FROM",
				sourceType: "event_log",
				sourceId: `event-${i}`,
			});
		}
		const edges = service.getEdges("ordered-fact");
		expect(edges).toHaveLength(3);
		// created_at should be ascending
		for (let i = 1; i < edges.length; i++) {
			expect(edges[i].createdAt >= edges[i - 1].createdAt).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. getProvenance — full provenance chain
// ---------------------------------------------------------------------------

describe("ProvenanceService.getProvenance", () => {
	it("returns a ProvenanceChain with edges for a known fact", () => {
		service.addEdge("prov-fact-1", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-001",
			sourceText: "User said X",
		});
		const chain = service.getProvenance("prov-fact-1");
		expect(chain.fact.id).toBe("prov-fact-1");
		expect(chain.edges).toHaveLength(1);
		expect(chain.edges[0].edgeType).toBe("DERIVED_FROM");
		expect(chain.edges[0].sourceText).toBe("User said X");
	});

	it("returns empty edges array for fact with no provenance", () => {
		const chain = service.getProvenance("unknown-fact");
		expect(chain.edges).toHaveLength(0);
	});

	it("includes createdAt timestamp in each edge", () => {
		service.addEdge("ts-fact", {
			edgeType: "REFLECTED_FROM",
			sourceType: "reflection",
			sourceId: "reflect-001",
		});
		const chain = service.getProvenance("ts-fact");
		expect(chain.edges[0].createdAt).toBeDefined();
		expect(typeof chain.edges[0].createdAt).toBe("string");
		// Should be an ISO date string
		expect(new Date(chain.edges[0].createdAt).getTime()).toBeGreaterThan(0);
	});

	it("returns all multiple edges in the chain", () => {
		service.addEdge("multi-prov", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "src-1",
		});
		service.addEdge("multi-prov", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "src-2",
		});
		const chain = service.getProvenance("multi-prov");
		expect(chain.edges).toHaveLength(2);
	});

	it("source fields default to empty object when no factsDb is provided", () => {
		service.addEdge("no-db-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-x",
		});
		const chain = service.getProvenance("no-db-fact");
		expect(chain.source).toBeDefined();
		expect(chain.source.sessionId).toBeUndefined();
		expect(chain.source.turn).toBeUndefined();
		expect(chain.source.extractionMethod).toBeUndefined();
	});

	it("populates source fields when factsDb is provided with provenance columns", () => {
		service.addEdge("with-db-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "session-y",
		});
		const fakeFactsDb = {
			prepare: (_sql: string) => ({
				get: (factId: string) => {
					expect(factId).toBe("with-db-fact");
					return {
						id: "with-db-fact",
						text: "Fact text",
						confidence: 0.8,
						provenance_session: "sess-123",
						source_turn: 5,
						extraction_method: "llm_extraction",
						extraction_confidence: 0.87,
					};
				},
			}),
		};
		const chain = service.getProvenance("with-db-fact", fakeFactsDb as never);
		expect(chain.source).toBeDefined();
		expect(chain.source.sessionId).toBe("sess-123");
		expect(chain.source.turn).toBe(5);
		expect(chain.source.extractionMethod).toBe("llm_extraction");
		expect(chain.source.extractionConfidence).toBe(0.87);
	});
});

// ---------------------------------------------------------------------------
// 4. getFactsFromSource — reverse lookup
// ---------------------------------------------------------------------------

describe("ProvenanceService.getFactsFromSource", () => {
	it("returns all fact IDs derived from a specific source", () => {
		service.addEdge("fact-a1", {
			edgeType: "DERIVED_FROM",
			sourceType: "event_log",
			sourceId: "session-event-123",
		});
		service.addEdge("fact-a2", {
			edgeType: "DERIVED_FROM",
			sourceType: "event_log",
			sourceId: "session-event-123",
		});
		service.addEdge("fact-a3", {
			edgeType: "DERIVED_FROM",
			sourceType: "event_log",
			sourceId: "session-event-123",
		});
		const facts = service.getFactsFromSource("session-event-123");
		expect(facts.length).toBe(3);
		expect(facts).toContain("fact-a1");
		expect(facts).toContain("fact-a2");
		expect(facts).toContain("fact-a3");
	});

	it("returns empty array for unknown sourceId", () => {
		const facts = service.getFactsFromSource("no-such-source");
		expect(facts).toHaveLength(0);
	});

	it("does not return duplicate fact IDs when the same fact has multiple edges to the same source", () => {
		// Same fact, same source, two different edge types
		service.addEdge("dedup-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "shared-source",
		});
		service.addEdge("dedup-fact", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "shared-source",
		});
		const facts = service.getFactsFromSource("shared-source");
		// DISTINCT — should only appear once
		expect(facts.filter((f) => f === "dedup-fact").length).toBe(1);
	});

	it("does not mix facts from different sources", () => {
		service.addEdge("fact-src-a", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "source-A",
		});
		service.addEdge("fact-src-b", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "source-B",
		});
		const fromA = service.getFactsFromSource("source-A");
		const fromB = service.getFactsFromSource("source-B");
		expect(fromA).toContain("fact-src-a");
		expect(fromA).not.toContain("fact-src-b");
		expect(fromB).toContain("fact-src-b");
		expect(fromB).not.toContain("fact-src-a");
	});
});

// ---------------------------------------------------------------------------
// 5. prune — remove old edges, keep recent
// ---------------------------------------------------------------------------

describe("ProvenanceService.prune", () => {
	it("returns 0 when no edges are old enough to prune", () => {
		service.addEdge("recent-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "s1",
		});
		// 365 days retention: all recent edges should survive
		const pruned = service.prune(365);
		expect(pruned).toBe(0);
		expect(service.getEdges("recent-fact")).toHaveLength(1);
	});

	it("removes old edges and keeps recent ones", () => {
		// Insert an edge then manually backdate it
		service.addEdge("old-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "old-session",
		});
		service.addEdge("new-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "new-session",
		});

		// Backdate the old edge via internal DB access
		const db = (
			service as unknown as { db: import("node:sqlite").DatabaseSync }
		).db;
		db.prepare(
			`UPDATE provenance_edges SET created_at = '2020-01-01T00:00:00.000Z' WHERE fact_id = 'old-fact'`,
		).run();

		const pruned = service.prune(365); // Remove edges older than 365 days
		expect(pruned).toBe(1);
		expect(service.getEdges("old-fact")).toHaveLength(0);
		expect(service.getEdges("new-fact")).toHaveLength(1);
	});

	it("returns count of pruned edges", () => {
		for (let i = 0; i < 5; i++) {
			service.addEdge(`fact-prune-${i}`, {
				edgeType: "DERIVED_FROM",
				sourceType: "event_log",
				sourceId: `event-${i}`,
			});
		}
		const db = (
			service as unknown as { db: import("node:sqlite").DatabaseSync }
		).db;
		// Backdate all edges
		db.prepare(
			`UPDATE provenance_edges SET created_at = '2019-01-01T00:00:00.000Z'`,
		).run();

		const pruned = service.prune(365);
		expect(pruned).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// 6. Schema migration — provenance columns in facts table
// ---------------------------------------------------------------------------

describe("ProvenanceConfig defaults in config parsing", () => {
	it("defaults provenance.enabled to false when omitted", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
		});
		expect(cfg.provenance.enabled).toBe(false);
	});

	it("defaults provenance.retentionDays to 365", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
		});
		expect(cfg.provenance.retentionDays).toBe(365);
	});

	it("honors provenance.enabled when set to true", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
			provenance: { enabled: true },
		});
		expect(cfg.provenance.enabled).toBe(true);
	});

	it("parses custom retentionDays from config", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
			provenance: { enabled: true, retentionDays: 180 },
		});
		expect(cfg.provenance.retentionDays).toBe(180);
	});

	it("falls back to 365 when retentionDays is 0 or negative", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
			provenance: { retentionDays: 0 },
		});
		expect(cfg.provenance.retentionDays).toBe(365);
	});

	it("floor-rounds fractional retentionDays", () => {
		const cfg = hybridConfigSchema.parse({
			embedding: {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
			},
			provenance: { retentionDays: 90.9 },
		});
		expect(cfg.provenance.retentionDays).toBe(90);
	});
});

// ---------------------------------------------------------------------------
// 7. ProvenanceChain includes all metadata
// ---------------------------------------------------------------------------

describe("ProvenanceChain structure", () => {
	it("chain.fact.id matches the queried factId", () => {
		service.addEdge("chain-fact", {
			edgeType: "DERIVED_FROM",
			sourceType: "active_store",
			sourceId: "sess-1",
		});
		const chain = service.getProvenance("chain-fact");
		expect(chain.fact.id).toBe("chain-fact");
	});

	it("chain.edges contains edgeType, sourceType, sourceId, createdAt", () => {
		service.addEdge("meta-fact", {
			edgeType: "CONSOLIDATED_FROM",
			sourceType: "consolidation",
			sourceId: "consolidation-batch-1",
			sourceText: "Batch snippet",
		});
		const chain = service.getProvenance("meta-fact");
		const edge = chain.edges[0];
		expect(edge.edgeType).toBe("CONSOLIDATED_FROM");
		expect(edge.sourceType).toBe("consolidation");
		expect(edge.sourceId).toBe("consolidation-batch-1");
		expect(edge.sourceText).toBe("Batch snippet");
		expect(edge.createdAt).toBeDefined();
	});

	it("chain edge sourceText is undefined when not stored", () => {
		service.addEdge("no-text-fact", {
			edgeType: "REFLECTED_FROM",
			sourceType: "reflection",
			sourceId: "pattern-42",
		});
		const chain = service.getProvenance("no-text-fact");
		expect(chain.edges[0].sourceText).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 8. Multiple instances of ProvenanceService (isolation)
// ---------------------------------------------------------------------------

describe("ProvenanceService isolation", () => {
	it("two separate service instances do not share data", () => {
		const service2 = new ProvenanceService(join(tmpDir, "provenance2.db"));
		try {
			service.addEdge("fact-in-1", {
				edgeType: "DERIVED_FROM",
				sourceType: "active_store",
				sourceId: "s1",
			});
			// fact-in-1 should not appear in service2
			expect(service2.getEdges("fact-in-1")).toHaveLength(0);
			expect(service.getEdges("fact-in-1")).toHaveLength(1);
		} finally {
			service2.close();
		}
	});
});
