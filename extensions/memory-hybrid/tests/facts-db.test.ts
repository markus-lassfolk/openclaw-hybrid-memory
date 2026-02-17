import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "facts-db-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Store & retrieve
// ---------------------------------------------------------------------------

describe("FactsDB.store", () => {
  it("stores a fact and assigns an id", () => {
    const entry = db.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
    });
    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.text).toBe("User prefers dark mode");
    expect(entry.category).toBe("preference");
    expect(entry.decayClass).toBeDefined();
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.confidence).toBe(1.0);
  });

  it("auto-classifies decay class", () => {
    const entry = db.store({
      text: "decided to use Vitest",
      category: "decision",
      importance: 0.9,
      entity: "decision",
      key: "test-framework",
      value: "Vitest",
      source: "conversation",
    });
    expect(entry.decayClass).toBe("permanent");
  });

  it("respects explicit decay class", () => {
    const entry = db.store({
      text: "temporary note",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "session",
    });
    expect(entry.decayClass).toBe("session");
  });

  it("stores and retrieves tags", () => {
    const entry = db.store({
      text: "Nibe heat pump setup",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      tags: ["nibe", "homeassistant"],
    });
    expect(entry.tags).toEqual(["nibe", "homeassistant"]);
  });

  it("stores sourceDate", () => {
    const entry = db.store({
      text: "Historical fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
      sourceDate: 1700000000,
    });
    expect(entry.sourceDate).toBe(1700000000);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe("FactsDB.getById", () => {
  it("returns stored fact by id", () => {
    const stored = db.store({
      text: "Test fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const retrieved = db.getById(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.text).toBe("Test fact");
    expect(retrieved!.id).toBe(stored.id);
  });

  it("returns null for non-existent id", () => {
    expect(db.getById("nonexistent-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

describe("FactsDB.count", () => {
  it("returns 0 for empty database", () => {
    expect(db.count()).toBe(0);
  });

  it("returns correct count after stores", () => {
    db.store({ text: "Fact one", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Fact two", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(db.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("FactsDB.delete", () => {
  it("deletes an existing fact", () => {
    const entry = db.store({ text: "Delete me", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(db.delete(entry.id)).toBe(true);
    expect(db.getById(entry.id)).toBeNull();
    expect(db.count()).toBe(0);
  });

  it("returns false for non-existent id", () => {
    expect(db.delete("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Search (FTS5)
// ---------------------------------------------------------------------------

describe("FactsDB.search", () => {
  it("finds fact by keyword", () => {
    db.store({ text: "The Vitest framework is excellent for testing", category: "fact", importance: 0.8, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "SQLite is a lightweight database", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    const results = db.search("Vitest");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toContain("Vitest");
    expect(results[0].backend).toBe("sqlite");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    db.store({ text: "Something about cats", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const results = db.search("xylophone");
    expect(results).toEqual([]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.store({ text: `Fact number ${i} about TypeScript`, category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    }
    const results = db.search("TypeScript", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("filters expired facts by default", () => {
    db.store({
      text: "Expired fact about testing",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: Math.floor(Date.now() / 1000) - 1000,
    });
    const results = db.search("testing");
    expect(results.length).toBe(0);
  });

  it("includes expired when requested", () => {
    db.store({
      text: "Expired fact about testing",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: Math.floor(Date.now() / 1000) - 1000,
    });
    const results = db.search("testing", 5, { includeExpired: true });
    expect(results.length).toBe(1);
  });

  it("handles empty/short query gracefully", () => {
    expect(db.search("")).toEqual([]);
    expect(db.search("a")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lookup (entity/key)
// ---------------------------------------------------------------------------

describe("FactsDB.lookup", () => {
  it("finds facts by entity", () => {
    db.store({ text: "User name is Markus", category: "fact", importance: 0.8, entity: "user", key: "name", value: "Markus", source: "test" });
    db.store({ text: "User email is test@example.com", category: "fact", importance: 0.8, entity: "user", key: "email", value: "test@example.com", source: "test" });
    db.store({ text: "System version 3", category: "fact", importance: 0.7, entity: "system", key: "version", value: "3", source: "test" });

    const results = db.lookup("user");
    expect(results.length).toBe(2);
    expect(results.every((r) => r.entry.entity === "user")).toBe(true);
  });

  it("finds facts by entity + key", () => {
    db.store({ text: "User name is Markus", category: "fact", importance: 0.8, entity: "user", key: "name", value: "Markus", source: "test" });
    db.store({ text: "User email is test@example.com", category: "fact", importance: 0.8, entity: "user", key: "email", value: "test@example.com", source: "test" });

    const results = db.lookup("user", "name");
    expect(results.length).toBe(1);
    expect(results[0].entry.value).toBe("Markus");
  });

  it("is case-insensitive", () => {
    db.store({ text: "User info", category: "fact", importance: 0.8, entity: "User", key: "Name", value: "Test", source: "test" });
    const results = db.lookup("user", "name");
    expect(results.length).toBe(1);
  });

  it("excludes expired facts", () => {
    db.store({
      text: "Expired user fact",
      category: "fact",
      importance: 0.8,
      entity: "user",
      key: "temp",
      value: "gone",
      source: "test",
      expiresAt: Math.floor(Date.now() / 1000) - 1000,
    });
    const results = db.lookup("user");
    expect(results.length).toBe(0);
  });

  it("excludes superseded facts", () => {
    const old = db.store({ text: "Old user fact", category: "fact", importance: 0.8, entity: "user", key: "pref", value: "old", source: "test" });
    const newer = db.store({ text: "New user fact", category: "fact", importance: 0.8, entity: "user", key: "pref", value: "new", source: "test" });
    db.supersede(old.id, newer.id);

    const results = db.lookup("user", "pref");
    expect(results.length).toBe(1);
    expect(results[0].entry.id).toBe(newer.id);
  });
});

// ---------------------------------------------------------------------------
// Fuzzy deduplication
// ---------------------------------------------------------------------------

describe("FactsDB fuzzy deduplication", () => {
  let dedupeDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    dedupeDb = new FactsDB(join(tmpDir, "dedupe.db"), { fuzzyDedupe: true });
  });

  afterEach(() => {
    dedupeDb.close();
  });

  it("hasDuplicate detects exact text", () => {
    dedupeDb.store({ text: "Exact match text", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(dedupeDb.hasDuplicate("Exact match text")).toBe(true);
  });

  it("hasDuplicate detects normalized match", () => {
    dedupeDb.store({ text: "  Hello   World  ", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(dedupeDb.hasDuplicate("hello world")).toBe(true);
  });

  it("store skips duplicate when fuzzyDedupe is on", () => {
    dedupeDb.store({ text: "Unique fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    dedupeDb.store({ text: "  unique   fact  ", category: "fact", importance: 0.9, entity: null, key: null, value: null, source: "test" });
    expect(dedupeDb.count()).toBe(1);
  });

  it("store allows different text", () => {
    dedupeDb.store({ text: "Fact alpha", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    dedupeDb.store({ text: "Fact beta", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(dedupeDb.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Supersession (FR-008/010)
// ---------------------------------------------------------------------------

describe("FactsDB.supersede", () => {
  it("marks old fact as superseded", () => {
    const old = db.store({ text: "Old info", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const newer = db.store({ text: "New info", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const result = db.supersede(old.id, newer.id);
    expect(result).toBe(true);

    const updated = db.getById(old.id);
    expect(updated?.supersededAt).toBeGreaterThan(0);
    expect(updated?.supersededBy).toBe(newer.id);
  });

  it("does not supersede already-superseded fact", () => {
    const a = db.store({ text: "A", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const b = db.store({ text: "B", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const c = db.store({ text: "C", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.supersede(a.id, b.id);
    expect(db.supersede(a.id, c.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateFact (FR-008)
// ---------------------------------------------------------------------------

describe.skip("FactsDB.updateFact", () => {
  // updateFact not implemented; use supersede + store for updates
  it("updates text and normalized hash", () => {
    const entry = db.store({ text: "Original text", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    // @ts-expect-error updateFact not in FactsDB
    db.updateFact(entry.id, { text: "Updated text" });
    const updated = db.getById(entry.id);
    expect(updated?.text).toBe("Updated text");
    expect(updated?.confidence).toBe(1.0);
  });

  it("updates value", () => {
    const entry = db.store({ text: "Some fact", category: "fact", importance: 0.7, entity: "user", key: "color", value: "blue", source: "test" });
    // @ts-expect-error updateFact not in FactsDB
    db.updateFact(entry.id, { value: "green" });
    const updated = db.getById(entry.id);
    expect(updated?.value).toBe("green");
  });

  it("returns false for non-existent id", () => {
    // @ts-expect-error updateFact not in FactsDB
    expect(db.updateFact("nonexistent", { text: "nope" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prune expired
// ---------------------------------------------------------------------------

describe("FactsDB.pruneExpired", () => {
  it("removes expired facts", () => {
    db.store({
      text: "Will expire",
      category: "fact",
      importance: 0.5,
      entity: null, key: null, value: null,
      source: "test",
      decayClass: "session",
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    db.store({
      text: "Will not expire",
      category: "fact",
      importance: 0.8,
      entity: null, key: null, value: null,
      source: "test",
      decayClass: "permanent",
    });

    const pruned = db.pruneExpired();
    expect(pruned).toBe(1);
    expect(db.count()).toBe(1);
  });

  it("returns 0 when nothing to prune", () => {
    db.store({ text: "Permanent fact", category: "fact", importance: 0.8, entity: null, key: null, value: null, source: "test", decayClass: "permanent" });
    expect(db.pruneExpired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decay confidence
// ---------------------------------------------------------------------------

describe("FactsDB.decayConfidence", () => {
  it("removes facts with very low confidence", () => {
    const entry = db.store({
      text: "Low confidence fact",
      category: "fact",
      importance: 0.5,
      entity: null, key: null, value: null,
      source: "test",
      decayClass: "active",
      confidence: 0.05,
    });
    const removed = db.decayConfidence();
    expect(removed).toBe(1);
    expect(db.getById(entry.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confirm fact
// ---------------------------------------------------------------------------

describe("FactsDB.confirmFact", () => {
  it("resets confidence to 1.0 and refreshes timestamps", () => {
    const entry = db.store({
      text: "Confirmable fact",
      category: "fact",
      importance: 0.7,
      entity: null, key: null, value: null,
      source: "test",
      decayClass: "stable",
    });
    const result = db.confirmFact(entry.id);
    expect(result).toBe(true);
    const updated = db.getById(entry.id);
    expect(updated?.confidence).toBe(1.0);
  });

  it("returns false for non-existent fact", () => {
    expect(db.confirmFact("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

describe("FactsDB checkpoint", () => {
  it("save and restore checkpoint", () => {
    const id = db.saveCheckpoint({
      intent: "Testing the checkpoint system",
      state: "in_progress",
      expectedOutcome: "all tests pass",
      workingFiles: ["index.ts", "config.ts"],
    });
    expect(id).toBeDefined();

    const restored = db.restoreCheckpoint();
    expect(restored).not.toBeNull();
    expect(restored!.intent).toBe("Testing the checkpoint system");
    expect(restored!.state).toBe("in_progress");
    expect(restored!.expectedOutcome).toBe("all tests pass");
    expect(restored!.workingFiles).toEqual(["index.ts", "config.ts"]);
  });

  it("returns null when no checkpoint exists", () => {
    expect(db.restoreCheckpoint()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stats & category queries
// ---------------------------------------------------------------------------

describe("FactsDB.statsBreakdown", () => {
  it("groups by decay class", () => {
    db.store({ text: "Permanent fact", category: "fact", importance: 0.8, entity: "decision", key: "test", value: "yes", source: "test" });
    db.store({ text: "Working on something right now", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const stats = db.statsBreakdown();
    expect(typeof stats).toBe("object");
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
  });
});

describe("FactsDB.getByCategory", () => {
  it("returns facts of specific category", () => {
    db.store({ text: "A preference", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "A fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Another preference", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    const prefs = db.getByCategory("preference");
    expect(prefs.length).toBe(2);
    expect(prefs.every((e) => e.category === "preference")).toBe(true);
  });
});

describe("FactsDB.updateCategory", () => {
  it("changes category of a fact", () => {
    const entry = db.store({ text: "Miscategorized", category: "other", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(db.updateCategory(entry.id, "preference")).toBe(true);
    const updated = db.getById(entry.id);
    expect(updated?.category).toBe("preference");
  });

  it("returns false for non-existent id", () => {
    expect(db.updateCategory("nonexistent", "fact")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findSimilarForClassification
// ---------------------------------------------------------------------------

describe("FactsDB.findSimilarForClassification", () => {
  it("finds facts by entity + key", () => {
    db.store({ text: "Theme is dark", category: "preference", importance: 0.8, entity: "user", key: "theme", value: "dark", source: "test" });
    db.store({ text: "Other info", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    const similar = db.findSimilarForClassification("Theme changed to light", "user", "theme");
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].entity).toBe("user");
    expect(similar[0].key).toBe("theme");
  });

  it("falls back to FTS when no entity match", () => {
    db.store({ text: "TypeScript is the best language for this project", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    const similar = db.findSimilarForClassification("TypeScript project configuration", null, null);
    expect(similar.length).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const similar = db.findSimilarForClassification("xylophone sonata", null, null);
    expect(similar.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// countExpired & backfillDecayClasses
// ---------------------------------------------------------------------------

describe("FactsDB.countExpired", () => {
  it("counts expired facts", () => {
    db.store({
      text: "Expired", category: "fact", importance: 0.5,
      entity: null, key: null, value: null, source: "test",
      decayClass: "session", expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    db.store({
      text: "Not expired", category: "fact", importance: 0.5,
      entity: null, key: null, value: null, source: "test",
    });
    expect(db.countExpired()).toBe(1);
  });
});

describe("FactsDB.backfillDecayClasses", () => {
  it("reclassifies stable facts", () => {
    db.store({
      text: "decided to use SQLite for everything",
      category: "decision", importance: 0.9,
      entity: "decision", key: "database", value: "SQLite",
      source: "test",
      decayClass: "stable",
    });
    const counts = db.backfillDecayClasses();
    expect(counts.permanent).toBeGreaterThanOrEqual(1);
  });
});
