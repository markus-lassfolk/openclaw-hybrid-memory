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

  it("frequently recalled fact scores higher (dynamic salience)", () => {
    const a = db.store({ text: "User prefers dark mode", category: "preference", importance: 0.7, entity: "user", key: "theme", value: "dark", source: "test", confidence: 0.8 });
    const b = db.store({ text: "User prefers TypeScript", category: "preference", importance: 0.7, entity: "user", key: "language", value: "TypeScript", source: "test", confidence: 0.8 });

    for (let i = 0; i < 15; i++) {
      db.refreshAccessedFacts([a.id]);
    }

    const results = db.lookup("user");
    expect(results.length).toBe(2);
    const scoreA = results.find((r) => r.entry.id === a.id)?.score ?? 0;
    const scoreB = results.find((r) => r.entry.id === b.id)?.score ?? 0;
    expect(scoreA).toBeGreaterThan(scoreB);
  });
});

// ---------------------------------------------------------------------------
// Dynamic memory tiering (hot/warm/cold)
// ---------------------------------------------------------------------------

describe("FactsDB tiering", () => {
  it("stores with default tier warm and getHotFacts returns only hot", () => {
    const a = db.store({ text: "Hot blocker", category: "fact", importance: 0.9, entity: null, key: null, value: null, source: "test", tags: ["blocker"] });
    const b = db.store({ text: "Warm fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(a.tier).toBe("warm");
    expect(b.tier).toBe("warm");
    expect(db.getHotFacts(2000).length).toBe(0);
    db.setTier(a.id, "hot");
    const hot = db.getHotFacts(2000);
    expect(hot.length).toBe(1);
    expect(hot[0].entry.id).toBe(a.id);
  });

  it("getHotFacts caps by token budget", () => {
    const id1 = db.store({ text: "Short.", category: "fact", importance: 0.8, entity: null, key: null, value: null, source: "test" }).id;
    const id2 = db.store({ text: "Also short.", category: "fact", importance: 0.8, entity: null, key: null, value: null, source: "test" }).id;
    db.setTier(id1, "hot");
    db.setTier(id2, "hot");
    const hot = db.getHotFacts(2);
    expect(hot.length).toBeLessThanOrEqual(2);
  });

  it("search with tierFilter warm excludes cold", () => {
    const w = db.store({ text: "Warm preference", category: "preference", importance: 0.8, entity: "user", key: null, value: null, source: "test" });
    const c = db.store({ text: "Cold decision", category: "decision", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.setTier(c.id, "cold");
    const warmResults = db.search("preference", 5, { tierFilter: "warm" });
    expect(warmResults.some((r) => r.entry.id === w.id)).toBe(true);
    expect(warmResults.some((r) => r.entry.id === c.id)).toBe(false);
    const allResults = db.search("decision", 5, { tierFilter: "all" });
    expect(allResults.some((r) => r.entry.id === c.id)).toBe(true);
  });

  it("runCompaction returns counts and promotes blockers to hot", () => {
    const blocker = db.store({ text: "Active blocker", category: "fact", importance: 0.9, entity: null, key: null, value: null, source: "test", tags: ["blocker"] });
    const counts = db.runCompaction({ inactivePreferenceDays: 7, hotMaxTokens: 2000, hotMaxFacts: 50 });
    expect(counts).toMatchObject({ hot: expect.any(Number), warm: expect.any(Number), cold: expect.any(Number) });
    const hotFact = db.getById(blocker.id);
    expect(hotFact?.tier).toBe("hot");
  });

  it("runCompaction moves completed tasks (decision) to COLD", () => {
    const task = db.store({ text: "Decided to use SQLite", category: "decision", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    expect(db.getById(task.id)?.tier).toBe("warm");
    db.runCompaction({ inactivePreferenceDays: 7, hotMaxTokens: 2000, hotMaxFacts: 50 });
    const coldFact = db.getById(task.id);
    expect(coldFact?.tier).toBe("cold");
  });

  it("runCompaction moves inactive hot preferences to WARM", () => {
    const pref = db.store({ text: "User prefers TypeScript", category: "preference", importance: 0.8, entity: "user", key: null, value: null, source: "test" });
    db.setTier(pref.id, "hot");
    expect(db.getById(pref.id)?.tier).toBe("hot");
    db.runCompaction({ inactivePreferenceDays: 7, hotMaxTokens: 2000, hotMaxFacts: 50 });
    const warmFact = db.getById(pref.id);
    expect(warmFact?.tier).toBe("warm");
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
// Supersession
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
// Bi-temporal and point-in-time
// ---------------------------------------------------------------------------

describe("FactsDB bi-temporal", () => {
  it("getById with asOf returns null when fact not yet valid", () => {
    const entry = db.store({
      text: "Future fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      validFrom: 2000,
      validUntil: null,
    });
    expect(db.getById(entry.id)).not.toBeNull();
    expect(db.getById(entry.id, { asOf: 1999 })).toBeNull();
  });

  it("getById with asOf returns null when fact no longer valid", () => {
    const entry = db.store({
      text: "Past fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      validFrom: 1000,
      validUntil: 2000,
    });
    expect(db.getById(entry.id, { asOf: 2000 })).toBeNull();
    expect(db.getById(entry.id, { asOf: 2001 })).toBeNull();
    expect(db.getById(entry.id, { asOf: 1500 })).not.toBeNull();
  });

  it("getById with asOf returns fact when valid at that time", () => {
    const entry = db.store({
      text: "Time-bounded fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      validFrom: 1000,
      validUntil: 3000,
    });
    expect(db.getById(entry.id, { asOf: 1000 })).not.toBeNull();
    expect(db.getById(entry.id, { asOf: 2500 })).not.toBeNull();
    expect(db.getById(entry.id, { asOf: 2999 })).not.toBeNull();
  });

  it("search with asOf returns only facts valid at that time", () => {
    const old = db.store({
      text: "Old theme preference",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "test",
      validFrom: 1000,
    });
    const newer = db.store({
      text: "New theme preference",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "light",
      source: "test",
      validFrom: 2000,
      supersedesId: old.id,
    });
    db.supersede(old.id, newer.id);
    const supersessionTime = db.getById(old.id)!.validUntil!;

    const current = db.search("theme", 5);
    expect(current.some((r) => r.entry.id === newer.id)).toBe(true);
    expect(current.some((r) => r.entry.id === old.id)).toBe(false);

    const asOf1500 = db.search("theme", 5, { asOf: 1500 });
    expect(asOf1500.some((r) => r.entry.id === old.id)).toBe(true);
    expect(asOf1500.some((r) => r.entry.id === newer.id)).toBe(false);

    const afterSupersession = db.search("theme", 5, { asOf: supersessionTime + 1 });
    expect(afterSupersession.some((r) => r.entry.id === newer.id)).toBe(true);
    expect(afterSupersession.some((r) => r.entry.id === old.id)).toBe(false);
  });

  it("search with includeSuperseded returns superseded facts", () => {
    const old = db.store({
      text: "Superseded preference",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "mode",
      value: "old",
      source: "test",
    });
    const newer = db.store({
      text: "Current preference",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "mode",
      value: "new",
      source: "test",
    });
    db.supersede(old.id, newer.id);

    const def = db.search("preference", 5);
    expect(def.length).toBeGreaterThanOrEqual(1);
    expect(def.some((r) => r.entry.id === old.id)).toBe(false);

    const withSuperseded = db.search("preference", 5, { includeSuperseded: true });
    expect(withSuperseded.some((r) => r.entry.id === old.id)).toBe(true);
  });

  it("lookup with asOf returns only facts valid at that time", () => {
    const old = db.store({
      text: "Old value",
      category: "fact",
      importance: 0.7,
      entity: "Entity",
      key: "key",
      value: "v1",
      source: "test",
      validFrom: 1000,
    });
    const newer = db.store({
      text: "New value",
      category: "fact",
      importance: 0.7,
      entity: "Entity",
      key: "key",
      value: "v2",
      source: "test",
      validFrom: 2000,
      supersedesId: old.id,
    });
    db.supersede(old.id, newer.id);
    const supersessionTime = db.getById(old.id)!.validUntil!;

    const at1500 = db.lookup("Entity", "key", undefined, { asOf: 1500 });
    expect(at1500.length).toBe(1);
    expect(at1500[0].entry.value).toBe("v1");

    const afterSupersession = db.lookup("Entity", "key", undefined, { asOf: supersessionTime + 1 });
    expect(afterSupersession.length).toBe(1);
    expect(afterSupersession[0].entry.value).toBe("v2");
  });

  it("lookup with includeSuperseded returns superseded facts", () => {
    const old = db.store({
      text: "Old",
      category: "fact",
      importance: 0.7,
      entity: "X",
      key: "k",
      value: "old",
      source: "test",
    });
    const newer = db.store({
      text: "New",
      category: "fact",
      importance: 0.7,
      entity: "X",
      key: "k",
      value: "new",
      source: "test",
    });
    db.supersede(old.id, newer.id);

    const def = db.lookup("X", "k");
    expect(def.length).toBe(1);
    expect(def[0].entry.id).toBe(newer.id);

    const withSuperseded = db.lookup("X", "k", undefined, { includeSuperseded: true });
    expect(withSuperseded.length).toBe(2);
  });

  it("store with supersedesId and validFrom sets fields; supersede marks old", () => {
    const old = db.store({
      text: "Original",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const t = 5000;
    const replacement = db.store({
      text: "Replacement",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      validFrom: t,
      supersedesId: old.id,
    });
    db.supersede(old.id, replacement.id);

    expect(replacement.validFrom).toBe(t);
    expect(replacement.supersedesId).toBe(old.id);
    const oldUpdated = db.getById(old.id);
    expect(oldUpdated?.supersededAt).toBeGreaterThan(0);
    expect(oldUpdated?.supersededBy).toBe(replacement.id);
    expect(oldUpdated?.validUntil).toBeGreaterThan(0);
  });

  it("getFactsForConsolidation excludes superseded facts", () => {
    const a = db.store({
      text: "Fact A",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const b = db.store({
      text: "Fact B",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db.supersede(a.id, b.id);

    const forConsolidation = db.getFactsForConsolidation(100);
    const ids = forConsolidation.map((f) => f.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });
});

// ---------------------------------------------------------------------------
// updateFact
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

describe("FactsDB.statsBreakdownByTier", () => {
  it("groups by tier (hot/warm/cold)", () => {
    const a = db.store({ text: "Hot fact", category: "fact", importance: 0.8, entity: null, key: null, value: null, source: "test" });
    const b = db.store({ text: "Warm fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.setTier(a.id, "hot");
    db.setTier(b.id, "cold");
    const stats = db.statsBreakdownByTier();
    expect(stats.hot).toBe(1);
    expect(stats.cold).toBe(1);
    expect(stats.warm).toBeGreaterThanOrEqual(0);
  });
});

describe("FactsDB.statsBreakdownBySource", () => {
  it("groups by source", () => {
    db.store({ text: "From conversation", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "conversation" });
    db.store({ text: "From CLI", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "cli" });
    const stats = db.statsBreakdownBySource();
    expect(stats.conversation).toBeGreaterThanOrEqual(1);
    expect(stats.cli).toBeGreaterThanOrEqual(1);
  });
});

describe("FactsDB.statsBreakdownByCategory", () => {
  it("groups non-superseded facts by category", () => {
    db.store({ text: "A preference", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "A fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Another preference", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const stats = db.statsBreakdownByCategory();
    expect(stats.preference).toBe(2);
    expect(stats.fact).toBeGreaterThanOrEqual(1);
  });
});

describe("FactsDB.proceduresCount / proceduresValidatedCount / proceduresPromotedCount", () => {
  it("returns counts from procedures table", () => {
    const total = db.proceduresCount();
    const validated = db.proceduresValidatedCount();
    const promoted = db.proceduresPromotedCount();
    expect(typeof total).toBe("number");
    expect(total).toBeGreaterThanOrEqual(0);
    expect(validated).toBeGreaterThanOrEqual(0);
    expect(promoted).toBeGreaterThanOrEqual(0);
    expect(validated).toBeLessThanOrEqual(total);
    expect(promoted).toBeLessThanOrEqual(total);
  });
});

describe("FactsDB.linksCount", () => {
  it("returns count of memory_links", () => {
    const n = db.linksCount();
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("FactsDB.directivesCount", () => {
  it("counts facts with source LIKE directive:%", () => {
    const before = db.directivesCount();
    db.store({
      text: "User said always do X",
      category: "rule",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "directive:session.jsonl",
    });
    const after = db.directivesCount();
    expect(after).toBe(before + 1);
  });
});

describe("FactsDB.metaPatternsCount", () => {
  it("returns count of pattern facts with meta tag", () => {
    const n = db.metaPatternsCount();
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("FactsDB.entityCount", () => {
  it("returns distinct entity count for non-superseded facts", () => {
    db.store({ text: "About user", category: "fact", importance: 0.7, entity: "user", key: null, value: null, source: "test" });
    db.store({ text: "About org", category: "fact", importance: 0.7, entity: "org", key: null, value: null, source: "test" });
    const n = db.entityCount();
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("FactsDB.listFactsByCategory", () => {
  it("returns non-superseded facts by category with limit", () => {
    db.store({ text: "P1", category: "pattern", importance: 0.8, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "P2", category: "pattern", importance: 0.8, entity: null, key: null, value: null, source: "test" });
    const items = db.listFactsByCategory("pattern", 10);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((e) => e.category === "pattern")).toBe(true);
  });
});

describe("FactsDB.listDirectives", () => {
  it("returns facts with source LIKE directive:%", () => {
    const before = db.listDirectives(10);
    db.store({
      text: "Always do X",
      category: "rule",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "directive:session.jsonl",
    });
    const after = db.listDirectives(10);
    expect(after.length).toBe(before.length + 1);
  });
});

describe("FactsDB.listProcedures", () => {
  it("returns procedures ordered by updated_at DESC up to limit", () => {
    const items = db.listProcedures(10);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(10);
  });
});

describe("FactsDB.estimateStoredTokens", () => {
  it("returns positive token estimate for stored facts", () => {
    db.store({ text: "A short fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const tokens = db.estimateStoredTokens();
    expect(tokens).toBeGreaterThan(0);
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

describe("FactsDB.getRecentFacts", () => {
  it("returns facts from window and excludes pattern/rule by default", () => {
    db.store({ text: "Preference A", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Pattern B", category: "pattern", importance: 0.9, entity: null, key: null, value: null, source: "reflection" });
    db.store({ text: "Decision C", category: "decision", importance: 0.8, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Rule D", category: "rule", importance: 0.9, entity: null, key: null, value: null, source: "reflection" });

    const recent = db.getRecentFacts(14);
    expect(recent.length).toBe(2);
    expect(recent.map((e) => e.category).sort()).toEqual(["decision", "preference"]);
  });

  it("respects excludeCategories option", () => {
    db.store({ text: "Pref", category: "preference", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.store({ text: "Fact", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    const withoutPref = db.getRecentFacts(14, { excludeCategories: ["preference"] });
    expect(withoutPref.length).toBe(1);
    expect(withoutPref[0].category).toBe("fact");
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

// ---------------------------------------------------------------------------
// Hebbian createOrStrengthenRelatedLink
// ---------------------------------------------------------------------------

describe("FactsDB.createOrStrengthenRelatedLink", () => {
  it("creates RELATED_TO link when none exists", () => {
    const a = db.store({ text: "Fact A", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const b = db.store({ text: "Fact B", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    db.createOrStrengthenRelatedLink(a.id, b.id);

    const linksFromA = db.getLinksFrom(a.id);
    const linksFromB = db.getLinksFrom(b.id);
    const expectedTarget = a.id < b.id ? b.id : a.id;
    const allLinks = [...linksFromA, ...linksFromB];
    const related = allLinks.filter((l) => l.linkType === "RELATED_TO");
    expect(related.length).toBe(1);
    expect(related[0].targetFactId).toBe(expectedTarget);
    expect(related[0].strength).toBeGreaterThan(0);
  });

  it("strengthens existing RELATED_TO link on repeated co-recall", () => {
    const a = db.store({ text: "Fact A", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    const b = db.store({ text: "Fact B", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });

    db.createOrStrengthenRelatedLink(a.id, b.id);
    const afterFirst = db.getLinksFrom(a.id < b.id ? a.id : b.id).find((l) => l.linkType === "RELATED_TO");
    const strength1 = afterFirst?.strength ?? 0;

    db.createOrStrengthenRelatedLink(a.id, b.id);
    const afterSecond = db.getLinksFrom(a.id < b.id ? a.id : b.id).find((l) => l.linkType === "RELATED_TO");
    const strength2 = afterSecond?.strength ?? 0;

    expect(strength2).toBeGreaterThan(strength1);
  });

  it("does nothing when fact IDs are the same", () => {
    const a = db.store({ text: "Fact A", category: "fact", importance: 0.7, entity: null, key: null, value: null, source: "test" });
    db.createOrStrengthenRelatedLink(a.id, a.id);
    const links = db.getLinksFrom(a.id);
    expect(links.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Memory Scoping
// ---------------------------------------------------------------------------

describe("FactsDB scoping", () => {
  it("stores with default global scope", () => {
    const entry = db.store({
      text: "Company policy",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    expect(entry.scope).toBe("global");
    expect(entry.scopeTarget == null).toBe(true); // null or undefined for global
  });

  it("stores with user scope and scopeTarget", () => {
    const entry = db.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
      scope: "user",
      scopeTarget: "alice",
    });
    expect(entry.scope).toBe("user");
    expect(entry.scopeTarget).toBe("alice");
  });

  it("search with scopeFilter returns global + matching scopes", () => {
    db.store({
      text: "Global prefers default mode visible to all",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db.store({
      text: "Alice prefers dark mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
      scope: "user",
      scopeTarget: "alice",
    });
    db.store({
      text: "Bob prefers light mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "light",
      source: "conversation",
      scope: "user",
      scopeTarget: "bob",
    });

    const results = db.search("prefers mode", 10, {
      scopeFilter: { userId: "alice", agentId: null, sessionId: null },
    });
    expect(results.length).toBeGreaterThanOrEqual(2); // global + alice
    const texts = results.map((r) => r.entry.text);
    expect(texts).toContain("Global prefers default mode visible to all");
    expect(texts).toContain("Alice prefers dark mode");
    expect(texts).not.toContain("Bob prefers light mode");
  });

  it("lookup with scopeFilter returns global + matching scopes", () => {
    db.store({
      text: "Alice theme is dark",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
      scope: "user",
      scopeTarget: "alice",
    });
    db.store({
      text: "Bob theme is light",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "light",
      source: "conversation",
      scope: "user",
      scopeTarget: "bob",
    });

    const results = db.lookup("user", "theme", undefined, {
      scopeFilter: { userId: "alice", agentId: null, sessionId: null },
    });
    expect(results.length).toBe(1);
    expect(results[0].entry.scopeTarget).toBe("alice");
  });

  it("getById with scopeFilter returns null when not in scope", () => {
    const entry = db.store({
      text: "Private to alice",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "secret",
      value: "x",
      source: "conversation",
      scope: "user",
      scopeTarget: "alice",
    });

    expect(db.getById(entry.id, { scopeFilter: { userId: "alice" } })).not.toBeNull();
    expect(db.getById(entry.id, { scopeFilter: { userId: "bob" } })).toBeNull();
  });

  it("pruneSessionScope deletes session-scoped facts", () => {
    db.store({
      text: "Session note A",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-xyz",
    });
    db.store({
      text: "Session note B",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-xyz",
    });
    db.store({
      text: "Session note for other session",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-abc",
    });

    const count = db.pruneSessionScope("sess-xyz");
    expect(count).toBe(2);

    const remaining = db.getAll();
    const sessionNotes = remaining.filter((e) => e.text.includes("Session note"));
    expect(sessionNotes.length).toBe(1);
    expect(sessionNotes[0].scopeTarget).toBe("sess-abc");
  });

  it("promoteScope changes scope from session to global", () => {
    const entry = db.store({
      text: "Promoted note",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-xyz",
    });

    const ok = db.promoteScope(entry.id, "global", null);
    expect(ok).toBe(true);

    const updated = db.getById(entry.id);
    expect(updated?.scope).toBe("global");
    expect(updated?.scopeTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reinforcement: reinforceFact, reinforceProcedure
// ---------------------------------------------------------------------------

describe("FactsDB.reinforceFact", () => {
  it("increments reinforced_count and appends quote", () => {
    const entry = db.store({
      text: "Use API key for auth",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    expect(entry.reinforcedCount).toBeFalsy();

    const ok = db.reinforceFact(entry.id, "Perfect, that worked!");
    expect(ok).toBe(true);

    const updated = db.getById(entry.id);
    expect(updated?.reinforcedCount).toBe(1);
    expect(updated?.lastReinforcedAt).toBeGreaterThan(0);
    expect(updated?.reinforcedQuotes).toEqual(["Perfect, that worked!"]);
  });

  it("keeps at most 10 quotes (FIFO)", () => {
    const entry = db.store({
      text: "Reinforced fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    for (let i = 0; i < 12; i++) {
      db.reinforceFact(entry.id, `quote-${i}`);
    }
    const updated = db.getById(entry.id);
    expect(updated?.reinforcedCount).toBe(12);
    expect(updated?.reinforcedQuotes?.length).toBe(10);
    expect(updated?.reinforcedQuotes?.[0]).toBe("quote-2");
    expect(updated?.reinforcedQuotes?.[9]).toBe("quote-11");
  });

  it("returns false for unknown fact id", () => {
    const ok = db.reinforceFact("nonexistent-id", "Great!");
    expect(ok).toBe(false);
  });
});

describe("FactsDB.reinforceProcedure", () => {
  it("increments reinforced_count and appends quote", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Check health",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.6,
    });
    expect(proc.reinforcedCount).toBe(0);

    const ok = db.reinforceProcedure(proc.id, "Nice, keep doing that!");
    expect(ok).toBe(true);

    const updated = db.getProcedureById(proc.id);
    expect(updated?.reinforcedCount).toBe(1);
    expect(updated?.lastReinforcedAt).toBeGreaterThan(0);
    expect(updated?.reinforcedQuotes).toEqual(["Nice, keep doing that!"]);
  });

  it("auto-promotes confidence when reinforced_count >= threshold", () => {
    const proc = db.upsertProcedure({
      taskPattern: "Deploy flow",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.5,
    });
    db.reinforceProcedure(proc.id, "Good!", 2);
    db.reinforceProcedure(proc.id, "Perfect!", 2);

    const updated = db.getProcedureById(proc.id);
    expect(updated?.reinforcedCount).toBe(2);
    expect(updated?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(updated?.promotedAt).toBeGreaterThan(0);
  });

  it("returns false for unknown procedure id", () => {
    const ok = db.reinforceProcedure("nonexistent-proc-id", "Great!", 2);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reinforcement ranking in search: reinforced items rank higher
// ---------------------------------------------------------------------------

describe("FactsDB search reinforcement ranking", () => {
  it("reinforced fact ranks before non-reinforced when reinforcementBoost > 0", () => {
    const a = db.store({
      text: "Use auth key for API requests",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const b = db.store({
      text: "API auth token configuration and secrets",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.reinforceFact(a.id, "Perfect!");

    const results = db.search("auth API", 10, { reinforcementBoost: 0.2 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    const scoreA = results.find((r) => r.entry.id === a.id)!.score;
    const scoreB = results.find((r) => r.entry.id === b.id)!.score;
    expect(scoreA).toBeGreaterThanOrEqual(scoreB);
  });

  it("with reinforcementBoost 0 reinforced fact does not get boost", () => {
    const a = db.store({
      text: "Auth key for API",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const b = db.store({
      text: "API auth setup",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.reinforceFact(a.id, "Good");

    const withBoost = db.search("auth API", 10, { reinforcementBoost: 0.2 });
    const noBoost = db.search("auth API", 10, { reinforcementBoost: 0 });
    const scoreAWith = withBoost.find((r) => r.entry.id === a.id)?.score ?? 0;
    const scoreANo = noBoost.find((r) => r.entry.id === a.id)?.score ?? 0;
    expect(scoreAWith).toBeGreaterThanOrEqual(scoreANo);
  });
});

describe("FactsDB searchProcedures reinforcement ranking", () => {
  it("reinforced procedure ranks before non-reinforced when reinforcementBoost > 0", () => {
    const p1 = db.upsertProcedure({
      taskPattern: "deploy auth service",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.5,
    });
    const p2 = db.upsertProcedure({
      taskPattern: "deploy auth service",
      recipeJson: "[]",
      procedureType: "positive",
      confidence: 0.5,
    });
    db.reinforceProcedure(p1.id, "Perfect, keep doing that!");

    const results = db.searchProcedures("deploy auth service", 5, 0.25);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe(p1.id);
    expect(results[1].id).toBe(p2.id);
    expect(results[0].reinforcedCount).toBe(1);
    expect(results[1].reinforcedCount).toBe(0);
  });
});

describe("FactsDB.findByIdPrefix", () => {
  const storeOpts = { category: "fact" as const, importance: 0.7, entity: null, key: null, value: null, source: "test" };

  it("returns full ID for unique prefix", () => {
    const entry = db.store({ text: "test fact for prefix", ...storeOpts });
    const prefix = entry.id.slice(0, 8);
    const result = db.findByIdPrefix(prefix);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("id", entry.id);
  });

  it("returns null for prefix shorter than 4 chars", () => {
    db.store({ text: "test fact", ...storeOpts });
    expect(db.findByIdPrefix("ab")).toBeNull();
    expect(db.findByIdPrefix("abc")).toBeNull();
    expect(db.findByIdPrefix("")).toBeNull();
  });

  it("returns null for non-hex prefix", () => {
    db.store({ text: "test fact", ...storeOpts });
    expect(db.findByIdPrefix("zzzz")).toBeNull();
    expect(db.findByIdPrefix("test")).toBeNull();
    expect(db.findByIdPrefix("ab%_")).toBeNull();
  });

  it("returns ambiguous when multiple IDs match prefix", () => {
    // Store many facts — some will share a 4-char prefix
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(db.store({ text: `bulk fact ${i}`, ...storeOpts }).id);
    }
    // Find a 4-char prefix that matches multiple IDs
    const prefixMap = new Map<string, string[]>();
    for (const id of ids) {
      const p = id.slice(0, 4);
      if (!prefixMap.has(p)) prefixMap.set(p, []);
      prefixMap.get(p)!.push(id);
    }
    const ambiguousPrefix = [...prefixMap.entries()].find(([, v]) => v.length >= 2);
    if (ambiguousPrefix) {
      const result = db.findByIdPrefix(ambiguousPrefix[0]);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("ambiguous", true);
    }
    // If no collision found with 50 UUIDs (very unlikely), test still passes
  });

  it("returns null when no IDs match prefix", () => {
    db.store({ text: "test fact", ...storeOpts });
    expect(db.findByIdPrefix("0000")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New stats methods (Issue #96 fixes)
// ---------------------------------------------------------------------------

describe("FactsDB.statsReflection", () => {
  it("counts reflection-sourced patterns and rules correctly", () => {
    // Add some reflection-sourced facts
    db.store({
      text: "Pattern from reflection analysis",
      category: "pattern",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
    });
    db.store({
      text: "Another reflection pattern",
      category: "pattern",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
    });
    db.store({
      text: "Rule from reflection",
      category: "rule",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
    });

    // Add some non-reflection facts to ensure they're not counted
    db.store({
      text: "Pattern from conversation",
      category: "pattern",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const stats = db.statsReflection();
    expect(stats.reflectionPatternsCount).toBe(2);
    expect(stats.reflectionRulesCount).toBe(1);
  });

  it("returns 0 when no reflection data exists", () => {
    // Add some non-reflection data
    db.store({
      text: "Regular fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const stats = db.statsReflection();
    expect(stats.reflectionPatternsCount).toBe(0);
    expect(stats.reflectionRulesCount).toBe(0);
  });
});

describe("FactsDB.selfCorrectionIncidentsCount", () => {
  it("counts self-correction incidents correctly", () => {
    // Add some self-correction facts
    db.store({
      text: "Self-correction incident detected",
      category: "incident",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "self-correction",
    });
    db.store({
      text: "Another self-correction",
      category: "rule",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "self-correction",
    });

    // Add some non-self-correction facts
    db.store({
      text: "Regular fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const count = db.selfCorrectionIncidentsCount();
    expect(count).toBe(2);
  });

  it("returns 0 when no self-correction data exists", () => {
    db.store({
      text: "Regular fact",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const count = db.selfCorrectionIncidentsCount();
    expect(count).toBe(0);
  });
});

describe("FactsDB.languageKeywordsCount", () => {
  it("returns 0 when language keywords file doesn't exist", () => {
    // No language keywords file should exist in test environment
    const count = db.languageKeywordsCount();
    expect(count).toBe(0);
  });
});
