// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const { replayWalEntriesWithRepair } = vi.hoisted(() => ({ replayWalEntriesWithRepair: vi.fn() }));

vi.mock("../utils/wal-replay.js", () => ({ replayWalEntriesWithRepair }));

import {
  assertWalFlushSucceeded,
  requireWalFlushBeforeMutation,
  runPreConsolidationFlush,
  WAL_FLUSH_ABORT_MESSAGE,
} from "../services/pre-consolidation-flush.js";

describe("runPreConsolidationFlush", () => {
  beforeEach(() => {
    replayWalEntriesWithRepair.mockReset();
  });

  it("returns zeroes when WAL is unavailable", async () => {
    const result = await runPreConsolidationFlush(
      { wal: null, factsDb: {} as never, vectorDb: {} as never, embeddings: {} as never },
      {},
      "test-phase",
    );

    expect(result).toEqual({ committed: 0, skipped: 0, failed: false });
    expect(replayWalEntriesWithRepair).not.toHaveBeenCalled();
  });

  it("replays pending WAL entries and returns counts", async () => {
    replayWalEntriesWithRepair.mockResolvedValue({ committed: 2, skipped: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runPreConsolidationFlush(
      {
        wal: {} as never,
        factsDb: {} as never,
        vectorDb: {} as never,
        embeddings: {} as never,
      },
      logger,
      "test-phase",
    );

    expect(result).toEqual({ committed: 2, skipped: 1, failed: false });
    expect(logger.info).toHaveBeenCalledWith("memory-hybrid: test-phase — WAL replay: 2 committed, 1 skipped");
  });

  it("marks failed=true when WAL replay throws", async () => {
    replayWalEntriesWithRepair.mockRejectedValue(new Error("wal boom"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await runPreConsolidationFlush(
      {
        wal: {} as never,
        factsDb: {} as never,
        vectorDb: {} as never,
        embeddings: {} as never,
      },
      logger,
      "test-phase",
    );

    expect(result).toEqual({ committed: 0, skipped: 0, failed: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("WAL replay failed"));
  });
});

describe("requireWalFlushBeforeMutation", () => {
  beforeEach(() => {
    replayWalEntriesWithRepair.mockReset();
  });

  it("throws with a shared abort message when WAL replay fails", async () => {
    replayWalEntriesWithRepair.mockRejectedValue(new Error("wal boom"));

    await expect(
      requireWalFlushBeforeMutation(
        { wal: {} as never, factsDb: {} as never, vectorDb: {} as never, embeddings: {} as never },
        {},
        "cli_consolidation",
      ),
    ).rejects.toThrow(`${WAL_FLUSH_ABORT_MESSAGE} (cli_consolidation)`);
  });

  it("returns replay counts when WAL replay succeeds", async () => {
    replayWalEntriesWithRepair.mockResolvedValue({ committed: 1, skipped: 0 });

    await expect(
      requireWalFlushBeforeMutation(
        { wal: {} as never, factsDb: {} as never, vectorDb: {} as never, embeddings: {} as never },
        {},
        "run_all_maintenance",
      ),
    ).resolves.toEqual({ committed: 1, skipped: 0 });
  });

  it("assertWalFlushSucceeded throws only when failed=true", () => {
    expect(() => assertWalFlushSucceeded({ committed: 0, skipped: 0, failed: false }, "test")).not.toThrow();
    expect(() => assertWalFlushSucceeded({ committed: 0, skipped: 0, failed: true }, "test")).toThrow(
      `${WAL_FLUSH_ABORT_MESSAGE} (test)`,
    );
  });
});
