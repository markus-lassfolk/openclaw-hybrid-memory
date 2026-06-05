/**
 * schema_meta versioning for crystallization + workflow SQLite stores (Issue #1430).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRYSTALLIZATION_STORE_SCHEMA_VERSION, CrystallizationStore } from "../backends/crystallization-store.js";
import { readSchemaVersion } from "../backends/sqlite-schema-meta.js";
import { WORKFLOW_STORE_SCHEMA_VERSION, WorkflowStore } from "../backends/workflow-store.js";

function captureSqliteExecStatements(fn: () => void): string[] {
  const statements: string[] = [];
  const originalExec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function execWithCapture(
    this: DatabaseSync,
    sql: string,
  ) {
    statements.push(sql);
    return originalExec.call(this, sql);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

function readVersionAtPath(dbPath: string, namespace: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return readSchemaVersion(db, namespace);
  } finally {
    db.close();
  }
}

describe("CrystallizationStore schema_meta", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "schema-meta-cryst-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets schema version on a fresh empty database", () => {
    const dbPath = join(tmpDir, "fresh.db");
    const store = new CrystallizationStore(dbPath);
    store.close();
    expect(readVersionAtPath(dbPath, "crystallization")).toBe(CRYSTALLIZATION_STORE_SCHEMA_VERSION);
  });

  it("migrates a legacy database without schema_meta", () => {
    const dbPath = join(tmpDir, "legacy.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE crystallization_proposals (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pattern_snapshot TEXT NOT NULL DEFAULT '{}',
        output_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO crystallization_proposals (id, pattern_id, skill_name, skill_content, status, pattern_snapshot, created_at, updated_at)
      VALUES ('legacy-1', 'pat-old', 'myskill', '# x', 'pending', '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    `);
    raw.close();

    const store = new CrystallizationStore(dbPath);
    expect(readVersionAtPath(dbPath, "crystallization")).toBe(CRYSTALLIZATION_STORE_SCHEMA_VERSION);
    const row = store.getById("legacy-1");
    expect(row?.status).toBe("validated");
    expect(row?.evidenceHash).toBe("pat-old");
    store.close();

    const statements = captureSqliteExecStatements(() => {
      const reopened = new CrystallizationStore(dbPath);
      reopened.close();
    });
    expect(statements.join("\n")).not.toMatch(/ALTER TABLE|UPDATE crystallization_proposals/i);
  });

  it("throws instead of re-running migrations when schema_version is corrupt", () => {
    const dbPath = join(tmpDir, "corrupt-version.db");
    const store = new CrystallizationStore(dbPath);
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run("not-a-number", "crystallization_schema_version");
    raw.close();

    expect(() => new CrystallizationStore(dbPath)).toThrow(/Invalid schema_meta crystallization_schema_version value/);
  });

  it("re-runs the latest migration when schema_version lags (version bump path)", () => {
    const dbPath = join(tmpDir, "bump.db");
    let store = new CrystallizationStore(dbPath);
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run("1", "crystallization_schema_version");
    raw.exec("DROP INDEX IF EXISTS idx_cp_created_at");
    raw.close();

    store = new CrystallizationStore(dbPath);
    expect(readVersionAtPath(dbPath, "crystallization")).toBe(CRYSTALLIZATION_STORE_SCHEMA_VERSION);

    const check = new DatabaseSync(dbPath);
    const idx = check
      .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'index' AND name = 'idx_cp_created_at'")
      .get() as { ok: number } | undefined;
    check.close();
    expect(idx?.ok).toBe(1);
    store.close();
  });
});

describe("WorkflowStore schema_meta", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "schema-meta-wf-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets schema version on a fresh empty database", () => {
    const dbPath = join(tmpDir, "wf-fresh.db");
    const store = new WorkflowStore(dbPath);
    store.close();
    expect(readVersionAtPath(dbPath, "workflow")).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
  });

  it("migrates a pre-versioning workflow database", () => {
    const dbPath = join(tmpDir, "wf-legacy.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE workflow_traces (
        id           TEXT PRIMARY KEY,
        goal         TEXT NOT NULL,
        goal_keywords TEXT NOT NULL DEFAULT '[]',
        tool_sequence TEXT NOT NULL DEFAULT '[]',
        args_hash    TEXT NOT NULL,
        outcome      TEXT NOT NULL DEFAULT 'unknown',
        tool_count   INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        session_id   TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
      );
    `);
    raw.close();

    const store = new WorkflowStore(dbPath);
    expect(readVersionAtPath(dbPath, "workflow")).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    expect(store.count()).toBe(0);
    store.close();
  });

  it("re-runs the latest migration when schema_version lags", () => {
    const dbPath = join(tmpDir, "wf-bump.db");
    let store = new WorkflowStore(dbPath);
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run("1", "workflow_schema_version");
    raw.exec("DROP INDEX IF EXISTS idx_wt_created_at");
    raw.close();

    store = new WorkflowStore(dbPath);
    expect(readVersionAtPath(dbPath, "workflow")).toBe(WORKFLOW_STORE_SCHEMA_VERSION);
    const check = new DatabaseSync(dbPath);
    const idx = check
      .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'index' AND name = 'idx_wt_created_at'")
      .get() as { ok: number } | undefined;
    check.close();
    expect(idx?.ok).toBe(1);
    store.close();
  });
});
