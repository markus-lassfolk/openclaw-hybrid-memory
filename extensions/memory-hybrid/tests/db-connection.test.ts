/**
 * Verifies that FactsDB, CredentialsDB, and VectorDB auto-reconnect after their
 * underlying connection is closed (e.g. by stop()/SIGUSR1 graceful restart).
 *
 * FactsDB/CredentialsDB use the liveDb getter to reopen SQLite connections.
 * VectorDB uses auto-reconnect logic in ensureInitialized() to reopen LanceDB.
 *
 * Without this, callers would get "The database connection is not open" (SQLite)
 * or "VectorDB is closed" (LanceDB) on the next call after a restart.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { FactsDB, CredentialsDB, VectorDB } = _testing;

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars";

/** Close the internal SQLite connection without going through the public close(). Simulates SIGUSR1. */
function closeInternalConnection(instance: InstanceType<typeof FactsDB> | InstanceType<typeof CredentialsDB>): void {
  const conn = (instance as unknown as { db: { close: () => void } }).db;
  expect(conn).toBeDefined();
  conn.close();
}

// ---------------------------------------------------------------------------
// FactsDB: must use liveDb so operations succeed after connection close
// ---------------------------------------------------------------------------

describe("FactsDB uses live connection (no stale this.db)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "facts-live-db-test-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getById reopens connection after internal close", () => {
    const entry = db.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    closeInternalConnection(db);
    const found = db.getById(entry.id);
    expect(found).not.toBeNull();
    expect(found!.text).toBe("User prefers dark mode");
  });

  it("store reopens connection after internal close", () => {
    closeInternalConnection(db);
    const entry = db.store({
      text: "New fact after reopen",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    expect(entry.id).toBeDefined();
    expect(entry.text).toBe("New fact after reopen");
  });

  it("search reopens connection after internal close", () => {
    db.store({
      text: "Nibe heat pump configuration",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    closeInternalConnection(db);
    const results = db.search("Nibe", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toContain("Nibe");
  });

  it("count reopens connection after internal close", () => {
    db.store({
      text: "One",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    closeInternalConnection(db);
    expect(db.count()).toBe(1);
  });

  it("lookup reopens connection after internal close", () => {
    db.store({
      text: "User theme preference",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
    });
    closeInternalConnection(db);
    const results = db.lookup("user", "theme");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.entity).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// CredentialsDB: must use liveDb so operations succeed after connection close
// ---------------------------------------------------------------------------

describe("CredentialsDB uses live connection (no stale this.db)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof CredentialsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cred-live-db-test-"));
    db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_ENCRYPTION_KEY);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("get reopens connection after internal close", () => {
    db.store({ service: "github", type: "api_key", value: "ghp_secret123" });
    closeInternalConnection(db);
    const retrieved = db.get("github", "api_key");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.value).toBe("ghp_secret123");
  });

  it("store reopens connection after internal close", () => {
    closeInternalConnection(db);
    db.store({ service: "openai", type: "api_key", value: "sk-secret" });
    const retrieved = db.get("openai", "api_key");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.value).toBe("sk-secret");
  });

  it("list reopens connection after internal close", () => {
    db.store({ service: "github", type: "api_key", value: "x" });
    closeInternalConnection(db);
    const list = db.list();
    expect(list.length).toBe(1);
    expect(list[0].service).toBe("github");
  });

  it("delete reopens connection after internal close", () => {
    db.store({ service: "test", type: "api_key", value: "v" });
    closeInternalConnection(db);
    expect(db.delete("test", "api_key")).toBe(true);
    expect(db.get("test", "api_key")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VectorDB: must auto-reconnect after close() (e.g., stop()/SIGUSR1 restart)
// ---------------------------------------------------------------------------

describe("VectorDB auto-reconnects after close()", () => {
  let tmpDir: string;
  let db: InstanceType<typeof VectorDB>;
  const VECTOR_DIM = 3; // tiny vectors for speed

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-db-reconnect-test-"));
    db = new VectorDB(join(tmpDir, "lance"), VECTOR_DIM);
    // Initialize by storing one vector
    await db.store({ text: "initial fact", vector: [0.1, 0.2, 0.3], importance: 0.7, category: "fact" });
  });

  afterEach(async () => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store succeeds after close()", async () => {
    db.close();
    // Should auto-reconnect and succeed, not throw "VectorDB is closed"
    const id = await db.store({ text: "post-close fact", vector: [0.4, 0.5, 0.6], importance: 0.8, category: "technical" });
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  it("search succeeds after close() and returns the known stored fact", async () => {
    // "initial fact" with vector [0.1, 0.2, 0.3] was stored in beforeEach.
    // After close + auto-reconnect, search must find it — not just return any array.
    db.close();
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toBe("initial fact");
  });

  it("hasDuplicate returns true for the known stored vector after close()", async () => {
    // The exact same vector [0.1, 0.2, 0.3] was stored in beforeEach (distance = 0, score = 1.0).
    // hasDuplicate must return true — not just any boolean. Returning false would mean
    // reconnect silently failed and the error was swallowed.
    db.close();
    const isDup = await db.hasDuplicate([0.1, 0.2, 0.3], 0.95);
    expect(isDup).toBe(true);
  });

  it("count returns the actual row count after close()", async () => {
    // Exactly 1 row stored in beforeEach. Count must return 1 — not just any number.
    // Returning 0 would mean reconnect silently failed and the error was swallowed.
    db.close();
    const n = await db.count();
    expect(n).toBe(1);
  });

  it("multiple concurrent operations after close() return real results", async () => {
    db.close();
    // Simulate multiple concurrent calls (e.g., 3-4 agents retrying after restart).
    // Assertions verify actual content — not just that values are defined/typed.
    const [id1, id2, results] = await Promise.all([
      db.store({ text: "agent1 fact", vector: [0.1, 0.2, 0.3], importance: 0.7, category: "fact" }),
      db.store({ text: "agent2 fact", vector: [0.4, 0.5, 0.6], importance: 0.7, category: "fact" }),
      db.search([0.1, 0.2, 0.3], 3, 0),
    ]);
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
    expect(typeof id2).toBe("string");
    expect(id2.length).toBeGreaterThan(0);
    // Search was concurrent with the stores but ran against the already-open reconnected DB.
    // At minimum the "initial fact" stored in beforeEach must be present.
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toBe("initial fact");
  });
});
