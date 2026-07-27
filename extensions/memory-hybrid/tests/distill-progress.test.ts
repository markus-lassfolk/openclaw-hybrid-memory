import { afterEach, describe, expect, it, vi } from "vitest";
import { startDistillProgress } from "../cli/distill-progress.js";

describe("distill progress heartbeat (#2029)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits start, periodic heartbeat, and done markers in verbose mode", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m) };
    let state = { batch: 1, processedBlocks: 0, cursorBlock: 0 };

    const reporter = startDistillProgress({
      verbose: true,
      logger,
      sessions: 358,
      totalBlocks: 12,
      getState: () => state,
      intervalMs: 30_000,
    });

    // Start marker fires immediately with counts (no fact text).
    expect(lines[0]).toBe("memory-hybrid: distill start — sessions=358 blocks=12");

    // Advance into a long batch → at least one heartbeat with current block counts + elapsed.
    state = { batch: 1, processedBlocks: 3, cursorBlock: 3 };
    vi.advanceTimersByTime(30_000);
    expect(
      lines.some((l) =>
        /distill — still running: batch 1 \(block 3\/12\) processed 3\/12 blocks \(elapsed 30s\)/.test(l),
      ),
    ).toBe(true);

    reporter.done({ status: "partial", extracted: 0, processedBlocks: 3, batchFailures: 1, truncatedBatches: 0 });
    const doneLine = lines.at(-1) ?? "";
    expect(doneLine).toContain("distill done — status=partial");
    expect(doneLine).toContain("extracted=0");
    expect(doneLine).toContain("blocks=3/12");
    expect(doneLine).toContain("batchFailures=1");
    // hardBatchFailures defaults to 0 when the caller doesn't track it separately (backward compat).
    expect(doneLine).toContain("hardBatchFailures=0");
  });

  it("threads hardBatchFailures into the done line when provided (GlitchTip issue 27 diagnostics)", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = startDistillProgress({
      verbose: true,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 10,
      totalBlocks: 4,
      getState: () => ({ batch: 1, processedBlocks: 0, cursorBlock: 0 }),
      intervalMs: 30_000,
    });

    reporter.done({
      status: "partial",
      extracted: 0,
      processedBlocks: 2,
      batchFailures: 2,
      hardBatchFailures: 1,
      truncatedBatches: 1,
    });
    const doneLine = lines.at(-1) ?? "";
    expect(doneLine).toContain("batchFailures=2");
    expect(doneLine).toContain("hardBatchFailures=1");
    expect(doneLine).toContain("truncatedBatches=1");
  });

  it("stops the heartbeat after done so no further lines are emitted", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = startDistillProgress({
      verbose: true,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 1,
      totalBlocks: 1,
      getState: () => ({ batch: 1, processedBlocks: 1, cursorBlock: 1 }),
      intervalMs: 30_000,
    });
    reporter.done({ status: "ok", extracted: 5, processedBlocks: 1, batchFailures: 0, truncatedBatches: 0 });
    const countAfterDone = lines.length;
    vi.advanceTimersByTime(120_000);
    expect(lines.length).toBe(countAfterDone); // interval cleared — no stray heartbeats
  });

  it("is a no-op when not verbose (no progress lines, safe done/stop)", () => {
    const lines: string[] = [];
    const reporter = startDistillProgress({
      verbose: false,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 10,
      totalBlocks: 5,
      getState: () => ({ batch: 1, processedBlocks: 0, cursorBlock: 0 }),
    });
    reporter.done({ status: "ok", extracted: 1, processedBlocks: 5, batchFailures: 0, truncatedBatches: 0 });
    reporter.stop();
    expect(lines).toEqual([]);
  });

  it("never logs raw fact text — only counts and status", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = startDistillProgress({
      verbose: true,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 2,
      totalBlocks: 4,
      getState: () => ({ batch: 2, processedBlocks: 2, cursorBlock: 2 }),
      intervalMs: 10_000,
    });
    vi.advanceTimersByTime(10_000);
    reporter.done({ status: "ok", extracted: 3, processedBlocks: 4, batchFailures: 0, truncatedBatches: 0 });
    // Every emitted line is a structured marker; none carries free-form memory content.
    for (const line of lines) {
      expect(line.startsWith("memory-hybrid: distill")).toBe(true);
    }
  });

  it("surfaces cursorBlock so a retried batch (same block range) is distinguishable from new content (#2038)", () => {
    // Reproduces the #2038 symptom: "batch" keeps incrementing (a shrink-and-retry loop) while the
    // block range being attempted never advances. Before this fix, the heartbeat only showed
    // "batch N processed 0/1268", which looked identical whether batch N was new content or the 8th
    // retry of the same stuck block range.
    vi.useFakeTimers();
    const lines: string[] = [];
    let state = { batch: 1, processedBlocks: 0, cursorBlock: 0 };
    const reporter = startDistillProgress({
      verbose: true,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 358,
      totalBlocks: 1268,
      getState: () => state,
      intervalMs: 30_000,
    });

    state = { batch: 2, processedBlocks: 0, cursorBlock: 0 }; // batch incremented, cursorBlock did NOT
    vi.advanceTimersByTime(30_000);
    state = { batch: 3, processedBlocks: 0, cursorBlock: 0 }; // still the same stuck range
    vi.advanceTimersByTime(30_000);

    reporter.done({ status: "partial", extracted: 0, processedBlocks: 0, batchFailures: 1, truncatedBatches: 0 });

    const heartbeatLines = lines.filter((l) => l.includes("still running"));
    expect(heartbeatLines).toHaveLength(2);
    // Both heartbeats report the identical block range despite the incrementing batch number —
    // exactly the signal an operator needs to tell "stuck retry" from "advancing through new blocks".
    for (const line of heartbeatLines) {
      expect(line).toContain("(block 0/1268)");
    }
    expect(heartbeatLines[0]).toContain("batch 2");
    expect(heartbeatLines[1]).toContain("batch 3");
  });
});
