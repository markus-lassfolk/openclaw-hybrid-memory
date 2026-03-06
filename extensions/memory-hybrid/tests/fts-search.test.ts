/**
 * Tests for the FTS5 full-text search service (Issue #151).
 *
 * Tests cover: index creation, trigger sync (insert/update/delete),
 * keyword/phrase/boolean/prefix search, filters, snippet, ranking,
 * rebuildFtsIndex, edge cases, and performance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _testing } from "../index.js";

const { FactsDB, searchFts, rebuildFtsIndex, buildFts5Query } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DB = InstanceType<typeof FactsDB>;

/** Access the private liveDb connection from FactsDB (for FTS service calls). */
function rawDb(db: DB) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).liveDb as import("better-sqlite3").Database;
}

/** Direct INSERT bypassing FactsDB (for perf test bulk seeding). */
function insertRaw(db: DB, text: string, entity?: string, tags?: string) {
  rawDb(db)
    .prepare(
      `INSERT INTO facts (id, text, category, importance, entity, tags, key, value, source, created_at)
       VALUES (?, ?, 'other', 0.7, ?, ?, NULL, NULL, 'conversation', ?)`,
    )
    .run(randomUUID(), text, entity ?? null, tags ?? null, Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fts-search-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema: FTS index created alongside facts table
// ---------------------------------------------------------------------------

describe("schema", () => {
  it("facts_fts virtual table exists after FactsDB init", () => {
    const row = rawDb(db)
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='facts_fts'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("facts_fts");
  });

  it("facts_fts schema includes tags column", () => {
    const row = rawDb(db)
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts_fts'`)
      .get() as { sql: string } | undefined;
    expect(row?.sql).toContain("tags");
  });

  it("insert trigger exists", () => {
    const row = rawDb(db)
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='facts_ai'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("facts_ai");
  });

  it("update trigger exists", () => {
    const row = rawDb(db)
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='facts_au'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("facts_au");
  });

  it("delete trigger exists", () => {
    const row = rawDb(db)
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='facts_ad'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("facts_ad");
  });
});

// ---------------------------------------------------------------------------
// Trigger sync
// ---------------------------------------------------------------------------

describe("trigger sync", () => {
  it("INSERT into facts → FTS index updated automatically", () => {
    db.store({
      text: "TypeScript is a typed superset of JavaScript",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe("TypeScript is a typed superset of JavaScript");
  });

  it("UPDATE facts → FTS index reflects the new text", () => {
    const entry = db.store({
      text: "Python is a scripting language",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    // Update the text directly (triggers facts_au).
    rawDb(db)
      .prepare(`UPDATE facts SET text = ? WHERE id = ?`)
      .run("Python is a high-level programming language", entry.id);

    const old = searchFts(rawDb(db), "scripting");
    expect(old).toHaveLength(0);

    const updated = searchFts(rawDb(db), "programming");
    expect(updated.length).toBeGreaterThan(0);
    expect(updated[0].text).toBe("Python is a high-level programming language");
  });

  it("DELETE from facts → FTS index removes the entry", () => {
    const entry = db.store({
      text: "Rust guarantees memory safety without a garbage collector",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const before = searchFts(rawDb(db), "Rust");
    expect(before.length).toBeGreaterThan(0);

    db.delete(entry.id);

    const after = searchFts(rawDb(db), "Rust");
    expect(after).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search: query types
// ---------------------------------------------------------------------------

describe("keyword search", () => {
  beforeEach(() => {
    db.store({
      text: "The user prefers dark mode in all applications",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
    });
    db.store({
      text: "Meeting scheduled for Tuesday at 10am",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
  });

  it("simple keyword returns matching fact", () => {
    const results = searchFts(rawDb(db), "dark mode");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("dark mode");
  });

  it("keyword does not match unrelated fact", () => {
    const results = searchFts(rawDb(db), "quantum physics");
    expect(results).toHaveLength(0);
  });
});

describe("phrase search", () => {
  beforeEach(() => {
    db.store({
      text: "User loves the quick brown fox",
      category: "preference",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "The fox was quick but not brown",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
  });

  it('phrase search with "..." returns exact phrase match', () => {
    const results = searchFts(rawDb(db), '"quick brown fox"');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("quick brown fox");
  });
});

describe("boolean search", () => {
  beforeEach(() => {
    db.store({
      text: "Node.js uses event-driven architecture",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "Deno is a secure JavaScript runtime",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "Bun is another JavaScript runtime",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
  });

  it("OR query returns facts matching either term", () => {
    const results = searchFts(rawDb(db), "Deno OR Bun");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("AND query returns only facts matching both terms", () => {
    const results = searchFts(rawDb(db), "JavaScript AND runtime");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Node.js fact doesn't say "runtime" so should be excluded
    results.forEach((r) => {
      expect(r.text.toLowerCase()).toContain("runtime");
    });
  });
});

describe("prefix search", () => {
  beforeEach(() => {
    db.store({
      text: "Configuration is stored in the config directory",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
  });

  it("prefix with * returns facts with matching prefix", () => {
    const results = searchFts(rawDb(db), "config*");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("entity filter", () => {
  beforeEach(() => {
    db.store({
      text: "Alice prefers coffee in the morning",
      category: "preference",
      importance: 0.8,
      entity: "alice",
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "Bob prefers tea in the morning",
      category: "preference",
      importance: 0.8,
      entity: "bob",
      key: null,
      value: null,
      source: "conversation",
    });
  });

  it("entityFilter narrows results to matching entity", () => {
    const results = searchFts(rawDb(db), "morning", { entityFilter: "alice" });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.entity?.toLowerCase()).toBe("alice");
    });
  });

  it("entityFilter is case-insensitive", () => {
    const results = searchFts(rawDb(db), "morning", { entityFilter: "ALICE" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("entityFilter excludes non-matching entities", () => {
    const results = searchFts(rawDb(db), "morning", { entityFilter: "alice" });
    const hasBob = results.some((r) => r.entity?.toLowerCase() === "bob");
    expect(hasBob).toBe(false);
  });
});

describe("tag filter", () => {
  beforeEach(() => {
    db.store({
      text: "Deploy to production using Docker",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      tags: ["devops", "docker"],
    });
    db.store({
      text: "Deploy to staging using Kubernetes",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      tags: ["devops", "kubernetes"],
    });
  });

  it("tagFilter narrows results to facts with matching tag", () => {
    const results = searchFts(rawDb(db), "deploy", { tagFilter: "docker" });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.text.toLowerCase()).toContain("docker");
    });
  });

  it("tagFilter excludes facts without the tag", () => {
    const results = searchFts(rawDb(db), "deploy", { tagFilter: "docker" });
    const hasKubernetes = results.some((r) => r.text.toLowerCase().includes("kubernetes"));
    expect(hasKubernetes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snippet and matchInfo
// ---------------------------------------------------------------------------

describe("snippet", () => {
  it("snippet() returns highlighted text with markers", () => {
    db.store({
      text: "The quick brown fox jumps over the lazy dog near the river bank",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "quick brown fox");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toBeDefined();
    // Snippet should contain the highlight markers we defined: '[' and ']'
    expect(results[0].snippet).toMatch(/\[.*?\]/);
  });
});

describe("matchInfo", () => {
  it("matchInfo is a string", () => {
    db.store({
      text: "SQLite is an embedded database engine",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "SQLite");
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].matchInfo).toBe("string");
  });

  it("matchInfo contains 'text' when match is in text column", () => {
    db.store({
      text: "PostgreSQL supports JSON natively",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "PostgreSQL");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchInfo).toContain("text");
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("ranking", () => {
  it("results are returned in relevance order (rank ascending — closer to 0 first)", () => {
    db.store({
      text: "TypeScript TypeScript TypeScript is great",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "TypeScript adds types to JavaScript",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "JavaScript is a dynamic language",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // FTS5 rank is negative; ascending order means most relevant first
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeLessThanOrEqual(results[i].rank);
    }
  });

  it("factId matches the fact id in the facts table", () => {
    const entry = db.store({
      text: "Vitest is a Vite-native testing framework",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "Vitest");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].factId).toBe(entry.id);
  });
});

// ---------------------------------------------------------------------------
// rebuildFtsIndex
// ---------------------------------------------------------------------------

describe("rebuildFtsIndex", () => {
  it("populates FTS from existing facts", () => {
    // Insert via raw SQL (bypasses FTS triggers) to simulate a pre-migration state.
    insertRaw(db, "Redis is an in-memory data structure store");
    insertRaw(db, "Memcached is a caching system");

    // Confirm FTS doesn't find them yet (triggers may have fired, but let's rebuild anyway).
    rebuildFtsIndex(rawDb(db));

    const results = searchFts(rawDb(db), "Redis");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns the count of indexed facts", () => {
    insertRaw(db, "fact one");
    insertRaw(db, "fact two");
    insertRaw(db, "fact three");

    const count = rebuildFtsIndex(rawDb(db));
    expect(count).toBe(3);
  });

  it("is idempotent — calling twice gives the same count", () => {
    insertRaw(db, "idempotent fact about databases");

    const first = rebuildFtsIndex(rawDb(db));
    const second = rebuildFtsIndex(rawDb(db));
    expect(first).toBe(second);
    expect(first).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("empty query returns empty results", () => {
    db.store({
      text: "Some fact stored in the database",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "");
    expect(results).toHaveLength(0);
  });

  it("whitespace-only query returns empty results", () => {
    const results = searchFts(rawDb(db), "   ");
    expect(results).toHaveLength(0);
  });

  it("no results for non-matching query", () => {
    db.store({
      text: "User likes hiking in the mountains",
      category: "preference",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const results = searchFts(rawDb(db), "quantum entanglement");
    expect(results).toHaveLength(0);
  });

  it("special characters in query do not throw", () => {
    db.store({
      text: "Some fact with special characters",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    expect(() => searchFts(rawDb(db), "SELECT * FROM facts; DROP TABLE facts;--")).not.toThrow();
    expect(() => searchFts(rawDb(db), "'; DROP TABLE facts_fts;--")).not.toThrow();
    expect(() => searchFts(rawDb(db), "hello \"world\" (test)")).not.toThrow();
    expect(() => searchFts(rawDb(db), "* AND OR NOT")).not.toThrow();
  });

  it("limit option is respected", () => {
    for (let i = 0; i < 10; i++) {
      insertRaw(db, `Interesting fact number ${i} about databases`);
    }

    const results = searchFts(rawDb(db), "databases", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// buildFts5Query unit tests
// ---------------------------------------------------------------------------

describe("buildFts5Query", () => {
  it("returns null for empty string", () => {
    expect(buildFts5Query("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(buildFts5Query("   ")).toBeNull();
  });

  it("wraps plain keywords in quotes with OR", () => {
    const q = buildFts5Query("hello world");
    expect(q).toBe('"hello" OR "world"');
  });

  it("passes through quoted phrase", () => {
    const q = buildFts5Query('"quick brown fox"');
    expect(q).toBe('"quick brown fox"');
  });

  it("passes through FTS5 boolean operators", () => {
    const q = buildFts5Query("foo AND bar");
    expect(q).toBe("\"foo\" AND \"bar\"");
  });

  it("passes through prefix operator *", () => {
    const q = buildFts5Query("config*");
    expect(q).toBe("config*");
  });

  it("strips SQL injection characters", () => {
    const q = buildFts5Query("hello' DROP TABLE; --");
    expect(q).not.toContain("'");
    expect(q).not.toContain(";");
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe("performance", () => {
  it("search over 1000+ facts completes in <100ms", () => {
    // Bulk insert 1100 facts in a single transaction for speed.
    const insert = rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, importance, entity, tags, key, value, source, created_at)
       VALUES (?, ?, 'other', 0.7, NULL, NULL, NULL, NULL, 'conversation', ?)`,
    );

    const insertMany = rawDb(db).transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 1100; i++) {
        const topic = i % 2 === 0 ? "database" : "networking";
        insert.run(
          randomUUID(),
          `Fact about ${topic} number ${i}: various details and information stored here`,
          now,
        );
      }
    });

    insertMany();

    const start = performance.now();
    const results = searchFts(rawDb(db), "database", { limit: 20 });
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
