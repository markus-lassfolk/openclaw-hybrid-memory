/**
 * Tests for services/recall-pipeline.ts (Issue #498).
 *
 * Engineering Goal 4: Testability — unit-tests run with simple stubs;
 * no live API keys, no FactsDB/VectorDB on-disk instances needed.
 *
 * Coverage:
 *   - Empty / whitespace-only query short-circuits immediately
 *   - FTS-only mode (semantic strategy disabled): no embed/vector calls
 *   - FTS + vector mode: merges results, deduplicates by id
 *   - Entity-lookup option triggers factsDb.lookup()
 *   - limitHydeOnce: HyDE runs exactly once per hydeUsedRef, skipped on subsequent calls
 *   - HyDE disabled (queryExpansion.enabled = false): no chatCompleteWithRetry call
 *   - Precomputed vector passed through without re-embedding when query unchanged
 *   - Memory-tiering filter: cold-tier results removed when enabled
 *   - hydeUsedRef state is mutated correctly across multiple calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runRecallPipelineQuery, type RecallPipelineDeps } from "../services/recall-pipeline.js";
import type { SearchResult, MemoryEntry } from "../types/memory.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import * as chatModule from "../services/chat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `fact ${id}`,
    category: "general",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "test",
    createdAt: 1_700_000_000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 0,
    confidence: 1,
    ...overrides,
  };
}

function makeSearchResult(id: string, score = 0.8, overrides: Partial<MemoryEntry> = {}): SearchResult {
  return { entry: makeEntry(id, overrides), score, backend: "sqlite" };
}

/** Minimal stub for RecallPipelineDeps with FTS-only (no semantic). */
function makeDeps(overrides: Partial<RecallPipelineDeps> = {}): RecallPipelineDeps {
  const factsDb = {
    search: vi.fn(() => [] as SearchResult[]),
    getById: vi.fn((_id: string) => null as MemoryEntry | null),
    lookup: vi.fn((_entity: string) => [] as SearchResult[]),
    getSupersededTexts: vi.fn(() => new Set<string>()),
  };

  const vectorDb = {
    search: vi.fn(async () => [] as SearchResult[]),
  };

  const embeddings = {
    embed: vi.fn(async (_text: string) => [0.1, 0.2, 0.3] as number[]),
  };

  const openai = {} as RecallPipelineDeps["openai"];

  const defaultDeps: RecallPipelineDeps = {
    factsDb,
    vectorDb,
    embeddings,
    openai,
    cfg: {
      queryExpansion: {
        enabled: false,
        maxVariants: 4,
        cacheSize: 100,
        timeoutMs: 15_000,
        skipForInteractiveTurns: true,
      },
      retrievalStrategies: ["fts5"],
      memoryTieringEnabled: false,
      rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
    },
    recallOpts: {
      tierFilter: "all",
      scopeFilter: undefined,
      reinforcementBoost: 0.1,
      diversityWeight: 1.0,
    },
    minScore: 0.0,
    pendingLLMWarnings: createPendingLLMWarnings(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
  };

  return { ...defaultDeps, ...overrides };
}

// ---------------------------------------------------------------------------
// Empty / whitespace queries
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — empty/whitespace query", () => {
  it("returns [] for empty string", async () => {
    const deps = makeDeps();
    const result = await runRecallPipelineQuery("", 10, deps, { value: false });
    expect(result).toEqual([]);
    expect(deps.factsDb.search).not.toHaveBeenCalled();
  });

  it("returns [] for whitespace-only string", async () => {
    const deps = makeDeps();
    const result = await runRecallPipelineQuery("   ", 10, deps, { value: false });
    expect(result).toEqual([]);
    expect(deps.factsDb.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FTS-only (semantic disabled)
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — FTS-only mode", () => {
  it("calls factsDb.search and returns FTS results", async () => {
    const r1 = makeSearchResult("a");
    const r2 = makeSearchResult("b");
    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([r1, r2]);

    const result = await runRecallPipelineQuery("hello world", 10, deps, { value: false });

    expect(deps.factsDb.search).toHaveBeenCalledWith("hello world", 10, deps.recallOpts);
    expect(deps.vectorDb.search).not.toHaveBeenCalled();
    expect(deps.embeddings.embed).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("does not call embed when strategies only include fts5", async () => {
    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([makeSearchResult("x")]);

    await runRecallPipelineQuery("test query", 5, deps, { value: false });

    expect(deps.embeddings.embed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Semantic mode (vector search enabled)
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — semantic mode", () => {
  it("calls embeddings.embed and vectorDb.search when semantic strategy is on", async () => {
    const ftsResult = makeSearchResult("fts-1", 0.6);
    const vecResult = makeSearchResult("vec-1", 0.9);

    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: false,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic", "fts5"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });

    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([ftsResult]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([vecResult]);
    (deps.factsDb.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === "vec-1" ? makeEntry("vec-1") : null,
    );

    const result = await runRecallPipelineQuery("vector query", 10, deps, { value: false });

    expect(deps.embeddings.embed).toHaveBeenCalledWith("vector query");
    expect(deps.vectorDb.search).toHaveBeenCalled();
    // Both fts and vector results should be present (merged)
    const ids = result.map((r) => r.entry.id);
    expect(ids).toContain("fts-1");
    expect(ids).toContain("vec-1");
  });

  it("uses precomputedVector when provided and query matches trimmed text", async () => {
    const precomputed = [1, 2, 3, 4];
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: false,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery(
      "exact query",
      5,
      deps,
      { value: false },
      {
        precomputedVector: precomputed,
      },
    );

    // Should NOT call embed since precomputedVector was provided and query matches
    expect(deps.embeddings.embed).not.toHaveBeenCalled();
    expect(deps.vectorDb.search).toHaveBeenCalledWith(precomputed, expect.any(Number), expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// Entity lookup option
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — entity option", () => {
  it("calls factsDb.lookup when opts.entity is provided", async () => {
    const entityResult = makeSearchResult("entity-fact", 0.95);
    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.factsDb.lookup as ReturnType<typeof vi.fn>).mockReturnValue([entityResult]);

    await runRecallPipelineQuery(
      "something about user",
      10,
      deps,
      { value: false },
      {
        entity: "user",
      },
    );

    expect(deps.factsDb.lookup).toHaveBeenCalledWith("user", undefined, undefined, { scopeFilter: undefined });
  });

  it("does not call factsDb.lookup when opts.entity is absent", async () => {
    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await runRecallPipelineQuery("no entity", 5, deps, { value: false });

    expect(deps.factsDb.lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// limitHydeOnce / hydeUsedRef
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — HyDE disabled (queryExpansion.enabled = false)", () => {
  it("never calls chat when queryExpansion is disabled", async () => {
    // We can observe this indirectly: if HyDE ran, it would call embed with the
    // HyDE-generated text. With HyDE off, embed is called with the raw query.
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: false,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery("a query", 5, deps, { value: false });

    // embed called with the raw query (not a HyDE expansion)
    expect(deps.embeddings.embed).toHaveBeenCalledWith("a query");
  });
});

describe("runRecallPipelineQuery — hydeUsedRef mutation", () => {
  it("limitHydeOnce marks hydeUsedRef.value = true on first call", async () => {
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["fts5"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const hydeUsedRef = { value: false };

    // With fts5 only, vector step (and HyDE) is skipped — but limitHydeOnce gate
    // is inside the vector step, so with fts5-only deps, HyDE never runs and the
    // ref stays false. Verify no mutation when semantic is off.
    await runRecallPipelineQuery("query", 5, deps, hydeUsedRef, { limitHydeOnce: true });

    expect(hydeUsedRef.value).toBe(false);
  });

  it("hydeUsedRef shared across calls prevents duplicate HyDE in semantic mode", async () => {
    // Semantic mode, HyDE enabled but will fail (no real openai) — we care that
    // the ref is set on first call so subsequent calls skip the HyDE attempt.
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 500,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: {
          llm: undefined,
          // mock getCronModelConfig path via rawCfg — not called since chatCompleteWithRetry is mocked at module level
        } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const hydeUsedRef = { value: false };

    // First call with limitHydeOnce — HyDE will fail (no real openai) but
    // should set the ref to true inside the semantic branch.
    await runRecallPipelineQuery("first call", 5, deps, hydeUsedRef, { limitHydeOnce: true });
    // hydeUsedRef.value is set to true inside the vector step
    expect(hydeUsedRef.value).toBe(true);

    // Second call — HyDE is skipped, so embed is called with raw query
    const embedCallsBefore = (deps.embeddings.embed as ReturnType<typeof vi.fn>).mock.calls.length;
    await runRecallPipelineQuery("second call", 5, deps, hydeUsedRef, { limitHydeOnce: true });
    const embedCallsAfter = (deps.embeddings.embed as ReturnType<typeof vi.fn>).mock.calls.length;

    // embed was called for the second query (with raw text, since HyDE was skipped)
    expect(embedCallsAfter).toBe(embedCallsBefore + 1);
    expect((deps.embeddings.embed as ReturnType<typeof vi.fn>).mock.calls[embedCallsBefore][0]).toBe("second call");
  });
});

// ---------------------------------------------------------------------------
// Memory-tiering filter
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — memory tiering", () => {
  it("removes cold-tier results when memoryTieringEnabled = true", async () => {
    const warmResult = makeSearchResult("warm", 0.9, { tier: "warm" });
    const coldResult = makeSearchResult("cold", 0.8, { tier: "cold" });

    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: false,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["fts5"],
        memoryTieringEnabled: true,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });

    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([warmResult, coldResult]);
    (deps.factsDb.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === "warm") return makeEntry("warm", { tier: "warm" });
      if (id === "cold") return makeEntry("cold", { tier: "cold" });
      return null;
    });

    const result = await runRecallPipelineQuery("query", 10, deps, { value: false });

    const ids = result.map((r) => r.entry.id);
    expect(ids).toContain("warm");
    expect(ids).not.toContain("cold");
  });

  it("returns all results when memoryTieringEnabled = false", async () => {
    const warmResult = makeSearchResult("warm", 0.9, { tier: "warm" });
    const coldResult = makeSearchResult("cold", 0.8, { tier: "cold" });

    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([warmResult, coldResult]);

    const result = await runRecallPipelineQuery("query", 10, deps, { value: false });

    const ids = result.map((r) => r.entry.id);
    expect(ids).toContain("warm");
    expect(ids).toContain("cold");
  });
});

// ---------------------------------------------------------------------------
// Result limit respected
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — limit", () => {
  it("returns at most limitNum results from FTS", async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => makeSearchResult(`r${i}`, 0.9 - i * 0.01));
    const deps = makeDeps();
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue(manyResults);

    const result = await runRecallPipelineQuery("query", 5, deps, { value: false });

    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Abort signal propagation — Issue #558
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — abort cancels embed after HyDE (#558)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not call embeddings.embed when vector-step timeout fires while HyDE is running", async () => {
    // Use fake timers so we can fast-forward the 30s VECTOR_STEP_TIMEOUT_MS.
    vi.useFakeTimers();

    // Make chatCompleteWithRetry hang until the passed abort signal fires (which the
    // 30s timeout inside recall-pipeline will trigger), then return a result.
    // The abort guard added by #558 must fire before embeddings.embed is called.
    vi.spyOn(chatModule, "chatCompleteWithRetry").mockImplementation(async (opts) => {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        // Safety valve — resolves when fake-timers advance past this point
        setTimeout(resolve, 60_000);
      });
      // Return a result AFTER the abort — the abort guard must prevent embed from running
      return "HyDE result that arrived after timeout abort";
    });

    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 60_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });

    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Start pipeline — it will hang inside chatCompleteWithRetry mock
    const pipelinePromise = runRecallPipelineQuery(
      "test abort query",
      5,
      deps,
      { value: false },
      {
        hydeLabel: "HyDE-test",
      },
    );

    // Advance fake timers past the 30s VECTOR_STEP_TIMEOUT_MS.
    // This fires the internal setTimeout → directiveAbort.abort() → HyDE mock resolves.
    await vi.advanceTimersByTimeAsync(31_000);

    // Pipeline should now settle (timeout path)
    await pipelinePromise;

    // Key assertion: embeddings.embed must NOT have been called after abort
    expect(deps.embeddings.embed).not.toHaveBeenCalled();
  });

  it("still calls embeddings.embed with raw query when HyDE fails non-abort", async () => {
    // When HyDE fails for a transient reason (not abort), embed should still be called
    // with the raw query — verifying the abort guard does not fire for normal HyDE failures.
    vi.spyOn(chatModule, "chatCompleteWithRetry").mockRejectedValue(
      new Error("LLM request timeout after 5000ms (model: test-model)"),
    );

    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 5_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });

    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery("raw query fallback", 5, deps, { value: false });

    // HyDE failed but the vector-step timeout did NOT fire — embed should proceed with raw query
    expect(deps.embeddings.embed).toHaveBeenCalledWith("raw query fallback");
  });
});

