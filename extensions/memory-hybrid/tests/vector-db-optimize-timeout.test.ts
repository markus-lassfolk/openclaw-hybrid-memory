/**
 * Regression: VectorDB.optimize() must not hang the caller forever when the native
 * table.optimize() call never settles (#2081). The wait is bounded by
 * VECTORDB_OPTIMIZE_TIMEOUT_MS (overridable via
 * OPENCLAW_HYBRID_MEM_VECTORDB_OPTIMIZE_TIMEOUT_MS); the native call keeps running in the
 * background and its own `finally` still releases the optimize lock once it eventually settles.
 *
 * Uses a small real-timeout override (via env + module reset) rather than fake timers, since
 * optimize()'s retry wrapper does a dynamic import that does not interact predictably with
 * vi.useFakeTimers().
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_TIMEOUT = "OPENCLAW_HYBRID_MEM_VECTORDB_OPTIMIZE_TIMEOUT_MS";
const SHORT_TIMEOUT_MS = 200;

async function loadFreshVectorDbModule() {
  vi.resetModules();
  process.env[ENV_TIMEOUT] = String(SHORT_TIMEOUT_MS);
  const [{ VectorDB }, { isOptimizeLocked }] = await Promise.all([
    import("../backends/vector-db.js"),
    import("../backends/vector-db/runtime-locks.js"),
  ]);
  return { VectorDB, isOptimizeLocked };
}

describe("VectorDB optimize timeout (#2081)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-db-optimize-timeout-"));
    delete process.env[ENV_TIMEOUT];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[ENV_TIMEOUT];
    vi.resetModules();
  });

  it("resolves with timedOut:true instead of hanging when table.optimize() never settles", async () => {
    const { VectorDB, isOptimizeLocked } = await loadFreshVectorDbModule();
    const db = new VectorDB(join(tmpDir, "lance"), 3);
    await db.store({ text: "seed", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const dbPath = (db as unknown as { dbPath: string }).dbPath;
    const table = (db as unknown as { table: { optimize: () => Promise<unknown> } }).table;
    expect(table).toBeTruthy();
    vi.spyOn(table, "optimize").mockReturnValue(new Promise(() => {}));

    const result = await db.optimize();

    expect(result).toEqual({ compacted: 0, removedFragments: 0, freedBytes: 0, timedOut: true });
    // The native call never settled, so the lock a concurrent optimize()/swap would check is
    // still held — it only releases once the background call actually finishes.
    expect(isOptimizeLocked(dbPath)).toBe(true);

    db.close();
  });

  it("releases the optimize lock once a timed-out table.optimize() call actually settles", async () => {
    const { VectorDB, isOptimizeLocked } = await loadFreshVectorDbModule();
    const db = new VectorDB(join(tmpDir, "lance"), 3);
    await db.store({ text: "seed", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const dbPath = (db as unknown as { dbPath: string }).dbPath;
    const table = (db as unknown as { table: { optimize: () => Promise<unknown> } }).table;
    let resolveOptimize: (value: unknown) => void = () => {};
    vi.spyOn(table, "optimize").mockReturnValue(
      new Promise((resolve) => {
        resolveOptimize = resolve;
      }),
    );

    const result = await db.optimize();
    expect(result.timedOut).toBe(true);
    expect(isOptimizeLocked(dbPath)).toBe(true);

    resolveOptimize({ compaction: { fragmentsRemoved: 1 }, prune: { oldVersionsRemoved: 2, bytesRemoved: 100 } });
    // Let the still-pending native call's own finally block run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(isOptimizeLocked(dbPath)).toBe(false);
    db.close();
  });

  it("does not time out for a fast optimize() call", async () => {
    const { VectorDB } = await loadFreshVectorDbModule();
    const db = new VectorDB(join(tmpDir, "lance"), 3);
    await db.store({ text: "seed", vector: [0.1, 0.2, 0.3], importance: 0.5, category: "fact" });

    const result = await db.optimize();
    expect(result.timedOut).toBeUndefined();

    db.close();
  });
});
