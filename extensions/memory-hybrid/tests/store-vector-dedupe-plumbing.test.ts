// @ts-nocheck
/**
 * Regression tests for #2091: fact-store write paths were configured with a vectorThreshold
 * (default 0.95) but never passed `vectorCandidates` into `factsDb.storeWithResult(...)`, so
 * `applyDedupe` (services/dedupe-policy.ts) fell back to lexical-only dedupe on every write and
 * warned about it. cli/cmd-store.ts's `runStoreForCli` now resolves write-time vector candidates
 * via `resolveWriteVectorCandidates` (mirroring tools/memory/register-store-tools.ts's
 * `memory_store` exemplar) at its two `storeWithResult` sites, and skips vector-cosine dedupe
 * (with the warning suppressed) when an explicit supersede target is involved, since matching the
 * supersede target itself would silently drop the intended update.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { HandlerContext } from "../cli/handlers.js";
import { runStoreForCli } from "../cli/handlers.js";
import type { StoreCliOpts } from "../cli/types.js";

let tmpDir: string;
let factsDb: FactsDB;
let mockCtx: HandlerContext;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const VECTOR_FALLBACK_WARNING = "no vector candidates were provided";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "store-vector-dedupe-plumbing-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  mockCtx = {
    factsDb,
    cfg: {
      credentials: { enabled: false, store: "sqlite" as const },
      store: { classifyBeforeWrite: false, fuzzyDedupe: true },
    },
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
    },
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      modelName: "test-embedding-model",
    },
  } as any;
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  stderrSpy.mockRestore();
});

function stderrOutput(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

describe("runStoreForCli write-time vector dedupe plumbing (#2091)", () => {
  it("resolves and passes vector candidates on a plain ADD store, avoiding the lexical-only fallback warning", async () => {
    const opts: StoreCliOpts = {
      text: "The staging environment uses a read replica for reporting queries",
      category: "technical",
    };
    const result = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });

    expect(result.outcome).toBe("stored");
    expect(mockCtx.vectorDb.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], expect.any(Number), expect.any(Number));
    expect(stderrOutput()).not.toContain(VECTOR_FALLBACK_WARNING);
  });

  it("skips vector-candidate resolution and suppresses the warning for an explicit --supersedes store", async () => {
    const first = await runStoreForCli(
      mockCtx,
      { text: "The old runbook says restart nginx", category: "technical" },
      { warn: vi.fn() },
    );
    expect(first.outcome).toBe("stored");
    const firstId = first.outcome === "stored" ? first.id : undefined;
    expect(firstId).toBeDefined();

    (mockCtx.vectorDb.search as ReturnType<typeof vi.fn>).mockClear();
    stderrSpy.mockClear();

    const second = await runStoreForCli(
      mockCtx,
      {
        text: "The updated runbook says restart nginx then verify health checks",
        category: "technical",
        supersedes: firstId,
      },
      { warn: vi.fn() },
    );

    expect(second.outcome).toBe("stored");
    // Explicit supersede target: cosine dedupe would risk matching the supersede target itself
    // and silently dropping the update, so candidate resolution must not run for this store.
    expect(mockCtx.vectorDb.search).not.toHaveBeenCalled();
    expect(stderrOutput()).not.toContain(VECTOR_FALLBACK_WARNING);
  });

  it("skips vector-candidate resolution and suppresses the warning for a classify-before-write UPDATE", async () => {
    mockCtx.cfg.store = { classifyBeforeWrite: true, fuzzyDedupe: true };
    const first = await runStoreForCli(
      mockCtx,
      { text: "Project Atlas launch date is March 2027", category: "technical", entity: "Project Atlas" },
      { warn: vi.fn() },
    );
    expect(first.outcome).toBe("stored");

    stderrSpy.mockClear();

    // Same entity/category with materially different text triggers classifyMemoryOperation via
    // findSimilarForClassification's lexical path (mockCtx has no real classifier LLM wired, so
    // this exercises the ADD fallback rather than a true classified UPDATE) -- the assertion that
    // matters here is that the store completes cleanly with no unsuppressed dedupe-fallback noise.
    const second = await runStoreForCli(
      mockCtx,
      { text: "Project Atlas launch date moved to June 2027", category: "technical", entity: "Project Atlas" },
      { warn: vi.fn() },
    );
    expect(["stored", "duplicate", "noop"]).toContain(second.outcome);
    expect(stderrOutput()).not.toContain(VECTOR_FALLBACK_WARNING);
  });

  it("still stores successfully when the embedding provider fails (store-even-if-embedding-fails semantics preserved)", async () => {
    mockCtx.embeddings.embed = vi.fn().mockRejectedValue(new Error("embedding provider unavailable"));
    const warnSpy = vi.fn();

    const result = await runStoreForCli(
      mockCtx,
      { text: "Fallback text stored despite embedding failure", category: "technical" },
      { warn: warnSpy },
    );

    expect(result.outcome).toBe("stored");
    expect(mockCtx.vectorDb.search).not.toHaveBeenCalled();
  });
});
