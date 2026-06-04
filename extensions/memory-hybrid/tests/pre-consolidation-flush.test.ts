// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const { replayWalEntriesWithRepair } = vi.hoisted(() => ({ replayWalEntriesWithRepair: vi.fn() }));

vi.mock("../utils/wal-replay.js", () => ({ replayWalEntriesWithRepair }));

import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";

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

    expect(result).toEqual({ committed: 0, skipped: 0 });
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

    expect(result).toEqual({ committed: 2, skipped: 1 });
    expect(logger.info).toHaveBeenCalledWith("memory-hybrid: test-phase — WAL replay: 2 committed, 1 skipped");
  });
});
