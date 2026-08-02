/**
 * Regression coverage for #2226: the memory graph's schema (`memory_links` table/columns/
 * indexes) had no structural validity check anywhere in the codebase, so a partial/failed
 * migration could silently degrade graph traversal and hub-guard probing with nothing surfacing
 * it. getGraphSchemaSnapshot() (backends/facts-db/housekeeping.ts) is the check; these tests
 * confirm it actually detects a missing table, missing column, and missing index rather than
 * reporting "ok" regardless of DB state.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getGraphSchemaSnapshot } from "../backends/facts-db/housekeeping.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("getGraphSchemaSnapshot (#2226)", () => {
  let db: InstanceType<typeof FactsDB> | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("reports ok=true for a freshly migrated store", () => {
    db = new FactsDB(":memory:");
    const snapshot = getGraphSchemaSnapshot(db.getRawDb());

    expect(snapshot.ok).toBe(true);
    expect(snapshot.tableExists).toBe(true);
    expect(snapshot.missingColumns).toEqual([]);
    expect(snapshot.missingIndexes).toEqual([]);
    expect(snapshot.presentColumns).toEqual(
      expect.arrayContaining(["id", "source_fact_id", "target_fact_id", "link_type", "strength", "created_at"]),
    );
  });

  it("reports ok=false with tableExists=false when memory_links is missing entirely", () => {
    db = new FactsDB(":memory:");
    const raw = db.getRawDb();
    raw.exec("DROP TABLE memory_links");

    const snapshot = getGraphSchemaSnapshot(raw);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.tableExists).toBe(false);
    expect(snapshot.presentColumns).toEqual([]);
    expect(snapshot.missingColumns.length).toBeGreaterThan(0);
    expect(snapshot.missingIndexes.length).toBeGreaterThan(0);
  });

  it("reports ok=false and lists the missing column when memory_links predates a migration", () => {
    db = new FactsDB(":memory:");
    const raw = db.getRawDb();
    // Simulate a partially-migrated table: has the base columns from before the
    // strength_updated_at additive migration (facts-migrations.ts migrateMemoryLinksTable), but
    // never got the ALTER TABLE ADD COLUMN applied (e.g. migration ran against a read-only DB).
    raw.exec("DROP TABLE memory_links");
    raw.exec(`
      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        target_fact_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL
      )
    `);

    const snapshot = getGraphSchemaSnapshot(raw);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.tableExists).toBe(true);
    expect(snapshot.missingColumns).toEqual(["strength_updated_at"]);
    // No indexes were (re-)created on the manually recreated table either.
    expect(snapshot.missingIndexes.length).toBeGreaterThan(0);
  });

  it("reports ok=false and lists missing indexes when the table has every column but no indexes", () => {
    db = new FactsDB(":memory:");
    const raw = db.getRawDb();
    raw.exec("DROP INDEX IF EXISTS idx_links_source");
    raw.exec("DROP INDEX IF EXISTS idx_links_target");
    raw.exec("DROP INDEX IF EXISTS idx_links_type");
    raw.exec("DROP INDEX IF EXISTS idx_links_source_type");

    const snapshot = getGraphSchemaSnapshot(raw);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.tableExists).toBe(true);
    expect(snapshot.missingColumns).toEqual([]);
    expect(snapshot.missingIndexes).toEqual(
      expect.arrayContaining(["idx_links_source", "idx_links_target", "idx_links_type", "idx_links_source_type"]),
    );
  });
});

describe("FactsDB.getGraphSchemaSnapshot() wrapper (#2226)", () => {
  it("delegates to getGraphSchemaSnapshot on the live DB handle", () => {
    const db = new FactsDB(":memory:");
    try {
      expect(db.getGraphSchemaSnapshot()).toEqual(getGraphSchemaSnapshot(db.getRawDb()));
    } finally {
      db.close();
    }
  });
});
