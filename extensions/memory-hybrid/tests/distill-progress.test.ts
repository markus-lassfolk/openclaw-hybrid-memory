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
    let state = { batch: 1, processedBlocks: 0 };

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
    state = { batch: 1, processedBlocks: 3 };
    vi.advanceTimersByTime(30_000);
    expect(lines.some((l) => /distill — still running: batch 1 processed 3\/12 blocks \(elapsed 30s\)/.test(l))).toBe(
      true,
    );

    reporter.done({ status: "partial", extracted: 0, processedBlocks: 3, batchFailures: 1, truncatedBatches: 0 });
    const doneLine = lines.at(-1) ?? "";
    expect(doneLine).toContain("distill done — status=partial");
    expect(doneLine).toContain("extracted=0");
    expect(doneLine).toContain("blocks=3/12");
    expect(doneLine).toContain("batchFailures=1");
  });

  it("stops the heartbeat after done so no further lines are emitted", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const reporter = startDistillProgress({
      verbose: true,
      logger: { info: (m: string) => lines.push(m) },
      sessions: 1,
      totalBlocks: 1,
      getState: () => ({ batch: 1, processedBlocks: 1 }),
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
      getState: () => ({ batch: 1, processedBlocks: 0 }),
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
      getState: () => ({ batch: 2, processedBlocks: 2 }),
      intervalMs: 10_000,
    });
    vi.advanceTimersByTime(10_000);
    reporter.done({ status: "ok", extracted: 3, processedBlocks: 4, batchFailures: 0, truncatedBatches: 0 });
    // Every emitted line is a structured marker; none carries free-form memory content.
    for (const line of lines) {
      expect(line.startsWith("memory-hybrid: distill")).toBe(true);
    }
  });
});
