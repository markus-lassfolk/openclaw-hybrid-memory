/**
 * Tests for the facts-migrations module.
 *
 * Verifies that runFactsMigrations is idempotent and that the expected tables
 * and columns are created on a fresh database.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "facts-migrations-test-"));
  db = new DatabaseSync(join(tmpDir, "test.db"));

  // Apply a minimal base schema (core facts table + FTS virtual table only;
  // excludes FTS sync triggers and auxiliary indexes that FactsDB also creates)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.5,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, category, entity, key, value,
      content='facts', content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function tableExists(name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return row !== undefined;
}

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

describe("runFactsMigrations", () => {
  it("runs without error on a fresh database", () => {
    expect(() => runFactsMigrations(db)).not.toThrow();
  });

  it("is idempotent — running twice does not throw", () => {
    runFactsMigrations(db);
    expect(() => runFactsMigrations(db)).not.toThrow();
  });

  it("creates the decay columns on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "decay_class")).toBe(true);
    expect(columnExists("facts", "expires_at")).toBe(true);
    expect(columnExists("facts", "confidence")).toBe(true);
    expect(columnExists("facts", "last_confirmed_at")).toBe(true);
  });

  it("creates the tags column on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "tags")).toBe(true);
  });

  it("creates the tier column on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "tier")).toBe(true);
  });

  it("creates the scope columns on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "scope")).toBe(true);
    expect(columnExists("facts", "scope_target")).toBe(true);
  });

  it("creates the procedures table", () => {
    runFactsMigrations(db);
    expect(tableExists("procedures")).toBe(true);
  });

  it("creates the memory_links table", () => {
    runFactsMigrations(db);
    expect(tableExists("memory_links")).toBe(true);
  });

  it("creates the contradictions table", () => {
    runFactsMigrations(db);
    expect(tableExists("contradictions")).toBe(true);
  });

  it("creates the clusters and cluster_members tables", () => {
    runFactsMigrations(db);
    expect(tableExists("clusters")).toBe(true);
    expect(tableExists("cluster_members")).toBe(true);
  });

  it("creates the recall_log table", () => {
    runFactsMigrations(db);
    expect(tableExists("recall_log")).toBe(true);
  });

  it("creates the fact_embeddings table", () => {
    runFactsMigrations(db);
    expect(tableExists("fact_embeddings")).toBe(true);
  });

  it("creates the fact_variants table", () => {
    runFactsMigrations(db);
    expect(tableExists("fact_variants")).toBe(true);
  });

  it("creates the verified_facts table", () => {
    runFactsMigrations(db);
    expect(tableExists("verified_facts")).toBe(true);
  });

  it("creates the reinforcement_log table", () => {
    runFactsMigrations(db);
    expect(tableExists("reinforcement_log")).toBe(true);
  });

  it("creates the implicit_signals table", () => {
    runFactsMigrations(db);
    expect(tableExists("implicit_signals")).toBe(true);
  });

  it("creates the feedback_trajectories table", () => {
    runFactsMigrations(db);
    expect(tableExists("feedback_trajectories")).toBe(true);
  });

  it("creates the feedback_effectiveness table", () => {
    runFactsMigrations(db);
    expect(tableExists("feedback_effectiveness")).toBe(true);
  });

  it("creates the scan_cursors table", () => {
    runFactsMigrations(db);
    expect(tableExists("scan_cursors")).toBe(true);
  });

  it("creates the access_count and last_accessed_at columns on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "access_count")).toBe(true);
    expect(columnExists("facts", "last_accessed_at")).toBe(true);
  });

  it("upgrades facts_fts to include the tags column", () => {
    runFactsMigrations(db);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts_fts'`).get() as
      | { sql: string }
      | undefined;
    expect(row?.sql).toContain("tags");
  });

  it("creates provenance columns on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "provenance_session")).toBe(true);
    expect(columnExists("facts", "extraction_method")).toBe(true);
  });

  it("creates the normalized_hash column on facts", () => {
    runFactsMigrations(db);
    expect(columnExists("facts", "normalized_hash")).toBe(true);
  });

  it("creates the embedding_meta table", () => {
    runFactsMigrations(db);
    expect(tableExists("embedding_meta")).toBe(true);
  });
});
