/**
 * Tests for the Vector DB reconciliation feature.
 *
 * Covers:
 * 1. VectorDB.getAllIds() returns IDs for stored vectors.
 * 2. FactsDB.getAllIds() returns IDs for active (non-expired, non-superseded) facts.
 * 3. Orphan detection: vector orphans (in LanceDB but not SQLite) and SQLite orphans
 *    (in SQLite but not LanceDB) are correctly identified by comparing the two sets.
 * 4. Reconcile fix: vector orphans are deleted from LanceDB when --fix is used.
 */

// vi.mock is hoisted before any imports, intercepting capturePluginError in VectorDB.
vi.mock("../services/error-reporter.js", () => ({
	capturePluginError: vi.fn(),
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { UUID_REGEX } from "../utils/constants.js";

const { VectorDB, FactsDB } = _testing;

const DIM = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeVector(): number[] {
	return new Array(DIM).fill(0).map(() => Math.random());
}

function storeFactInSqlite(
	db: InstanceType<typeof FactsDB>,
	overrides?: Partial<{ text: string; category: string }>,
): string {
	const entry = db.store({
		text: overrides?.text ?? "A test memory fact",
		category: overrides?.category ?? "fact",
		importance: 0.7,
		entity: null,
		key: null,
		value: null,
		source: "test",
	});
	return entry.id;
}

async function storeVectorWithId(
	vdb: InstanceType<typeof VectorDB>,
	id: string,
): Promise<void> {
	await vdb.store({
		id,
		text: "A test memory fact",
		vector: makeVector(),
		importance: 0.7,
		category: "fact",
	});
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
let tmpDir: string;
let sqliteDir: string;
let lanceDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let vectorDb: InstanceType<typeof VectorDB>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
	sqliteDir = join(tmpDir, "facts.db");
	lanceDir = join(tmpDir, "lance");
	factsDb = new FactsDB(sqliteDir);
	vectorDb = new VectorDB(lanceDir, DIM);
});

afterEach(async () => {
	factsDb.close();
	await vectorDb.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// VectorDB.getAllIds
// ---------------------------------------------------------------------------
describe("VectorDB.getAllIds()", () => {
	it("returns empty array when the table is empty", async () => {
		const ids = await vectorDb.getAllIds();
		expect(ids).toEqual([]);
	});

	it("returns stored IDs", async () => {
		const id1 = await vectorDb.store({
			text: "fact one",
			vector: makeVector(),
			importance: 0.8,
			category: "fact",
		});
		const id2 = await vectorDb.store({
			text: "fact two",
			vector: makeVector(),
			importance: 0.6,
			category: "fact",
		});
		const ids = await vectorDb.getAllIds();
		expect(ids).toContain(id1.toLowerCase());
		expect(ids).toContain(id2.toLowerCase());
		expect(ids.length).toBeGreaterThanOrEqual(2);
	});

	it("IDs are lowercase UUIDs", async () => {
		const stored = await vectorDb.store({
			text: "fact",
			vector: makeVector(),
			importance: 0.5,
			category: "fact",
		});
		const ids = await vectorDb.getAllIds();
		for (const id of ids) {
			expect(UUID_REGEX.test(id)).toBe(true);
		}
		expect(ids).toContain(stored.toLowerCase());
	});

	it("skips non-UUID IDs", async () => {
		const id1 = "not-a-uuid-1234";
		await vectorDb.store({
			id: id1,
			text: "invalid id fact",
			vector: makeVector(),
			importance: 0.5,
			category: "fact",
		});
		const ids = await vectorDb.getAllIds();
		expect(ids).not.toContain(id1);
	});
});

// ---------------------------------------------------------------------------
// FactsDB.getAllIds
// ---------------------------------------------------------------------------
describe("FactsDB.getAllIds()", () => {
	it("returns empty array when no facts exist", () => {
		const ids = factsDb.getAllIds();
		expect(ids).toEqual([]);
	});

	it("returns IDs for active facts", () => {
		const id1 = storeFactInSqlite(factsDb, { text: "fact one" });
		const id2 = storeFactInSqlite(factsDb, { text: "fact two" });
		const ids = factsDb.getAllIds();
		expect(ids).toContain(id1);
		expect(ids).toContain(id2);
		expect(ids.length).toBeGreaterThanOrEqual(2);
	});

	it("excludes superseded facts", () => {
		const id1 = storeFactInSqlite(factsDb, { text: "original" });
		// Store a replacement and explicitly supersede the original
		const entry2 = factsDb.store({
			text: "updated fact",
			category: "fact",
			importance: 0.8,
			entity: null,
			key: null,
			value: null,
			source: "test",
			supersedesId: id1,
		});
		factsDb.supersede(id1, entry2.id);
		const ids = factsDb.getAllIds();
		expect(ids).not.toContain(id1);
		expect(ids).toContain(entry2.id);
	});

	it("excludes expired facts", () => {
		const entry = factsDb.store({
			text: "expired fact",
			category: "fact",
			importance: 0.5,
			entity: null,
			key: null,
			value: null,
			source: "test",
			expiresAt: Math.floor(Date.now() / 1000) - 3600,
			decayClass: "short",
		});
		const ids = factsDb.getAllIds();
		expect(ids).not.toContain(entry.id);
	});
});

// ---------------------------------------------------------------------------
// Orphan detection logic (mirrors what cmd-verify.ts does)
// ---------------------------------------------------------------------------
describe("Reconciliation orphan detection", () => {
	it("detects no orphans when SQLite and LanceDB are in sync", async () => {
		const sqliteId1 = storeFactInSqlite(factsDb, { text: "synced fact one" });
		const sqliteId2 = storeFactInSqlite(factsDb, { text: "synced fact two" });
		await storeVectorWithId(vectorDb, sqliteId1);
		await storeVectorWithId(vectorDb, sqliteId2);

		const sqliteIds = new Set(factsDb.getAllIds());
		const vectorIds = await vectorDb.getAllIds();
		const vectorIdSet = new Set(vectorIds);

		const vectorOrphans = vectorIds.filter((id) => !sqliteIds.has(id));
		const sqliteOrphans = Array.from(sqliteIds).filter(
			(id) => !vectorIdSet.has(id),
		);

		expect(vectorOrphans).toHaveLength(0);
		expect(sqliteOrphans).toHaveLength(0);
	});

	it("detects vector orphans (LanceDB has ID that SQLite does not)", async () => {
		// Store a vector with a synthetic ID that is NOT present in SQLite
		const orphanId = "aaaaaaaa-0000-4000-8000-000000000001";
		await vectorDb.store({
			id: orphanId,
			text: "orphan vector",
			vector: makeVector(),
			importance: 0.5,
			category: "fact",
		});

		const sqliteIds = new Set(factsDb.getAllIds());
		const vectorIds = await vectorDb.getAllIds();

		const vectorOrphans = vectorIds.filter((id) => !sqliteIds.has(id));

		expect(vectorOrphans).toContain(orphanId);
	});

	it("detects SQLite orphans (SQLite has ID that LanceDB does not)", async () => {
		const sqliteId = storeFactInSqlite(factsDb, { text: "no vector yet" });

		const sqliteIds = new Set(factsDb.getAllIds());
		const vectorIds = await vectorDb.getAllIds();
		const vectorIdSet = new Set(vectorIds);

		const sqliteOrphans = Array.from(sqliteIds).filter(
			(id) => !vectorIdSet.has(id),
		);

		expect(sqliteOrphans).toContain(sqliteId);
	});
});

// ---------------------------------------------------------------------------
// Reconcile fix: vector orphan deletion
// ---------------------------------------------------------------------------
describe("Reconciliation fix — delete vector orphans", () => {
	it("removes orphan vectors from LanceDB", async () => {
		const orphanId = "bbbbbbbb-0000-4000-8000-000000000002";
		await vectorDb.store({
			id: orphanId,
			text: "orphan",
			vector: makeVector(),
			importance: 0.4,
			category: "fact",
		});

		// Confirm orphan is present before fix
		const idsBefore = await vectorDb.getAllIds();
		expect(idsBefore).toContain(orphanId);

		// Simulate fix: delete the orphan
		const deleted = await vectorDb.delete(orphanId);
		expect(deleted).toBe(true);

		// Confirm orphan is gone
		const idsAfter = await vectorDb.getAllIds();
		expect(idsAfter).not.toContain(orphanId);
	});

	it("preserves synced vectors when fixing orphans", async () => {
		const syncedId = storeFactInSqlite(factsDb, { text: "synced fact" });
		const orphanId = "cccccccc-0000-4000-8000-000000000003";

		await storeVectorWithId(vectorDb, syncedId);
		await vectorDb.store({
			id: orphanId,
			text: "orphan",
			vector: makeVector(),
			importance: 0.4,
			category: "fact",
		});

		const sqliteIds = new Set(factsDb.getAllIds());
		const vectorIds = await vectorDb.getAllIds();
		const vectorOrphans = vectorIds.filter((id) => !sqliteIds.has(id));

		// Only the orphan should be deleted
		for (const id of vectorOrphans) {
			await vectorDb.delete(id);
		}

		const idsAfter = await vectorDb.getAllIds();
		expect(idsAfter).toContain(syncedId.toLowerCase());
		expect(idsAfter).not.toContain(orphanId);
	});
});
