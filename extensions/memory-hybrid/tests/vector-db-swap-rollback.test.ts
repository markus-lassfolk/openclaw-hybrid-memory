import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { rename as renameFsPath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeReadersByPath } from "../backends/vector-db/runtime-locks.js";
import { VectorDB } from "../backends/vector-db.js";

describe("VectorDB swap rollback", () => {
  let testDbPath = "";

  beforeEach(() => {
    // swapShadowTable()'s path-containment guard (loop iteration 17) only allows removing table
    // directories under ~/.openclaw/memory unless this is set — tests use an arbitrary tmpdir.
    vi.stubEnv("OPENCLAW_HYBRID_MEM_DANGEROUS_PATHS", "1");
  });

  afterEach(() => {
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rolls main table back when shadow->main rename fails", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();
    let renameCalls = 0;
    vi.spyOn(
      vectorDb as unknown as { renamePath: (fromPath: string, toPath: string) => Promise<void> },
      "renamePath",
    ).mockImplementation(async (fromPath, toPath) => {
      renameCalls++;
      if (renameCalls === 2) {
        throw new Error("injected failure on shadow->main rename");
      }
      await renameFsPath(fromPath, toPath);
    });

    for (let i = 0; i < 5; i++) {
      await vectorDb.store({
        text: `main fact ${i}`,
        vector: Array(64).fill(i / 64),
        importance: 0.7,
        category: "test",
      });
    }

    const shadowTable = await vectorDb.createShadowTable();
    for (let i = 0; i < 7; i++) {
      await vectorDb.storeToTable(shadowTable, {
        id: `bbbbbbbb-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        text: `shadow fact ${i}`,
        vector: Array(64).fill(i / 64),
        importance: 0.7,
        category: "test",
      });
    }

    await expect(vectorDb.swapShadowTable(shadowTable, 0.5, 5)).rejects.toThrow(
      /injected failure on shadow->main rename/,
    );
    await vectorDb.close();

    const vectorDbAfter = new VectorDB(testDbPath, 64, false);
    vectorDbAfter.setLogger({ warn: vi.fn() });
    await vectorDbAfter.open();
    expect(await vectorDbAfter.count()).toBe(5);
    await vectorDbAfter.close();
  });

  it("skips reconnect when swap and rollback both fail", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    await vectorDb.store({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      text: "main fact",
      vector: Array(64).fill(0.1),
      importance: 0.7,
      category: "test",
    });
    const shadowTable = await vectorDb.createShadowTable();

    let renameCalls = 0;
    vi.spyOn(
      vectorDb as unknown as { renamePath: (fromPath: string, toPath: string) => Promise<void> },
      "renamePath",
    ).mockImplementation(async (fromPath, toPath) => {
      renameCalls++;
      if (renameCalls >= 2) {
        throw new Error(`injected rename failure #${renameCalls}`);
      }
      await renameFsPath(fromPath, toPath);
    });

    const ensureSpy = vi.spyOn(vectorDb, "ensureInitialized").mockResolvedValue(undefined);

    await expect(vectorDb.swapShadowTable(shadowTable, 0, 0)).rejects.toThrow(/rollback FAILED/);
    expect(ensureSpy).not.toHaveBeenCalled();

    const files = readdirSync(testDbPath);
    expect(files.some((f) => /^memories_old_\d+\.lance$/.test(f))).toBe(true);
    await vectorDb.close();
  });

  it("preserves old table backup when reopen health check fails", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    for (let i = 0; i < 2; i++) {
      await vectorDb.store({
        id: `cccccccc-0000-4000-8000-00000000000${i}`,
        text: `main fact ${i}`,
        vector: Array(64).fill(i / 64),
        importance: 0.7,
        category: "test",
      });
    }
    const shadowTable = await vectorDb.createShadowTable();
    for (let i = 0; i < 2; i++) {
      await vectorDb.storeToTable(shadowTable, {
        id: `dddddddd-0000-4000-8000-00000000000${i}`,
        text: `shadow fact ${i}`,
        vector: Array(64).fill(i / 64),
        importance: 0.7,
        category: "test",
      });
    }

    vi.spyOn(vectorDb, "ensureInitialized").mockResolvedValue(undefined);
    vi.spyOn(vectorDb, "isLanceAvailable").mockReturnValue(false);

    await vectorDb.swapShadowTable(shadowTable, 0.5, 2);

    const files = readdirSync(testDbPath);
    expect(files.some((f) => /^memories_old_\d+\.lance$/.test(f))).toBe(true);
    await vectorDb.close();
  });

  it("refuses to swap when dbPath is outside the default memory dir unless dangerous-paths is set (loop iteration 17 regression)", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();
    await vectorDb.store({
      text: "main fact",
      vector: Array(64).fill(0.1),
      importance: 0.7,
      category: "test",
    });
    const shadowTable = await vectorDb.createShadowTable();

    // Override this describe block's suite-wide dangerous-paths stub for this one test.
    vi.stubEnv("OPENCLAW_HYBRID_MEM_DANGEROUS_PATHS", "0");
    await expect(vectorDb.swapShadowTable(shadowTable, 0, 0)).rejects.toThrow(
      /Refusing to remove LanceDB table directories outside/,
    );
    await vectorDb.close();
  });

  it("swapShadowTable waits for an in-flight reader to release its slot before renaming table directories (loop iteration 17 regression)", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();
    await vectorDb.store({
      text: "main fact",
      vector: Array(64).fill(0.1),
      importance: 0.7,
      category: "test",
    });
    const shadowTable = await vectorDb.createShadowTable();
    await vectorDb.storeToTable(shadowTable, {
      id: "eeeeeeee-0000-4000-8000-000000000001",
      text: "shadow fact",
      vector: Array(64).fill(0.2),
      importance: 0.7,
      category: "test",
    });

    const dbPath = (vectorDb as unknown as { dbPath: string }).dbPath;
    activeReadersByPath.set(dbPath, 1); // simulate a search()/count() call still in flight
    let readerReleasedBeforeSwapCompleted = false;
    setTimeout(() => {
      readerReleasedBeforeSwapCompleted = true;
      activeReadersByPath.set(dbPath, 0);
    }, 30);

    await vectorDb.swapShadowTable(shadowTable, 0, 0);
    // Without the drain wait, swapShadowTable would close/rename the table directories while
    // the simulated reader slot is still held (count still 1), resolving before the timer fires.
    expect(readerReleasedBeforeSwapCompleted).toBe(true);
    await vectorDb.close();
  });
});
