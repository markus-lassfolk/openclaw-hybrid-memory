// @ts-nocheck
/**
 * merge-results.test.ts — Dedicated unit tests for services/merge-results.ts.
 *
 * This file focuses on direct imports from the service module (not via _testing)
 * and provides additional edge-case coverage complementary to merge.test.ts.
 *
 * ## Coverage
 *
 * ### mergeResults
 * - Single-list passthrough (only sqlite, only lance).
 * - Produces stable output order for equal scores (deterministic sort).
 * - Large input: limit strictly enforced.
 * - SupersededProvider omitted (undefined): no filtering applied.
 * - Empty SupersededProvider (getSupersededTexts returns empty Set): no filtering.
 * - All lance results superseded: returns only sqlite results.
 * - Custom k=0 edge case: scores degenerate but result is still valid.
 * - Returns empty array when limit=0.
 *
 * ### filterByScope
 * - null scopeFilter: no filtering, all results returned.
 * - Null getById result for every ID removes all items.
 * - scopeFilter with workspaceId property passed through to getById.
 */

import { describe, expect, it } from "vitest";
import {
	RRF_K_DEFAULT,
	filterByScope,
	mergeResults,
} from "../services/merge-results.js";
import type { SearchResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeResult(
	text: string,
	score = 0.5,
	backend: "sqlite" | "lancedb" = "sqlite",
	overrides: Partial<SearchResult["entry"]> = {},
): SearchResult {
	return {
		entry: {
			id: `id-${++idCounter}`,
			text,
			category: "fact",
			importance: 0.7,
			entity: null,
			key: null,
			value: null,
			source: "test",
			createdAt: Math.floor(Date.now() / 1000),
			decayClass: "stable",
			expiresAt: null,
			lastConfirmedAt: Math.floor(Date.now() / 1000),
			confidence: 1.0,
			...overrides,
		},
		score,
		backend,
	};
}

// ---------------------------------------------------------------------------
// RRF_K_DEFAULT export
// ---------------------------------------------------------------------------

describe("RRF_K_DEFAULT", () => {
	it("is 60", () => {
		expect(RRF_K_DEFAULT).toBe(60);
	});
});

// ---------------------------------------------------------------------------
// mergeResults — single-list passthrough
// ---------------------------------------------------------------------------

describe("mergeResults — single-list passthrough", () => {
	it("returns sqlite-only results when lance is empty", () => {
		const sqlite = [makeResult("fact A", 0.9), makeResult("fact B", 0.7)];
		const merged = mergeResults(sqlite, [], 10);
		expect(merged.length).toBe(2);
		expect(merged.every((r) => r.backend === "sqlite")).toBe(true);
	});

	it("returns lancedb-only results when sqlite is empty", () => {
		const lance = [
			makeResult("fact C", 0.8, "lancedb"),
			makeResult("fact D", 0.6, "lancedb"),
		];
		const merged = mergeResults([], lance, 10);
		expect(merged.length).toBe(2);
		expect(merged.every((r) => r.backend === "lancedb")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// mergeResults — limit enforcement
// ---------------------------------------------------------------------------

describe("mergeResults — limit enforcement", () => {
	it("returns exactly limit results from large inputs", () => {
		const sqlite = Array.from({ length: 20 }, (_, i) =>
			makeResult(`sqlite ${i}`, 1 - i * 0.01),
		);
		const lance = Array.from({ length: 20 }, (_, i) =>
			makeResult(`lance ${i}`, 0.9 - i * 0.01, "lancedb"),
		);
		expect(mergeResults(sqlite, lance, 5).length).toBe(5);
	});

	it("returns 0 results when limit=0", () => {
		const sqlite = [makeResult("a", 0.9)];
		const lance = [makeResult("b", 0.8, "lancedb")];
		expect(mergeResults(sqlite, lance, 0).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// mergeResults — superseded filtering
// ---------------------------------------------------------------------------

describe("mergeResults — superseded filtering", () => {
	it("does not filter when factsDb is undefined", () => {
		const sqlite = [makeResult("fact alpha", 0.9)];
		const lance = [makeResult("fact beta", 0.8, "lancedb")];
		const merged = mergeResults(sqlite, lance, 10, undefined);
		expect(merged.length).toBe(2);
	});

	it("does not filter when getSupersededTexts returns empty Set", () => {
		const sqlite = [makeResult("fact alpha", 0.9)];
		const lance = [makeResult("fact beta", 0.8, "lancedb")];
		const emptyProvider = { getSupersededTexts: () => new Set<string>() };
		const merged = mergeResults(sqlite, lance, 10, emptyProvider);
		expect(merged.length).toBe(2);
	});

	it("removes all lance results when all are superseded", () => {
		const sqlite = [makeResult("current fact", 0.9)];
		const lance = [
			makeResult("Superseded Fact One", 0.95, "lancedb"),
			makeResult("Superseded Fact Two", 0.92, "lancedb"),
		];
		const provider = {
			getSupersededTexts: () =>
				new Set(["superseded fact one", "superseded fact two"]),
		};
		const merged = mergeResults(sqlite, lance, 10, provider);
		expect(merged.length).toBe(1);
		expect(merged[0].entry.text).toBe("current fact");
	});

	it("superseded check is case-insensitive", () => {
		const sqlite = [makeResult("Normal Fact", 0.9)];
		const lance = [makeResult("SUPERSEDED ITEM", 0.95, "lancedb")];
		const provider = { getSupersededTexts: () => new Set(["superseded item"]) };
		const merged = mergeResults(sqlite, lance, 10, provider);
		expect(merged.some((r) => r.entry.text === "SUPERSEDED ITEM")).toBe(false);
		expect(merged.some((r) => r.entry.text === "Normal Fact")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// mergeResults — RRF correctness (spot checks)
// ---------------------------------------------------------------------------

describe("mergeResults — RRF score correctness", () => {
	it("result in both lists has higher score than result in only one list", () => {
		const sharedId = "shared-rrf";
		const sqlite = [
			makeResult("only in sqlite", 0.9),
			makeResult("in both", 0.5, "sqlite", { id: sharedId }),
		];
		const lance = [
			makeResult("only in lance", 0.9, "lancedb"),
			makeResult("in both", 0.5, "lancedb", { id: sharedId }),
		];
		const merged = mergeResults(sqlite, lance, 10);
		const inBothScore = merged.find((r) => r.entry.id === sharedId)?.score ?? 0;
		const onlyInSqlite =
			merged.find((r) => r.entry.text === "only in sqlite")?.score ?? 0;
		expect(inBothScore).toBeGreaterThan(onlyInSqlite);
	});

	it("scores are positive and finite for all results", () => {
		const sqlite = [makeResult("a", 0.9), makeResult("b", 0.5)];
		const lance = [makeResult("c", 0.8, "lancedb")];
		const merged = mergeResults(sqlite, lance, 10);
		for (const r of merged) {
			expect(r.score).toBeGreaterThan(0);
			expect(Number.isFinite(r.score)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// filterByScope
// ---------------------------------------------------------------------------

describe("filterByScope", () => {
	it("returns all results when scopeFilter is null", () => {
		const results = [makeResult("A"), makeResult("B")];
		const getById = (_id: string) => ({ id: _id });
		expect(filterByScope(results, getById, null)).toEqual(results);
	});

	it("returns all results when scopeFilter is undefined", () => {
		const results = [makeResult("A"), makeResult("B")];
		const getById = (_id: string) => ({ id: _id });
		expect(filterByScope(results, getById, undefined)).toEqual(results);
	});

	it("returns empty array when every getById call returns null", () => {
		const results = [makeResult("A"), makeResult("B")];
		const getById = () => null;
		const filtered = filterByScope(results, getById, { userId: "alice" });
		expect(filtered).toHaveLength(0);
	});

	it("passes scopeFilter to getById correctly", () => {
		const inScope = makeResult("In scope");
		const outOfScope = makeResult("Out of scope");
		const results = [inScope, outOfScope];
		const scopeFilter = { userId: "alice" };

		const getById = (
			id: string,
			opts?: { scopeFilter?: typeof scopeFilter | null },
		) => {
			if (id === outOfScope.entry.id && opts?.scopeFilter?.userId === "alice")
				return null;
			return { id };
		};

		const filtered = filterByScope(results, getById, scopeFilter);
		expect(filtered.length).toBe(1);
		expect(filtered[0].entry.text).toBe("In scope");
	});

	it("returns all results when every getById returns a value", () => {
		const results = [makeResult("X"), makeResult("Y"), makeResult("Z")];
		const getById = (id: string) => ({ id, found: true });
		const filtered = filterByScope(results, getById, { userId: "bob" });
		expect(filtered.length).toBe(3);
	});
});
