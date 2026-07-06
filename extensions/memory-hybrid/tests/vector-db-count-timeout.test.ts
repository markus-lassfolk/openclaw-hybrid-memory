/**
 * Regression: VectorDB.count() timeout must release reader slots (#1489, PR #1517).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";
import { VECTORDB_COUNT_TIMEOUT_MS } from "../utils/constants.js";
import { CORRECT_DIM } from "./helpers/vector-db-test-shared.js";

type VectorDBStatics = {
  _activeReadersByPath: Map<string, number>;
};

describe("VectorDB count timeout (#1489)", () => {
  let tmpDir: string;
  let db: VectorDB;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-db-count-timeout-"));
    db = new VectorDB(join(tmpDir, "lance"), CORRECT_DIM);
    await db.store({
      text: "seed",
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("does not hang the caller when countRows never settles, but keeps the reader slot held", async () => {
    const readers = (VectorDB as unknown as VectorDBStatics)._activeReadersByPath;
    const dbPath = (db as unknown as { dbPath: string }).dbPath;
    const table = (db as unknown as { table: { countRows: () => Promise<number> } }).table;
    expect(table).toBeTruthy();

    vi.spyOn(table, "countRows").mockReturnValue(new Promise(() => {}) as Promise<number>);
    expect(readers.get(dbPath) ?? 0).toBe(0);

    vi.useFakeTimers();
    const countPromise = db.count();
    await vi.advanceTimersByTimeAsync(VECTORDB_COUNT_TIMEOUT_MS + 1);
    const result = await countPromise;

    expect(result).toBe(0);
    // The native countRows() call never settles, so it may still be reading the table — the
    // slot must stay held (not leaked to 0) or optimize()/swapShadowTable()'s reader-drain wait
    // would proceed while a read is still in flight (loop iteration 17 regression).
    expect(readers.get(dbPath) ?? 0).toBe(1);
  });

  it("releases the reader slot once a timed-out countRows() call actually settles (loop iteration 17 regression)", async () => {
    const readers = (VectorDB as unknown as VectorDBStatics)._activeReadersByPath;
    const dbPath = (db as unknown as { dbPath: string }).dbPath;
    const table = (db as unknown as { table: { countRows: () => Promise<number> } }).table;
    expect(table).toBeTruthy();

    let resolveCountRows: (value: number) => void = () => {};
    vi.spyOn(table, "countRows").mockReturnValue(
      new Promise<number>((resolve) => {
        resolveCountRows = resolve;
      }),
    );
    expect(readers.get(dbPath) ?? 0).toBe(0);

    vi.useFakeTimers();
    const countPromise = db.count();
    await vi.advanceTimersByTimeAsync(VECTORDB_COUNT_TIMEOUT_MS + 1);
    const result = await countPromise;

    expect(result).toBe(0);
    expect(readers.get(dbPath) ?? 0).toBe(1);

    resolveCountRows(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(readers.get(dbPath) ?? 0).toBe(0);
  });
});
