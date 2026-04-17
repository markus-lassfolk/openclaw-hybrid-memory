/**
 * Tests for LanceDB dimension mismatch handling (issue #128).
 *
 * Covers:
 * 1. Graceful fallback: search() returns [] instead of throwing on dimension mismatch.
 * 2. Startup schema validation: doInitialize() detects and logs a mismatch when opening
 *    an existing table that was created with a different vector dimension.
 * 3. Auto-repair: when autoRepair=true, the table is dropped and recreated with the
 *    correct dimension; wasRepaired is set so callers can trigger re-embedding.
 * 4. GlitchTip noise fix (issue #366): search() and hasDuplicate() do not call
 *    capturePluginError on dimension mismatch — the error is already logged at startup.
 */

// vi.mock is hoisted before any imports, intercepting capturePluginError in VectorDB.
vi.mock("../services/error-reporter.js", () => ({
	capturePluginError: vi.fn(),
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import * as errorReporter from "../services/error-reporter.js";

const { VectorDB } = _testing;

const CORRECT_DIM = 3; // dimension used by the "current" embedding model
const WRONG_DIM = 5; // dimension used when the table was originally created

// ---------------------------------------------------------------------------
// Helper: create a LanceDB table seeded with vectors of a given dimension.
// We use VectorDB itself (with the original dim) so the table format is
// identical to what production creates.
// ---------------------------------------------------------------------------
async function seedTable(lanceDir: string, dim: number): Promise<void> {
	const seeder = new VectorDB(lanceDir, dim);
	await seeder.store({
		text: "seed fact",
		vector: new Array(dim).fill(0.1),
		importance: 0.8,
		category: "fact",
	});
	seeder.close();
}

describe("VectorDB dimension mismatch — graceful fallback (issue #128)", () => {
	let tmpDir: string;
	let lanceDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
		lanceDir = join(tmpDir, "lance");
		// Create the table with WRONG_DIM (simulating a stale DB from an old model)
		await seedTable(lanceDir, WRONG_DIM);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("search() returns [] instead of throwing on dimension mismatch", async () => {
		// Open with CORRECT_DIM (mismatch — table has WRONG_DIM)
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		// Query vector dimension (CORRECT_DIM) doesn't match table dimension (WRONG_DIM)
		// LanceDB throws "No vector column found to match with the query vector dimension".
		// search() must catch this and return [] rather than propagating.
		const results = await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
		expect(Array.isArray(results)).toBe(true);
		expect(results).toHaveLength(0);
		db.close();
	});

	it("hasDuplicate() returns false instead of throwing on dimension mismatch", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		const isDuplicate = await db.hasDuplicate(new Array(CORRECT_DIM).fill(0.1));
		expect(isDuplicate).toBe(false);
		db.close();
	});
});

describe("VectorDB startup schema validation (issue #128)", () => {
	let tmpDir: string;
	let lanceDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
		lanceDir = join(tmpDir, "lance");
		await seedTable(lanceDir, WRONG_DIM);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("logs a warning when opening a table with mismatched vector dimension", async () => {
		const warns: string[] = [];
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		db.setLogger({ warn: (msg) => warns.push(msg) });

		// Trigger initialization by calling count()
		await db.count();

		const mismatchWarn = warns.find((w) => w.includes("dimension mismatch"));
		expect(mismatchWarn).toBeDefined();
		expect(mismatchWarn).toContain(`dim=${WRONG_DIM}`);
		expect(mismatchWarn).toContain(`dim=${CORRECT_DIM}`);
		db.close();
	});

	it("does NOT set wasRepaired when autoRepair is false (default)", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM); // autoRepair defaults to false
		await db.count();
		expect(db.wasRepaired).toBe(false);
		db.close();
	});

	it("logs no mismatch warning when dimensions are correct", async () => {
		// Open with the same dim the table was created with — no warning expected
		const db = new VectorDB(lanceDir, WRONG_DIM);
		const warns: string[] = [];
		db.setLogger({ warn: (msg) => warns.push(msg) });
		await db.count();
		const mismatchWarn = warns.find((w) => w.includes("dimension mismatch"));
		expect(mismatchWarn).toBeUndefined();
		db.close();
	});
});

