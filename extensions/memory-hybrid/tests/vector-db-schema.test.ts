/**
 * Tests for LanceDB dimension mismatch handling (issue #128).
 *
 * Covers:
 * 1. Graceful fallback: search() returns [] instead of throwing on dimension mismatch.
 * 2. Startup schema validation: doInitialize() detects and logs a mismatch when opening
 *    an existing table that was created with a different vector dimension.
 * 3. Auto-repair: when autoRepair=true, the table is dropped and recreated with the
 *    correct dimension; wasRepaired is set so callers can trigger re-embedding.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { VectorDB } = _testing;

const CORRECT_DIM = 3; // dimension used by the "current" embedding model
const WRONG_DIM = 5;   // dimension used when the table was originally created

// ---------------------------------------------------------------------------
// Helper: create a LanceDB table seeded with vectors of a given dimension.
// ---------------------------------------------------------------------------
async function seedTable(lanceDir: string, dim: number): Promise<void> {
  const seeder = new VectorDB(lanceDir, dim);
  await seeder.store({
    text: "seed fact",
    vector: new Array(dim).fill(0.1),
    importance: 0.8,
    category: "fact",
  });
  seeder.close();
}

describe("VectorDB dimension mismatch — graceful fallback (issue #128)", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
    lanceDir = join(tmpDir, "lance");
    await seedTable(lanceDir, WRONG_DIM);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search() returns [] instead of throwing on dimension mismatch", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    const results = await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
    db.close();
  });

  it("hasDuplicate() returns false instead of throwing on dimension mismatch", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    const isDuplicate = await db.hasDuplicate(new Array(CORRECT_DIM).fill(0.1));
    expect(isDuplicate).toBe(false);
    db.close();
  });
});

describe("VectorDB startup schema validation (issue #128)", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
    lanceDir = join(tmpDir, "lance");
    await seedTable(lanceDir, WRONG_DIM);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs a warning when opening a table with mismatched vector dimension", async () => {
    const warns: string[] = [];
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    db.setLogger({ warn: (msg) => warns.push(msg) });

    await db.count();

    const mismatchWarn = warns.find((w) => w.includes("dimension mismatch"));
    expect(mismatchWarn).toBeDefined();
    expect(mismatchWarn).toContain(`dim=${WRONG_DIM}`);
    expect(mismatchWarn).toContain(`dim=${CORRECT_DIM}`);
    db.close();
  });

  it("does NOT set wasRepaired when autoRepair is false (default)", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    await db.count();
    expect(db.wasRepaired).toBe(false);
    db.close();
  });

  it("logs no mismatch warning when dimensions are correct", async () => {
    const db = new VectorDB(lanceDir, WRONG_DIM);
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });
    await db.count();
    const mismatchWarn = warns.find((w) => w.includes("dimension mismatch"));
    expect(mismatchWarn).toBeUndefined();
    db.close();
  });
});

describe("VectorDB auto-repair on dimension mismatch (issue #128)", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-schema-test-"));
    lanceDir = join(tmpDir, "lance");
    await seedTable(lanceDir, WRONG_DIM);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drops and recreates the table with the correct dimension when autoRepair=true", async () => {
    const warns: string[] = [];
    const db = new VectorDB(lanceDir, CORRECT_DIM, true);
    db.setLogger({ warn: (msg) => warns.push(msg) });

    await db.count();

    expect(db.wasRepaired).toBe(true);

    const id = await db.store({
      text: "post-repair fact",
      vector: new Array(CORRECT_DIM).fill(0.5),
      importance: 0.9,
      category: "fact",
    });
    expect(typeof id).toBe("string");

    const results = await db.search(new Array(CORRECT_DIM).fill(0.5), 5, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.text).toBe("post-repair fact");

    const repairWarn = warns.find((w) => w.includes("autoRepair"));
    expect(repairWarn).toBeDefined();

    db.close();
  });

  it("table is empty after auto-repair (ready for re-embedding)", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM, true);
    await db.count();
    expect(db.wasRepaired).toBe(true);
    const count = await db.count();
    expect(count).toBe(0);
    db.close();
  });

  it("wasRepaired stays false when there is no dimension mismatch", async () => {
    const db = new VectorDB(lanceDir, WRONG_DIM, true);
    await db.count();
    expect(db.wasRepaired).toBe(false);
    db.close();
  });
});
