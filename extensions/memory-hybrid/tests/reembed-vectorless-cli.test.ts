import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageAndStats } from "../cli/commands/manage/register-storage-and-stats.js";
import { AllEmbeddingProvidersFailed } from "../services/embeddings.js";
import { EMBED_CALL_MAX_ATTEMPTS } from "../utils/embed-call.js";

describe("reembed-vectorless CLI partial success reporting", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("captures global vectorless SLO baseline before apply repairs (#1738)", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const fact = {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      text: "fact text",
      category: "fact",
      source: "manual",
    };

    let globalVectorlessReads = 0;
    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn((source?: string) => {
        if (source !== undefined) return 1;
        globalVectorlessReads++;
        return globalVectorlessReads === 1 ? 3 : 0;
      }),
      listVectorlessActiveFacts: vi.fn().mockReturnValue([fact]),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      embed: vi.fn(),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["reembed-vectorless", "--apply", "--limit", "1", "--batch-size", "1", "--json"], {
      from: "user",
    });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      embedded?: number;
      vectorSloRepair?: { vectorlessBefore?: number; vectorlessAfter?: number };
    };
    expect(payload.embedded).toBe(1);
    expect(payload.vectorSloRepair?.vectorlessBefore).toBe(3);
    expect(payload.vectorSloRepair?.vectorlessAfter).toBe(0);
    expect(payload.vectorSloRepair?.vectorlessBefore).toBeGreaterThan(payload.vectorSloRepair?.vectorlessAfter ?? 0);
  });

  it("reports storeFailures and exits with code 2 when vector writes fail", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const factsDb = {
      getCount: vi.fn().mockReturnValue(10),
      countVectorlessActiveFacts: vi.fn().mockReturnValue(1),
      listVectorlessActiveFacts: vi.fn().mockReturnValue([
        {
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          text: "fact text",
          category: "fact",
          source: "manual",
        },
      ]),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "lance error: Retryable commit conflict for version 10: This Rewrite transaction was preempted by concurrent transaction Delete at version 10. Please retry.",
          ),
        ),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      embed: vi.fn(),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: {
        memory: {
          categories: ["fact"],
        },
      },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: {
        resolvedSqlitePath: null,
      },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["reembed-vectorless", "--apply", "--limit", "1", "--batch-size", "1", "--json"], {
      from: "user",
    });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(2));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      storeFailures?: number;
      embedded?: number;
      skipped?: number;
    };
    expect(payload.storeFailures).toBe(1);
    expect(payload.embedded).toBe(0);
    expect(payload.skipped).toBe(1);
    expect(vectorDb.runWithAutoOptimizePaused).toHaveBeenCalledTimes(1);
  });

  it("fast-fails and exits with code 1 on embedding provider 5xx (no per-fact fallback)", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const providerError = Object.assign(
      new Error(
        'Request failed with status code 500: {"error":{"message":"The server had an error while processing your request. Sorry about that!","type":"server_error","code":null}}',
      ),
      { status: 500 },
    );

    // 10 facts across 2 batches of 5
    const facts = Array.from({ length: 10 }, (_, i) => ({
      id: `fact-id-${i.toString().padStart(2, "0")}`,
      text: `fact text ${i}`,
      category: "fact",
      source: "manual",
    }));

    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn().mockReturnValue(facts.length),
      listVectorlessActiveFacts: vi.fn().mockReturnValue(facts),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      // embedBatch fails with 5xx; command should abort before per-fact fallback.
      embedBatch: vi.fn().mockRejectedValue(providerError),
      embed: vi.fn().mockRejectedValue(providerError),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(
      ["reembed-vectorless", "--apply", "--limit", "10", "--batch-size", "5", "--max-embed-failures", "3", "--json"],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      failedReason?: string;
      embedFailures?: number;
      embedded?: number;
    };
    expect(payload.failedReason).toBe("failed_embedding_provider_5xx");
    expect(payload.embedded).toBe(0);
    expect(payload.embedFailures).toBe(0);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(EMBED_CALL_MAX_ATTEMPTS);
  });

  it("preserves Retry-After from AllEmbeddingProvidersFailed causes during adaptive backoff", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const facts = Array.from({ length: 4 }, (_, i) => ({
      id: `retry-after-fact-${i.toString().padStart(2, "0")}`,
      text: `retry-after fact text ${i}`,
      category: "fact",
      source: "manual",
    }));

    const nestedRateLimitError = Object.assign(new Error("provider rate limited"), {
      status: 429,
      headers: { "retry-after": "2" },
    });
    const chainError = new AllEmbeddingProvidersFailed([nestedRateLimitError]);

    let globalVectorlessReads = 0;
    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn((source?: string) => {
        if (source !== undefined) return facts.length;
        globalVectorlessReads++;
        return globalVectorlessReads === 1 ? facts.length : 0;
      }),
      listVectorlessActiveFacts: vi.fn().mockReturnValue(facts),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi.fn().mockRejectedValue(chainError),
      embed: vi.fn().mockResolvedValue([0.6, 0.7, 0.8]),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sleepSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await mem.parseAsync(
      [
        "reembed-vectorless",
        "--apply",
        "--limit",
        "4",
        "--batch-size",
        "3",
        "--adaptive-catch-up",
        "--batch-delay-ms",
        "0",
        "--json",
      ],
      { from: "user" },
    );

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      failedReason?: string;
      embedded?: number;
      vectorSloRepair?: {
        sloScope?: string;
        vectorlessBefore?: number;
        vectorlessAfter?: number;
        vectorlessToClearForSlo?: number;
        estimatedRunsToReachSlo?: number;
        targetVectorlessRatio?: number;
      };
      adaptive?: {
        adjustments?: Array<{ reason?: string; retryAfterMs?: number; delayMs?: number }>;
      };
    };
    expect(payload.failedReason).toBeUndefined();
    expect(payload.embedded).toBe(4);
    expect(payload.vectorSloRepair?.sloScope).toBe("global");
    expect(payload.vectorSloRepair?.targetVectorlessRatio).toBe(0.02);
    expect(payload.vectorSloRepair?.estimatedRunsToReachSlo).toBeGreaterThanOrEqual(0);
    expect(payload.vectorSloRepair?.vectorlessBefore).toBe(4);
    expect(payload.vectorSloRepair?.vectorlessAfter).toBe(0);
    expect(payload.adaptive?.adjustments?.some((a) => a.reason === "pressure" && a.retryAfterMs === 2000)).toBe(true);
    expect(sleepSpy.mock.calls.some(([handler, delay]) => typeof handler === "function" && delay === 3000)).toBe(true);
  });

  it("honors Retry-After above adaptive max delay during adaptive backoff", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const facts = Array.from({ length: 4 }, (_, i) => ({
      id: `retry-after-high-fact-${i.toString().padStart(2, "0")}`,
      text: `retry-after high fact text ${i}`,
      category: "fact",
      source: "manual",
    }));

    const nestedRateLimitError = Object.assign(new Error("provider rate limited"), {
      status: 429,
      headers: { "retry-after": "17" },
    });
    const chainError = new AllEmbeddingProvidersFailed([nestedRateLimitError]);

    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn().mockReturnValue(facts.length),
      listVectorlessActiveFacts: vi.fn().mockReturnValue(facts),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi.fn().mockRejectedValue(chainError),
      embed: vi.fn().mockResolvedValue([0.6, 0.7, 0.8]),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sleepSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await mem.parseAsync(
      [
        "reembed-vectorless",
        "--apply",
        "--limit",
        "4",
        "--batch-size",
        "3",
        "--adaptive-catch-up",
        "--batch-delay-ms",
        "0",
        "--json",
      ],
      { from: "user" },
    );

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      adaptive?: {
        adjustments?: Array<{ reason?: string; retryAfterMs?: number; delayMs?: number }>;
      };
    };
    expect(
      payload.adaptive?.adjustments?.some(
        (a) => a.reason === "pressure" && a.retryAfterMs === 17_000 && a.delayMs === 25_500,
      ),
    ).toBe(true);
    expect(sleepSpy.mock.calls.some(([handler, delay]) => typeof handler === "function" && delay === 25_500)).toBe(
      true,
    );
  });

  it("backs off adaptively on rate-limit pressure and reports pacing adjustments", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const facts = Array.from({ length: 6 }, (_, i) => ({
      id: `fact-id-${i.toString().padStart(2, "0")}`,
      text: `fact text ${i}`,
      category: "fact",
      source: "manual",
    }));

    const rateLimitError = Object.assign(new Error("429 rate limit"), { status: 429 });

    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn().mockReturnValue(facts.length),
      listVectorlessActiveFacts: vi.fn().mockReturnValue(facts),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([
          [0.1, 0.2, 0.3],
          [0.2, 0.3, 0.4],
        ])
        .mockResolvedValueOnce([
          [0.3, 0.4, 0.5],
          [0.4, 0.5, 0.6],
        ])
        .mockRejectedValue(rateLimitError),
      embed: vi.fn().mockResolvedValue([0.6, 0.7, 0.8]),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "reembed-vectorless",
        "--apply",
        "--limit",
        "6",
        "--batch-size",
        "2",
        "--adaptive-catch-up",
        "--batch-delay-ms",
        "0",
        "--json",
      ],
      { from: "user" },
    );

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      failedReason?: string;
      embedded?: number;
      adaptive?: {
        baselineBatchSize: number;
        effectiveBatchSize: number;
        adjustments?: Array<{ reason?: string; batchRateLimited?: number }>;
      };
    };
    expect(payload.failedReason).toBeUndefined();
    expect(payload.embedded).toBe(6);
    expect(payload.adaptive?.baselineBatchSize).toBe(2);
    expect(payload.adaptive?.adjustments?.some((a) => a.reason === "ramp-up")).toBe(true);
    expect(payload.adaptive?.adjustments?.some((a) => a.reason === "pressure" && (a.batchRateLimited ?? 0) > 0)).toBe(
      true,
    );
  });

  it("backs off adaptively when embed failures occur in a batch", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const facts = Array.from({ length: 4 }, (_, i) => ({
      id: `embed-fail-fact-${i.toString().padStart(2, "0")}`,
      text: `fact text ${i}`,
      category: "fact",
      source: "manual",
    }));

    const embedError = new Error("embedding service unavailable");

    const factsDb = {
      getCount: vi.fn().mockReturnValue(100),
      countVectorlessActiveFacts: vi.fn().mockReturnValue(facts.length),
      listVectorlessActiveFacts: vi.fn().mockReturnValue(facts),
      storeEmbedding: vi.fn(),
      setEmbeddingModel: vi.fn(),
    };
    const vectorDb = {
      runWithAutoOptimizePaused: vi.fn(async (fn: () => Promise<void>) => await fn()),
      delete: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    };
    const embeddings = {
      modelName: "test-embedding-model",
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([
          [0.1, 0.2, 0.3],
          [0.2, 0.3, 0.4],
        ])
        .mockRejectedValueOnce(embedError),
      embed: vi.fn().mockRejectedValue(embedError),
    };

    registerManageStorageAndStats(mem, {
      factsDb,
      vectorDb,
      aliasDb: {},
      versionInfo: { version: "test" },
      embeddings,
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: { memory: { categories: ["fact"] } },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: () => [],
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    } as any);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "reembed-vectorless",
        "--apply",
        "--limit",
        "4",
        "--batch-size",
        "2",
        "--adaptive-catch-up",
        "--batch-delay-ms",
        "0",
        "--json",
      ],
      { from: "user" },
    );

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      embedded?: number;
      embedFailures?: number;
      adaptive?: {
        effectiveBatchSize: number;
        adjustments?: Array<{ reason?: string; batchEmbedFailures?: number }>;
      };
    };
    expect(payload.embedded).toBe(2);
    expect(payload.embedFailures).toBeGreaterThan(0);
    expect(payload.adaptive?.adjustments?.some((a) => a.reason === "pressure" && (a.batchEmbedFailures ?? 0) > 0)).toBe(
      true,
    );
    expect(payload.adaptive?.effectiveBatchSize).toBeLessThan(2);
  });
});