describe("VectorDB legacy schema — missing why column (lineage migration)", () => {
	let tmpDir: string;
	let lanceDir: string;
	const dim = CORRECT_DIM;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-why-mig-"));
		lanceDir = join(tmpDir, "lance");
		const db = await lancedb.connect(lanceDir);
		await db.createTable("memories", [
			{
				id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				text: "legacy row",
				vector: new Array(dim).fill(0.1),
				importance: 0.5,
				category: "fact",
				createdAt: Math.floor(Date.now() / 1000),
			},
		]);
		await db.close();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("adds why on open so store() does not fail with field not in schema", async () => {
		const warns: string[] = [];
		const vdb = new VectorDB(lanceDir, dim);
		vdb.setLogger({ warn: (msg) => warns.push(msg) });
		await expect(
			vdb.store({
				text: "__diag__",
				vector: new Array(dim).fill(0.2),
				importance: 0.5,
				category: "fact",
			}),
		).resolves.toBeDefined();
		expect(
			warns.some((w) => w.includes("why") && w.includes("pre-lineage")),
		).toBe(true);
		vdb.close();
	});
});

describe("VectorDB auto-repair on dimension mismatch (issue #128)", () => {
	let tmpDir: string;
	let lanceDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
		lanceDir = join(tmpDir, "lance");
		await seedTable(lanceDir, WRONG_DIM);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("drops and recreates the table with the correct dimension when autoRepair=true", async () => {
		const warns: string[] = [];
		const db = new VectorDB(lanceDir, CORRECT_DIM, /* autoRepair */ true);
		db.setLogger({ warn: (msg) => warns.push(msg) });

		await db.count();

		expect(db.wasRepaired).toBe(true);

		// Table should now accept vectors of CORRECT_DIM
		const id = await db.store({
			text: "post-repair fact",
			vector: new Array(CORRECT_DIM).fill(0.5),
			importance: 0.9,
			category: "fact",
		});
		expect(typeof id).toBe("string");

		// search() should work with CORRECT_DIM after repair
		const results = await db.search(new Array(CORRECT_DIM).fill(0.5), 5, 0);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].entry.text).toBe("post-repair fact");

		// The auto-repair warning should have been logged
		const repairWarn = warns.find((w) => w.includes("autoRepair"));
		expect(repairWarn).toBeDefined();

		db.close();
	});

	it("table is empty after auto-repair (ready for re-embedding)", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM, /* autoRepair */ true);
		await db.count();
		expect(db.wasRepaired).toBe(true);
		// The repaired table should be empty (re-embedding is handled externally)
		const count = await db.count();
		expect(count).toBe(0);
		db.close();
	});

	it("wasRepaired stays false when there is no dimension mismatch", async () => {
		// Use the same dim as the seed — no repair needed
		const db = new VectorDB(lanceDir, WRONG_DIM, /* autoRepair */ true);
		await db.count();
		expect(db.wasRepaired).toBe(false);
		db.close();
	});
});

// ---------------------------------------------------------------------------
// VectorDB.optimize() — compaction and version pruning (issue #292)
// ---------------------------------------------------------------------------

