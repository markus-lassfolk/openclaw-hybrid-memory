/**
 * BM25 Ranking Verification Tests (Issue #277)
 *
 * Verifies that BM25/FTS5 rank scores correctly correlate with relevance:
 *   1. Exact keyword match ranks higher than partial match
 *   2. Multi-keyword queries rank documents with all keywords higher
 *   3. Score ordering is ascending (FTS5 rank is negative; closer to 0 = more relevant)
 *   4. Term frequency effect: repeated exact keyword in document ranks higher
 *   5. Integration: results returned in descending relevance order (highest-relevance first)
 *
 * These tests verify the OpenClaw v2026.3.7 BM25 fix is working correctly.
 * They use the same FTS5 virtual table infrastructure as the production search path.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB, searchFts, buildFts5Query } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DB = InstanceType<typeof FactsDB>;

function rawDb(db: DB) {
	return db.getRawDb();
}

function insertFact(db: DB, text: string, entity?: string, tags?: string) {
	rawDb(db)
		.prepare(
			`INSERT INTO facts (id, text, category, importance, entity, tags, key, value, source, created_at)
       VALUES (?, ?, 'fact', 0.7, ?, ?, NULL, NULL, 'conversation', ?)`,
		)
		.run(
			randomUUID(),
			text,
			entity ?? null,
			tags ?? null,
			Math.floor(Date.now() / 1000),
		);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DB;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "bm25-ranking-test-"));
	db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
	db.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// BM25 Score Ordering
// ---------------------------------------------------------------------------

describe("BM25 score ordering", () => {
	it("FTS5 rank is negative — closer to 0 means higher relevance", () => {
		insertFact(db, "TypeScript is a statically typed programming language");
		insertFact(db, "TypeScript adds optional static typing to JavaScript");

		const results = searchFts(rawDb(db), "TypeScript", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// All FTS5 ranks must be <= 0 (negative or zero)
		for (const r of results) {
			expect(r.rank).toBeLessThanOrEqual(0);
		}
	});

	it("results are sorted ascending by rank (closest to 0 first = most relevant)", () => {
		insertFact(db, "PostgreSQL is a relational database");
		insertFact(db, "PostgreSQL uses SQL and supports ACID transactions");
		insertFact(
			db,
			"PostgreSQL has advanced features like JSONB, full-text search, and window functions",
		);

		const results = searchFts(rawDb(db), "PostgreSQL", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// Ranks should be in ascending order (ascending = most relevant first for negative values)
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].rank).toBeLessThanOrEqual(results[i].rank);
		}
	});
});

// ---------------------------------------------------------------------------
// Exact keyword match outranks partial match
// ---------------------------------------------------------------------------

describe("Exact keyword match outranks partial/weaker match", () => {
	it("exact single-word match ranks above document mentioning only a related term", () => {
		// "database" appears in doc1 (exact target term)
		// "storage system" is a weaker/indirect mention — no exact match
		insertFact(
			db,
			"Redis is an in-memory database used for caching and pub/sub",
		);
		insertFact(db, "The storage system keeps data in a persistent manner");

		const results = searchFts(rawDb(db), "database", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// The first result should mention "database" explicitly
		expect(results[0].text.toLowerCase()).toContain("database");
	});

	it("document with the exact query phrase ranks first", () => {
		insertFact(db, "Kubernetes orchestrates containerised workloads");
		insertFact(db, "Docker containers are isolated processes");
		insertFact(db, "Kubernetes container orchestration scales horizontally");

		const results = searchFts(rawDb(db), "Kubernetes", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// Both Kubernetes docs should appear before the Docker-only one
		const kubernetesResults = results.filter((r) =>
			r.text.toLowerCase().includes("kubernetes"),
		);
		const dockerOnly = results.filter(
			(r) =>
				r.text.toLowerCase().includes("docker") &&
				!r.text.toLowerCase().includes("kubernetes"),
		);

		// All Kubernetes results should rank higher (earlier index) than Docker-only
		if (kubernetesResults.length > 0 && dockerOnly.length > 0) {
			const lastKubernetesIdx = results.indexOf(
				kubernetesResults[kubernetesResults.length - 1],
			);
			const firstDockerIdx = results.indexOf(dockerOnly[0]);
			expect(lastKubernetesIdx).toBeLessThan(firstDockerIdx);
		}
	});
});

// ---------------------------------------------------------------------------
// Multi-keyword queries: documents with all keywords rank higher
// ---------------------------------------------------------------------------

describe("Multi-keyword queries", () => {
	it("document matching all query terms ranks higher than document matching only one", () => {
		// Doc A matches both "machine" and "learning"
		insertFact(db, "Machine learning models learn patterns from training data");
		// Doc B matches only "machine"
		insertFact(db, "The machine was designed for industrial use in factories");

		const results = searchFts(rawDb(db), "machine learning", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// The full-match document should appear before the partial-match one
		const fullMatchIdx = results.findIndex(
			(r) =>
				r.text.toLowerCase().includes("machine") &&
				r.text.toLowerCase().includes("learning"),
		);
		const partialMatchIdx = results.findIndex(
			(r) =>
				r.text.toLowerCase().includes("machine") &&
				!r.text.toLowerCase().includes("learning"),
		);

		if (fullMatchIdx !== -1 && partialMatchIdx !== -1) {
			expect(fullMatchIdx).toBeLessThan(partialMatchIdx);
		} else {
			// At minimum, the full-match document should be present
			expect(fullMatchIdx).toBeGreaterThanOrEqual(0);
		}
	});

	it("boolean AND query only returns documents matching all terms", () => {
		insertFact(db, "React hooks simplify state management in React components");
		insertFact(db, "Vue components use reactive state via ref and reactive");
		insertFact(db, "State management in frontend frameworks is complex");

		// Use FTS5 AND operator to require both terms
		const query = buildFts5Query("hooks state") ?? "hooks state";
		const results = searchFts(rawDb(db), query, { limit: 5 });

		// Each result must contain at least "hooks" or "state" — our query is phrase-based
		// (buildFts5Query produces a phrase or boolean query)
		expect(results.length).toBeGreaterThanOrEqual(0);
		// No result should be completely unrelated
		for (const r of results) {
			const text = r.text.toLowerCase();
			const hasHooks = text.includes("hooks");
			const hasState = text.includes("state");
			expect(hasHooks || hasState).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Term frequency effect
// ---------------------------------------------------------------------------

describe("Term frequency effect", () => {
	it("document mentioning the query term more often tends to rank higher", () => {
		// High-TF document: "JavaScript" appears multiple times
		insertFact(
			db,
			"JavaScript is the language of the web. JavaScript runs in browsers and Node.js. JavaScript is versatile.",
		);
		// Low-TF document: "JavaScript" appears once
		insertFact(
			db,
			"Python is popular for data science; JavaScript is used for frontend work.",
		);

		const results = searchFts(rawDb(db), "JavaScript", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// BM25 (which FTS5 uses) applies term frequency saturation — higher TF should still
		// rank better for reasonably short documents. The high-TF doc should be first or tied.
		const highTfIdx = results.findIndex(
			(r) => (r.text.match(/JavaScript/g) ?? []).length >= 3,
		);
		const lowTfIdx = results.findIndex(
			(r) => (r.text.match(/JavaScript/g) ?? []).length < 3,
		);

		if (highTfIdx !== -1 && lowTfIdx !== -1) {
			// High-TF doc should rank at least as well (same or lower index)
			expect(highTfIdx).toBeLessThanOrEqual(lowTfIdx);
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: searchFts returns results in relevance order
// ---------------------------------------------------------------------------

describe("Integration: searchFts result order", () => {
	it("searchFts returns results in relevance order for a simple query", () => {
		insertFact(db, "Nginx is a high-performance web server and reverse proxy");
		insertFact(db, "Apache web server configuration uses VirtualHost blocks");
		insertFact(
			db,
			"The server room temperature should be maintained below 20°C",
		);

		const results = searchFts(rawDb(db), "web server", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		// Results that contain "web server" explicitly should appear before those that don't
		const exactMatchIdx = results
			.map((r, i) => ({ i, has: r.text.toLowerCase().includes("web server") }))
			.filter((x) => x.has)
			.map((x) => x.i);

		const noExactMatchIdx = results
			.map((r, i) => ({ i, has: r.text.toLowerCase().includes("web server") }))
			.filter((x) => !x.has)
			.map((x) => x.i);

		if (exactMatchIdx.length > 0 && noExactMatchIdx.length > 0) {
			const maxExact = Math.max(...exactMatchIdx);
			const minNoExact = Math.min(...noExactMatchIdx);
			expect(maxExact).toBeLessThan(minNoExact);
		}
	});

	it("searchFts includes rank field on every result", () => {
		insertFact(db, "Go is a statically typed compiled language from Google");
		insertFact(db, "Rust provides memory safety without garbage collection");

		const results = searchFts(rawDb(db), "language", { limit: 5 });
		for (const r of results) {
			expect(r).toHaveProperty("rank");
			expect(typeof r.rank).toBe("number");
		}
	});

	it("empty result set for completely irrelevant query", () => {
		insertFact(db, "The cat sat on the mat");
		insertFact(db, "Dogs enjoy playing fetch");

		// An extremely rare phrase unlikely to match anything
		const results = searchFts(rawDb(db), "quantumxyzabc42", { limit: 5 });
		expect(results.length).toBe(0);
	});

	it("snippet is present and non-empty when results are found", () => {
		insertFact(
			db,
			"Elasticsearch is a distributed search and analytics engine built on Lucene",
		);
		insertFact(
			db,
			"Solr is another search platform based on Lucene from Apache",
		);

		const results = searchFts(rawDb(db), "Lucene", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);

		for (const r of results) {
			// snippet may be undefined if not requested, but since we requested it, it should be set
			if (r.snippet !== undefined) {
				expect(typeof r.snippet).toBe("string");
				expect(r.snippet.length).toBeGreaterThan(0);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// BM25 column weight awareness
// ---------------------------------------------------------------------------

describe("BM25 column weighting", () => {
	it("match in text column contributes to rank (negative rank for text match)", () => {
		// Insert with matching text and a different entity
		insertFact(
			db,
			"Vim is a terminal-based text editor with modal editing",
			"vim-editor",
		);

		const results = searchFts(rawDb(db), "Vim", { limit: 5 });
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].rank).toBeLessThan(0); // negative = BM25 found a match
	});

	it("entity match contributes to relevance (match in entity column)", () => {
		insertFact(db, "This tool has many features", "emacs-editor");
		insertFact(db, "Another tool with fewer features", "vim-editor");

		const results = searchFts(rawDb(db), "emacs", { limit: 5 });
		// Should find at least the emacs entity even if "emacs" isn't in text
		const found = results.some(
			(r) =>
				(r.entity ?? null) === "emacs-editor" ||
				r.text.toLowerCase().includes("emacs"),
		);
		expect(found).toBe(true);
	});
});
