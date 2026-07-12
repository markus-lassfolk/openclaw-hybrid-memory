/**
 * Regression tests for #2079 — slug-style (non-UUID) fact ids must be fully manageable
 * across store/getAllIds/getVectorsByFactIds/delete/deleteMany, not silently invisible to
 * diagnostics and repair once written.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  join,
  mkdtempSync,
  rmSync,
  tmpdir,
  VectorDB,
} from "./helpers/vector-db-test-shared.js";

describe("VectorDB slug-style fact ids (#2079)", () => {
  let tmpDir: string;
  let lanceDir: string;
  let db: InstanceType<typeof VectorDB>;

  const DIM = 3;
  // Real-world example from the issue report.
  const SLUG_ID = "close-goals-2026-06-27-clean-slate-final-1782588700";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-slug-id-test-"));
    lanceDir = join(tmpDir, "lance");
    db = new VectorDB(lanceDir, DIM);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store() accepts a slug-style id and returns it unchanged (no forced lowercasing)", async () => {
    const mixedCaseSlug = "Close-Goals-2026-06-27";
    const returned = await db.store({
      text: "slug id fact",
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
      id: mixedCaseSlug,
    });
    expect(returned).toBe(mixedCaseSlug);
  });

  it("getAllIds() includes a stored slug id", async () => {
    await db.store({ text: "slug fact", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact", id: SLUG_ID });
    const ids = await db.getAllIds();
    expect(ids).toContain(SLUG_ID);
  });

  it("getVectorsByFactIds() can retrieve a slug id's vector", async () => {
    // LanceDB stores vectors as Float32; compare with tolerance rather than exact equality.
    const vector = [0.4, 0.5, 0.6];
    await db.store({ text: "slug fact", vector, importance: 0.5, category: "fact", id: SLUG_ID });
    const result = await db.getVectorsByFactIds([SLUG_ID]);
    const stored = result.get(SLUG_ID);
    expect(stored).toBeDefined();
    stored?.forEach((value, i) => {
      expect(value).toBeCloseTo(vector[i], 5);
    });
  });

  it("delete() removes a slug id", async () => {
    await db.store({ text: "slug fact", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact", id: SLUG_ID });
    expect(await db.delete(SLUG_ID)).toBe(true);
    const ids = await db.getAllIds();
    expect(ids).not.toContain(SLUG_ID);
  });

  it("deleteMany() removes a mixed batch of UUID and slug ids", async () => {
    const uuidId = await db.store({ text: "uuid fact", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });
    await db.store({ text: "slug fact", vector: [0.4, 0.5, 0.6], importance: 0.5, category: "fact", id: SLUG_ID });

    const deleted = await db.deleteMany([uuidId, SLUG_ID]);

    expect(deleted).toBe(2);
    const remaining = await db.getAllIds();
    expect(remaining).not.toContain(uuidId);
    expect(remaining).not.toContain(SLUG_ID);
  });

  it("store() replaces an existing slug-id row on a duplicate-id write (EEXIST cleanup path)", async () => {
    await db.store({ text: "first", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact", id: SLUG_ID });

    // Simulate the concurrent-write race (#917): the underlying table.add() throws a
    // duplicate-id-shaped error on the *next* store() call for this row.
    await db.ensureInitialized();
    const table = (db as unknown as { getTable: () => { add: (rows: unknown[]) => Promise<void> } }).getTable();
    const originalAdd = table.add.bind(table);
    let addCalls = 0;
    table.add = async (rows: unknown[]) => {
      addCalls++;
      if (addCalls === 1) {
        throw Object.assign(new Error("Row with this id already exists"), { code: "EEXIST" });
      }
      return originalAdd(rows);
    };

    await db.store({ text: "second", vector: [0.7, 0.8, 0.9], importance: 0.6, category: "fact", id: SLUG_ID });

    const ids = await db.getAllIds();
    expect(ids.filter((id) => id === SLUG_ID)).toHaveLength(1);
    const result = await db.getVectorsByFactIds([SLUG_ID]);
    const stored = result.get(SLUG_ID);
    expect(stored).toBeDefined();
    [0.7, 0.8, 0.9].forEach((expected, i) => {
      expect(stored?.[i]).toBeCloseTo(expected, 5);
    });
  });

  it("store() rejects an id containing characters unsafe for LanceDB predicate interpolation", async () => {
    await expect(
      db.store({
        text: "bad id fact",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "fact",
        id: "not safe' OR '1'='1",
      }),
    ).rejects.toThrow(/invalid id/i);
  });

  it("storeToTable() (shadow re-index path) accepts slug ids the same way as the main table", async () => {
    await db.store({ text: "seed", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });
    const shadowTable = await db.createShadowTable();

    await db.storeToTable(shadowTable, {
      id: SLUG_ID,
      text: "shadow slug fact",
      vector: [0.2, 0.3, 0.4],
      importance: 0.5,
      category: "fact",
    });

    await expect(
      db.storeToTable(shadowTable, {
        id: "not safe' OR '1'='1",
        text: "bad shadow id",
        vector: [0.1, 0.1, 0.1],
        importance: 0.5,
        category: "fact",
      }),
    ).rejects.toThrow(/invalid id/i);
  });
});