describe("VectorDB.optimize() — compaction and version pruning (issue #292)", () => {
	let tmpDir: string;
	let lanceDir: string;
	let db: InstanceType<typeof VectorDB>;

	const DIM = 3;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-optimize-test-"));
		lanceDir = join(tmpDir, "lance");
		db = new VectorDB(lanceDir, DIM);
		// Store a few rows to create multiple fragments
		for (let i = 0; i < 3; i++) {
			await db.store({
				text: `fact ${i}`,
				vector: [0.1 * i, 0.2 * i, 0.3 * i],
				importance: 0.5,
				category: "fact",
			});
		}
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns compacted and removed stats with numeric values", async () => {
		const stats = await db.optimize();
		expect(typeof stats.compacted).toBe("number");
		expect(typeof stats.removedFragments).toBe("number");
		expect(typeof stats.freedBytes).toBe("number");
		expect(stats.compacted).toBeGreaterThanOrEqual(0);
		expect(stats.removedFragments).toBeGreaterThanOrEqual(0);
	});

	it("accepts a custom olderThanMs parameter", async () => {
		// Should not throw when called with a custom retention window
		const stats = await db.optimize(24 * 60 * 60 * 1000);
		expect(typeof stats.compacted).toBe("number");
		expect(typeof stats.removedFragments).toBe("number");
		expect(typeof stats.freedBytes).toBe("number");
	});

	it("DB remains usable after optimize — can still store and search", async () => {
		await db.optimize();
		const id = await db.store({
			text: "post-optimize fact",
			vector: [0.5, 0.5, 0.5],
			importance: 0.8,
			category: "fact",
		});
		expect(typeof id).toBe("string");
		const results = await db.search([0.5, 0.5, 0.5], 5, 0);
		expect(results.some((r) => r.entry.text === "post-optimize fact")).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// VectorDB issue #366 — no GlitchTip spam on dimension mismatch
// When validateOrRepairSchema() sets schemaValid=false at startup, subsequent
// search() and hasDuplicate() calls must NOT invoke capturePluginError, since
// the problem was already logged once at init.
// ---------------------------------------------------------------------------

describe("VectorDB issue #366 — capturePluginError suppressed on schema mismatch", () => {
	let tmpDir: string;
	let lanceDir: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-366-test-"));
		lanceDir = join(tmpDir, "lance");
		// Seed with WRONG_DIM to simulate a table created by an old embedding model
		await seedTable(lanceDir, WRONG_DIM);
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("search() does not call capturePluginError on dimension mismatch", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		const results = await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
		expect(results).toHaveLength(0);
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
		await db.close();
	});

	it("hasDuplicate() does not call capturePluginError on dimension mismatch", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		const isDup = await db.hasDuplicate(new Array(CORRECT_DIM).fill(0.1));
		expect(isDup).toBe(false);
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
		await db.close();
	});

	it("repeated search() calls do not call capturePluginError", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM);
		// Multiple calls in the same session — each would previously report to GlitchTip
		for (let i = 0; i < 5; i++) {
			await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
		}
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
		await db.close();
	});

	it("capturePluginError IS called for unexpected (non-schema) errors", async () => {
		// Open with matching dimensions — schemaValid will be true after init
		const db = new VectorDB(lanceDir, WRONG_DIM);
		await db.count(); // trigger initialization so this.table is populated

		// Inject an unexpected (non-schema) error by replacing the internal table with a
		// stub whose vectorSearch throws a generic error. schemaValid is still true, so
		// the catch block must NOT suppress capturePluginError.
		const unexpectedErr = new Error("Unexpected I/O failure");
		(db as any).table = {
			vectorSearch: () => {
				throw unexpectedErr;
			},
		};

		const results = await db.search(new Array(WRONG_DIM).fill(0.1), 5, 0);
		expect(results).toHaveLength(0);
		expect(vi.mocked(errorReporter.capturePluginError)).toHaveBeenCalledOnce();
		expect(vi.mocked(errorReporter.capturePluginError)).toHaveBeenCalledWith(
			unexpectedErr,
			expect.objectContaining({ operation: "vector-search" }),
		);
		await db.close();
	});
});

describe("VectorDB semantic query cache — suppress known schema errors", () => {
	let tmpDir: string;
	let lanceDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-cache-schema-test-"));
		lanceDir = join(tmpDir, "lance");
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rebuilds the semantic query cache after a known runtime schema failure without reporting GlitchTip", async () => {
		const db = new VectorDB(lanceDir, CORRECT_DIM);

		await db.storeSemanticQueryCache({
			queryText: "legacy query",
			vector: [1, 0, 0],
			factIds: ["fact-1"],
			filterKey: "test",
		});

		const knownSchemaErr = new Error(
			"Failed to execute query stream: GenericFailure, Invalid input, No vector column found to match with the query vector dimension",
		);

		(db as any).semanticQueryCacheTable = {
			vectorSearch: () => {
				throw knownSchemaErr;
			},
		};

		const match = await db.getSemanticQueryCacheMatch([1, 0, 0], {
			filterKey: "test",
			minSimilarity: 0.95,
			ttlMs: 60_000,
		});

		expect(match).toBeNull();
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();

		await db.storeSemanticQueryCache({
			queryText: "fresh query",
			vector: [0, 1, 0],
			factIds: ["fact-2"],
			filterKey: "test",
		});

		const repairedMatch = await db.getSemanticQueryCacheMatch([0, 1, 0], {
			filterKey: "test",
			minSimilarity: 0.95,
			ttlMs: 60_000,
		});

		expect(repairedMatch?.factIds).toEqual(["fact-2"]);
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
		await db.close();
	});
});

