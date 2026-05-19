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


import {
  VectorDB,
  describe,
  expect,
  it,
  randomUUID,
} from "./helpers/vector-db-test-shared.js";

describe("VectorDB write conflict retries (#reembed-vectorless)", () => {
  const DIM = 3;

  it("retries store() on retryable commit conflicts before succeeding", async () => {
    vi.useFakeTimers();
    try {
      const db = new VectorDB(`/tmp/test-lance-retry-${randomUUID()}`, DIM);
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

      const idPromise = db.store({
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        text: "retry me",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "fact",
      });

      await vi.runAllTimersAsync();
      await expect(idPromise).resolves.toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries delete() on retryable commit conflicts before succeeding", async () => {
    vi.useFakeTimers();
    try {
      const db = new VectorDB(`/tmp/test-lance-delete-retry-${randomUUID()}`, DIM);
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

      const deletePromise = db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

      await vi.runAllTimersAsync();
      await expect(deletePromise).resolves.toBe(true);
      expect(del).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
