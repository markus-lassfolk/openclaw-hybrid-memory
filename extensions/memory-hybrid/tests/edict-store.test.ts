import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EdictStore } from "../backends/edict-store.js";

describe("EdictStore", () => {
  let dir: string;
  let store: EdictStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edict-store-test-"));
    store = new EdictStore(join(dir, "edicts.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("list and getEdicts work after migrations", () => {
    store.add({ text: "Verified fact one", tags: ["ops"] });
    expect(store.list()).toHaveLength(1);
    const g = store.getEdicts({ format: "prompt" });
    expect(g.edicts).toHaveLength(1);
    expect(g.renderForPrompt).toContain("Verified fact one");
  });

  it("creates expires_at_sec index on fresh databases", () => {
    const db = new DatabaseSync(join(dir, "edicts.db"));
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_edicts_expires_sec'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("idx_edicts_expires_sec");
    } finally {
      db.close();
    }
  });

  it("returns empty reads when _isReady is false (issue #964)", () => {
    (store as unknown as { _isReady: boolean })._isReady = false;
    expect(store.list()).toEqual([]);
    expect(store.getEdicts({ format: "prompt" })).toEqual({ edicts: [], renderForPrompt: "" });
    expect(store.getEdicts({ format: "full" })).toEqual({ edicts: [], renderForPrompt: "" });
  });

  it("filters by any tag and does not leak other tags (AND/OR precedence)", () => {
    const a = store.add({ text: "Verified A", tags: ["a"] });
    const b = store.add({ text: "Verified B", tags: ["b"] });
    expect(store.list({ tags: ["b"] }).map((e) => e.id)).toEqual([b.id]);
    expect(store.list({ tags: ["a"] }).map((e) => e.id)).toEqual([a.id]);
    expect(
      store
        .list({ tags: ["a", "b"] })
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("treats % and _ literally in tag filters", () => {
    const literal = store.add({ text: "Literal tag", tags: ["a%b"] });
    store.add({ text: "Wildcard-ish tag", tags: ["axb"] });
    expect(store.list({ tags: ["a%b"] }).map((e) => e.id)).toEqual([literal.id]);
  });

  it("requires expiresAt for ttl='event' and excludes expired edicts by default", () => {
    expect(() => store.add({ text: "Missing expiry", ttl: "event" })).toThrow(/requires expiresAt/i);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const expired = store.add({ text: "Expired", ttl: "event", expiresAt: past, tags: ["ops"] });
    expect(store.list({ tags: ["ops"] })).toEqual([]);
    expect(store.list({ includeExpired: true, tags: ["ops"] }).map((e) => e.id)).toEqual([expired.id]);
  });

  it("requires integer numeric TTL values", () => {
    expect(() => store.add({ text: "fractional ttl", ttl: 0.5 })).toThrow(/positive integer/i);
    const created = store.add({ text: "Integer ttl", ttl: 120 });
    expect(() => store.update({ id: created.id, ttl: 3.14 })).toThrow(/positive integer/i);
  });

  it("detects duplicates using normalized_text (case/whitespace)", () => {
    store.add({ text: "Hello   World", tags: ["ops"] });
    expect(() => store.add({ text: "hello world", tags: ["ops"] })).toThrow(/already exists/i);
  });

  it("migrates legacy schemas missing id/derived columns", () => {
    const legacyPath = join(dir, "legacy-edicts.db");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE edicts (
        text TEXT NOT NULL,
        source TEXT,
        verified_at INTEGER,
        expires_at TEXT,
        ttl TEXT NOT NULL DEFAULT 'never',
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO edicts (text, source, verified_at, expires_at, ttl, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("Legacy row", null, 0, null, "never", "ops", 1, 1);
    db.close();

    const legacy = new EdictStore(legacyPath);
    try {
      const rows = legacy.list({ includeExpired: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toMatch(/^e_/);
      expect(legacy.getById(rows[0].id)?.text).toBe("Legacy row");
    } finally {
      legacy.close();
    }
  });

  it("backfills missing ids when legacy table already has id column", () => {
    const legacyPath = join(dir, "legacy-existing-id-edicts.db");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE edicts (
        id TEXT,
        text TEXT NOT NULL,
        source TEXT,
        verified_at INTEGER,
        expires_at TEXT,
        ttl TEXT NOT NULL DEFAULT 'never',
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO edicts (id, text, source, verified_at, expires_at, ttl, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(null, "Legacy row with null id", null, 0, null, "never", "ops", 1, 1);
    db.close();

    const legacy = new EdictStore(legacyPath);
    try {
      const rows = legacy.list({ includeExpired: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toMatch(/^e_/);
      expect(legacy.getById(rows[0].id)?.text).toBe("Legacy row with null id");
    } finally {
      legacy.close();
    }
  });

  it("treats legacy ttl='event' rows without valid expiry as expired (fail-closed)", () => {
    const legacyPath = join(dir, "legacy-event-edicts.db");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE edicts (
        text TEXT NOT NULL,
        source TEXT,
        verified_at INTEGER,
        expires_at TEXT,
        ttl TEXT NOT NULL DEFAULT 'never',
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO edicts (text, source, verified_at, expires_at, ttl, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("Legacy event row", null, 0, null, "event", "ops", 1, 1);
    db.close();

    const legacy = new EdictStore(legacyPath);
    try {
      expect(legacy.list({ tags: ["ops"] })).toEqual([]);
      const includeExpired = legacy.list({ includeExpired: true, tags: ["ops"] });
      expect(includeExpired).toHaveLength(1);
      expect(legacy.isExpired(includeExpired[0])).toBe(true);
      expect(legacy.stats().expired).toBe(1);
      expect(legacy.pruneExpired()).toBe(1);
      expect(legacy.list({ includeExpired: true, tags: ["ops"] })).toEqual([]);
    } finally {
      legacy.close();
    }
  });
});