// ---------------------------------------------------------------------------
// VectorDB issue #599 — search() must not return optimistic placeholder metadata
// Fields not stored in LanceDB (confidence, source, decayClass, entity, key, value,
// expiresAt, lastConfirmedAt) must use conservative/unknown defaults so un-enriched
// results are not falsely ranked highly.
// ---------------------------------------------------------------------------

describe("VectorDB issue #599 — search() returns partial metadata with conservative defaults", () => {
	let tmpDir: string;
	let lanceDir: string;
	let db: InstanceType<typeof VectorDB>;

	const DIM = 3;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-599-test-"));
		lanceDir = join(tmpDir, "lance");
		db = new VectorDB(lanceDir, DIM);
		await db.store({
			text: "user prefers TypeScript",
			why: "Project build tooling and lint pipeline are already TypeScript-first",
			vector: [0.1, 0.2, 0.3],
			importance: 0.8,
			category: "preference",
			id: "test-id-599",
		});
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("search result contains real persisted fields (id, text, category, importance, createdAt)", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		const entry = results[0].entry;
		expect(entry.id).toBe("test-id-599");
		expect(entry.text).toBe("user prefers TypeScript");
		expect(entry.category).toBe("preference");
		expect(entry.importance).toBe(0.8);
		expect(typeof entry.createdAt).toBe("number");
		expect(entry.createdAt).toBeGreaterThan(0);
	});

	it("search result includes persisted why lineage context", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		expect(results[0].entry.why).toBe(
			"Project build tooling and lint pipeline are already TypeScript-first",
		);
	});

	it("search result confidence is 0 (conservative), not 1.0 (optimistic placeholder)", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		expect(results[0].entry.confidence).toBe(0);
		expect(results[0].entry.confidence).not.toBe(1.0);
	});

	it('search result source is "unknown", not "conversation" (fabricated placeholder)', async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		expect(results[0].entry.source).toBe("unknown");
		expect(results[0].entry.source).not.toBe("conversation");
	});

	it("search result entity, key, value are null (honest partial metadata)", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		const entry = results[0].entry;
		expect(entry.entity).toBeNull();
		expect(entry.key).toBeNull();
		expect(entry.value).toBeNull();
	});

	it('search result decayClass is "normal" (neutral, not boosted by preferLongTerm)', async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		expect(results[0].entry.decayClass).toBe("normal");
		expect(results[0].entry.decayClass).not.toBe("stable");
		expect(results[0].entry.decayClass).not.toBe("permanent");
	});

	it("search result expiresAt is null and lastConfirmedAt is 0 (conservative)", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		const entry = results[0].entry;
		expect(entry.expiresAt).toBeNull();
		expect(entry.lastConfirmedAt).toBe(0);
	});

	it("backend is lancedb", async () => {
		const results = await db.search([0.1, 0.2, 0.3], 5, 0);
		expect(results).toHaveLength(1);
		expect(results[0].backend).toBe("lancedb");
	});
});

// ---------------------------------------------------------------------------
// VectorDB issue #379 — malformed UUID suffix duplication
// delete() must log + return false instead of throwing when the UUID has a
// doubled suffix (e.g. "...831c1c1" instead of "...831c1").
// ---------------------------------------------------------------------------