// ---------------------------------------------------------------------------
// HyDE skipForInteractiveTurns (#581)
// ---------------------------------------------------------------------------

describe("runRecallPipelineQuery — skipForInteractiveTurns (#581)", () => {
  beforeEach(() => {
    vi.spyOn(chatModule, "chatCompleteWithRetry").mockResolvedValue("HyDE generated text");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips HyDE when interactive=true and skipForInteractiveTurns is true (default)", async () => {
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery("my interactive query", 5, deps, { value: false }, { interactive: true });

    // HyDE was blocked — embed must be called with raw query, not HyDE-generated text
    expect(deps.embeddings.embed).toHaveBeenCalledWith("my interactive query");
    expect(chatModule.chatCompleteWithRetry).not.toHaveBeenCalled();
  });

  it("skips HyDE when interactive=true and skipForInteractiveTurns is true (parser default)", async () => {
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery("another interactive query", 5, deps, { value: false }, { interactive: true });

    expect(deps.embeddings.embed).toHaveBeenCalledWith("another interactive query");
    expect(chatModule.chatCompleteWithRetry).not.toHaveBeenCalled();
  });

  it("allows HyDE when interactive=true but skipForInteractiveTurns is explicitly false", async () => {
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: false,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runRecallPipelineQuery("query with hyde", 5, deps, { value: false }, { interactive: true });

    // HyDE was allowed — chatCompleteWithRetry must have been called
    expect(chatModule.chatCompleteWithRetry).toHaveBeenCalled();
    // embed should be called with HyDE-generated text (not raw query)
    expect(deps.embeddings.embed).toHaveBeenCalledWith("HyDE generated text");
  });

  it("allows HyDE when interactive is not set (background/cron recall)", async () => {
    const deps = makeDeps({
      cfg: {
        queryExpansion: {
          enabled: true,
          maxVariants: 4,
          cacheSize: 100,
          timeoutMs: 15_000,
          skipForInteractiveTurns: true,
        },
        retrievalStrategies: ["semantic"],
        memoryTieringEnabled: false,
        rawCfg: { llm: undefined } as unknown as RecallPipelineDeps["cfg"]["rawCfg"],
      },
    });
    (deps.factsDb.search as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.vectorDb.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // No interactive option — background/cron path
    await runRecallPipelineQuery("background query", 5, deps, { value: false });

    // HyDE was allowed on the background path
    expect(chatModule.chatCompleteWithRetry).toHaveBeenCalled();
    expect(deps.embeddings.embed).toHaveBeenCalledWith("HyDE generated text");
  });
});
