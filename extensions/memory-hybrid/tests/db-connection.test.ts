/**
 * Verifies that FactsDB and CredentialsDB use the liveDb getter for all
 * database operations, so that after the underlying connection is closed
 * (e.g. by SIGUSR1 graceful restart) the next call reopens and succeeds.
 * If code used this.db directly instead of this.liveDb, the next call would
 * throw "The database connection is not open".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { FactsDB, CredentialsDB } = _testing;

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