describe("VectorDB issue #379 — delete() handles malformed UUIDs gracefully", () => {
	let tmpDir: string;
	let lanceDir: string;
	let db: InstanceType<typeof VectorDB>;

	const DIM = 3;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "vector-379-test-"));
		lanceDir = join(tmpDir, "lance");
		db = new VectorDB(lanceDir, DIM);
		await db.store({
			text: "seed fact",
			vector: [0.1, 0.2, 0.3],
			importance: 0.7,
			category: "fact",
		});
		vi.clearAllMocks();
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false and logs a warning for the specific doubled-suffix UUID from issue #379", async () => {
		const warns: string[] = [];
		db.setLogger({ warn: (msg) => warns.push(msg) });

		// Exact malformed UUID from GlitchTip report: valid UUID with 'c1' appended
		const malformedId = "4d062d33-e366-4498-9233-4b78040831c1c1";
		const result = await db.delete(malformedId);

		expect(result).toBe(false);
		expect(
			warns.some((w) => w.includes("invalid UUID") && w.includes(malformedId)),
		).toBe(true);
		// capturePluginError must NOT be called — this is a graceful skip, not an error
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
	});

	it("returns false and logs a warning for any UUID with extra characters appended", async () => {
		const warns: string[] = [];
		db.setLogger({ warn: (msg) => warns.push(msg) });

		const malformedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeeXX";
		const result = await db.delete(malformedId);

		expect(result).toBe(false);
		expect(warns.some((w) => w.includes("invalid UUID"))).toBe(true);
	});

	it("still deletes valid UUIDs correctly", async () => {
		const id = await db.store({
			text: "to be deleted",
			vector: [0.5, 0.5, 0.5],
			importance: 0.8,
			category: "fact",
		});
		const result = await db.delete(id);
		expect(result).toBe(true);
	});

	it("normalizes uppercase UUID fact ids to lowercase on store (matches delete / LanceDB id)", async () => {
		const mixedCase = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
		const returned = await db.store({
			text: "uuid case",
			vector: [0.1, 0.2, 0.3],
			importance: 0.5,
			category: "fact",
			id: mixedCase,
		});
		expect(returned).toBe(mixedCase.toLowerCase());
		expect(await db.delete(mixedCase)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// VectorDB graceful degradation — FTS5-only fallback when lancedb.connect() fails
// Issue: "If LanceDB fails to open, the plugin becomes unusable."
// ---------------------------------------------------------------------------

describe("VectorDB graceful degradation — FTS5-only fallback when lancedb.connect() fails", () => {
	const DIM = 3;
	const CONNECT_ERROR = new Error(
		"LanceDB connection refused: simulated failure",
	);
	let connectSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		connectSpy = vi.spyOn(lancedb, "connect").mockRejectedValue(CONNECT_ERROR);
	});

	afterEach(() => {
		connectSpy.mockRestore();
	});

	it("isLanceDbAvailable() returns false after a connect failure", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		await db.count();
		expect(db.isLanceDbAvailable()).toBe(false);
	});

	it("logs a warning on connect failure", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const warns: string[] = [];
		db.setLogger({ warn: (msg) => warns.push(msg) });
		await db.count();
		expect(
			warns.some((w) => w.includes("FTS5-only") || w.includes("unavailable")),
		).toBe(true);
	});

	it("search() returns [] without calling capturePluginError when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const results = await db.search(new Array(DIM).fill(0.1), 5, 0);
		expect(results).toHaveLength(0);
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
	});

	it("hasDuplicate() returns false without calling capturePluginError when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const result = await db.hasDuplicate(new Array(DIM).fill(0.1));
		expect(result).toBe(false);
		expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
	});

	it("store() returns an id without throwing when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const id = await db.store({
			text: "test fact",
			vector: new Array(DIM).fill(0.1),
			importance: 0.8,
			category: "fact",
		});
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("store() with an explicit id returns that id when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const explicitId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const id = await db.store({
			text: "test fact",
			vector: new Array(DIM).fill(0.1),
			importance: 0.8,
			category: "fact",
			id: explicitId,
		});
		expect(id).toBe(explicitId);
	});

	it("count() returns 0 when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const result = await db.count();
		expect(result).toBe(0);
	});

	it("delete() returns false when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const result = await db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
		expect(result).toBe(false);
	});

	it("optimize() returns zero stats when LanceDB unavailable", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const stats = await db.optimize();
		expect(stats).toEqual({ compacted: 0, removedFragments: 0, freedBytes: 0 });
	});

	it("does not retry lancedb.connect() on every call (only once per session)", async () => {
		const db = new VectorDB("/tmp/test-lance", DIM);
		const warns: string[] = [];
		db.setLogger({ warn: (msg) => warns.push(msg) });
		// Three separate calls — connect should only be attempted once
		await db.search(new Array(DIM).fill(0.1), 5, 0);
		await db.search(new Array(DIM).fill(0.2), 5, 0);
		await db.count();
		const unavailableWarns = warns.filter(
			(w) => w.includes("FTS5-only") || w.includes("unavailable"),
		);
		expect(unavailableWarns).toHaveLength(1);
		// connect() is also only called once despite three operation calls
		expect(connectSpy).toHaveBeenCalledTimes(1);
	});
});
