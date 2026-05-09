import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageAndStats } from "../cli/commands/manage/register-storage-and-stats.js";

describe("reembed-vectorless CLI partial success reporting", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("reports storeFailures and exits with code 2 when vector writes fail", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");

    const factsDb = {
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
});
