/**
 * VectorDB init-timeout recovery (issue #1495).
 * After a transient init timeout, lanceDbAvailable=false but lanceInitFailed=false.
 * Vector ops must still call ensureInitialized() so the retry path can run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";

describe("VectorDB init-timeout recovery (issue #1495)", () => {
  const DIM = 3;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setTimeoutDegradedState(db: VectorDB): void {
    const internals = db as unknown as {
      lanceDbAvailable: boolean;
      lanceInitFailed: boolean;
    };
    internals.lanceDbAvailable = false;
    internals.lanceInitFailed = false;
  }

  it("search() calls ensureInitialized() after a transient timeout (not a permanent failure)", async () => {
    const db = new VectorDB("/tmp/test-lance-timeout-search", DIM);
    setTimeoutDegradedState(db);

    const ensureSpy = vi
      .spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized")
      .mockResolvedValue(undefined);

    await db.search(new Array(DIM).fill(0.1), 5, 0);

    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("store() calls ensureInitialized() after a transient timeout", async () => {
    const db = new VectorDB("/tmp/test-lance-timeout-store", DIM);
    setTimeoutDegradedState(db);

    const ensureSpy = vi
      .spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized")
      .mockResolvedValue(undefined);

    await db.store({ text: "t", vector: new Array(DIM).fill(0.1), importance: 0.5, category: "fact" });

    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("hasDuplicate() calls ensureInitialized() after a transient timeout", async () => {
    const db = new VectorDB("/tmp/test-lance-timeout-dup", DIM);
    setTimeoutDegradedState(db);

    const ensureSpy = vi
      .spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized")
      .mockResolvedValue(undefined);

    await db.hasDuplicate(new Array(DIM).fill(0.1));

    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("delete() calls ensureInitialized() after a transient timeout", async () => {
    const db = new VectorDB("/tmp/test-lance-timeout-del", DIM);
    setTimeoutDegradedState(db);

    const ensureSpy = vi
      .spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized")
      .mockResolvedValue(undefined);

    await db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("permanent connect failure (lanceInitFailed=true) skips ensureInitialized()", async () => {
    const db = new VectorDB("/tmp/test-lance-perm-fail", DIM);
    setTimeoutDegradedState(db);
    (db as unknown as { lanceInitFailed: boolean }).lanceInitFailed = true;

    const ensureSpy = vi
      .spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized")
      .mockResolvedValue(undefined);

    await db.search(new Array(DIM).fill(0.1), 5, 0);
    await db.store({ text: "t", vector: new Array(DIM).fill(0.1), importance: 0.5, category: "fact" });
    await db.hasDuplicate(new Array(DIM).fill(0.1));

    expect(ensureSpy).not.toHaveBeenCalled();
  });
});
