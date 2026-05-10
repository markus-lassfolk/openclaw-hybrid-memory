import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";

describe("VectorDB swap rollback", () => {
  let testDbPath = "";

  afterEach(() => {
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("rolls main table back when shadow->main rename fails", async () => {
    testDbPath = mkdtempSync(join(tmpdir(), "vectordb-swap-rollback-"));
    const vectorDb = new VectorDB(testDbPath, 64, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();
    let renameCalls = 0;
    vi.spyOn(vectorDb as unknown as { renamePath: (fromPath: string, toPath: string) => Promise<void> }, "renamePath").mockImplementation(
      async (fromPath, toPath) => {
        renameCalls++;
        if (renameCalls === 2) {
          throw new Error("injected failure on shadow->main rename");
        }
        const fs = await import("node:fs/promises");
        await fs.rename(fromPath, toPath);
      },
    );

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

    const vectorDbAfter = new VectorDB(testDbPath, 64, false);
    vectorDbAfter.setLogger({ warn: vi.fn() });
    await vectorDbAfter.open();
    expect(await vectorDbAfter.count()).toBe(5);
    await vectorDbAfter.close();
  });
});
