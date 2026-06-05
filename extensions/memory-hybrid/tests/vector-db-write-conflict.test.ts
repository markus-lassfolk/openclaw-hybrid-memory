/**
 * write conflict retries
 */
import { vi } from "vitest";

const { mockCapturePluginError } = vi.hoisted(() => ({
  mockCapturePluginError: vi.fn(),
}));

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: mockCapturePluginError,
}));

import { VectorDB, describe, expect, it, randomUUID } from "./helpers/vector-db-test-shared.js";

/** Avoid fake-timer hangs: retry backoff uses setTimeout; mock to instant resolve. */
function mockInstantWriteRetrySleep(db: VectorDB): void {
  vi.spyOn(db as unknown as { sleep: (ms: number) => Promise<void> }, "sleep").mockResolvedValue(undefined);
}

describe("VectorDB write conflict retries (#reembed-vectorless)", () => {
  const DIM = 3;

  it("retries store() on retryable commit conflicts before succeeding", async () => {
    const db = new VectorDB(`/tmp/test-lance-retry-${randomUUID()}`, DIM);
    mockInstantWriteRetrySleep(db);
    (db as unknown as { table: object }).table = {};
    const add = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error(
          "lance error: Retryable commit conflict for version 10: This Rewrite transaction was preempted by concurrent transaction Delete at version 10. Please retry.",
        ),
      )
      .mockResolvedValue(undefined);
    const del = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      db as unknown as { getTable: () => { add: typeof add; delete: typeof del } },
      "getTable",
    ).mockReturnValue({
      add,
      delete: del,
    });

    await expect(
      db.store({
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        text: "retry me",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "fact",
      }),
    ).resolves.toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("retries delete() on retryable commit conflicts before succeeding", async () => {
    const db = new VectorDB(`/tmp/test-lance-delete-retry-${randomUUID()}`, DIM);
    mockInstantWriteRetrySleep(db);
    (db as unknown as { table: object }).table = {};
    const del = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error(
          "lance error: Retryable commit conflict for version 10: This Delete transaction was preempted by concurrent transaction Rewrite at version 10. Please retry.",
        ),
      )
      .mockResolvedValue(undefined);
    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );
    vi.spyOn(db as unknown as { getTable: () => { delete: typeof del } }, "getTable").mockReturnValue({
      delete: del,
    });

    await expect(db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).resolves.toBe(true);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("still attempts delete() when a background auto-optimize promise rejects", async () => {
    const db = new VectorDB(`/tmp/test-lance-delete-optimize-failure-${randomUUID()}`, DIM);
    (db as unknown as { table: object }).table = {};
    (db as unknown as { optimizePromise: Promise<unknown> }).optimizePromise = Promise.reject(
      new Error("retryable commit conflict during optimize"),
    );
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });
    const del = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );
    vi.spyOn(db as unknown as { getTable: () => { delete: typeof del } }, "getTable").mockReturnValue({
      delete: del,
    });

    await expect(db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).resolves.toBe(true);

    expect(del).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => w.includes("continuing with delete anyway"))).toBe(true);
  });

  it("retries optimize() on retryable commit conflicts before succeeding", async () => {
    const db = new VectorDB(`/tmp/test-lance-optimize-retry-${randomUUID()}`, DIM);
    mockInstantWriteRetrySleep(db);
    (db as unknown as { table: object }).table = {};
    const mockStats = {
      compaction: { fragmentsRemoved: 2 },
      prune: { oldVersionsRemoved: 1, bytesRemoved: 4096 },
    };
    const optimizeFn = vi
      .fn<() => Promise<typeof mockStats>>()
      .mockRejectedValueOnce(
        new Error(
          "lance error: Retryable commit conflict for version 5: This Rewrite transaction was preempted by concurrent transaction Append at version 5. Please retry.",
        ),
      )
      .mockResolvedValue(mockStats);
    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );
    vi.spyOn(db as unknown as { getTable: () => { optimize: typeof optimizeFn } }, "getTable").mockReturnValue({
      optimize: optimizeFn,
    });

    const result = await db.optimize(24 * 60 * 60 * 1000);
    expect(result).toEqual({ compacted: 2, removedFragments: 1, freedBytes: 4096 });
    expect(optimizeFn).toHaveBeenCalledTimes(2);
  });

  it("suppresses auto-optimize scheduling while runWithAutoOptimizePaused() is active", async () => {
    const db = new VectorDB(`/tmp/test-lance-autopause-${randomUUID()}`, DIM);
    (db as unknown as { table: object }).table = {};
    const add = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const del = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );
    vi.spyOn(db as unknown as { getTable: () => { add: typeof add; delete: typeof del } }, "getTable").mockReturnValue({
      add,
      delete: del,
    });
    const optimizeSpy = vi
      .spyOn(db, "optimize")
      .mockResolvedValue({ compacted: 0, removedFragments: 0, freedBytes: 0 });
    (db as unknown as { storeCount: number }).storeCount = 99;

    await db.runWithAutoOptimizePaused(async () => {
      await db.store({
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        text: "bulk write",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "fact",
      });
    });

    expect(optimizeSpy).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
