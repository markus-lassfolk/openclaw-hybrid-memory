/**
 * `consolidate --threshold 0.92` had no --verbose option at all, and its underlying service
 * (services/consolidation.ts) made zero progress calls anywhere — the per-cluster LLM merge loop
 * ran with no output between clusters. An operator tailing a cron log during a long run saw
 * nothing and assumed the process hung. This adds a --verbose flag wired through the shared
 * runMaintenanceHeartbeat house pattern, with per-cluster progress threaded through the
 * consolidation service's onProgress callback into the heartbeat's progressSupplier.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

type ConsolidateProgress = { clusterIndex: number; totalClusters: number; merged: number };

function makeMinimalBindings(overrides: Partial<ManageBindings>): ManageBindings {
  const bindings = {
    factsDb: { getRawDb: () => ({}) },
    cfg: {},
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings;
  // ManageBindings also exposes a self-referencing `ctx` for sparse `ctx.*` access
  // (see cli/commands/manage/bindings.ts's buildManageBindings) — the consolidate action reads
  // config through `ctx.cfg` rather than the flattened `cfg` field.
  bindings.ctx = bindings;
  return bindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return lines;
}

describe("consolidate CLI heartbeat during blocking per-cluster LLM merges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('consolidate --verbose logs a "consolidate — start" line and fires onProgress once per cluster', async () => {
    const lines = captureLogs();
    const progressCalls: ConsolidateProgress[] = [];
    const runConsolidate = vi.fn(async (opts: { onProgress?: (p: ConsolidateProgress) => void }) => {
      // The heartbeat's start line must already be flushed before the (slow) mocked per-cluster
      // LLM loop even begins — this is what an operator tailing the cron log would see
      // immediately, instead of silence until the whole run finishes.
      expect(lines.some((l) => l.includes("consolidate — start"))).toBe(true);
      for (let i = 1; i <= 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const progress: ConsolidateProgress = { clusterIndex: i, totalClusters: 3, merged: i - 1 };
        progressCalls.push(progress);
        opts.onProgress?.(progress);
      }
      return { clustersFound: 3, merged: 2, deleted: 4 };
    });
    // --dry-run skips the real cross-process step lock (see dream-cycle-consolidate-lock.test.ts),
    // so this test can exercise the heartbeat wiring without touching the filesystem.
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));

    await mem.parseAsync(["consolidate", "--dry-run", "--verbose"], { from: "user" });

    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(progressCalls).toEqual([
      { clusterIndex: 1, totalClusters: 3, merged: 0 },
      { clusterIndex: 2, totalClusters: 3, merged: 1 },
      { clusterIndex: 3, totalClusters: 3, merged: 2 },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("consolidate — start");
    expect(joined).toMatch(/consolidate — complete in \d+s/);
    expect(joined).toContain("Consolidation complete: 3 clusters found, 2 merged, 4 deleted (dry-run)");
  });

  it("consolidate without --verbose does not emit heartbeat lines (onProgress still wired)", async () => {
    const lines = captureLogs();
    const progressCalls: ConsolidateProgress[] = [];
    const runConsolidate = vi.fn(async (opts: { onProgress?: (p: ConsolidateProgress) => void }) => {
      const progress: ConsolidateProgress = { clusterIndex: 1, totalClusters: 1, merged: 1 };
      progressCalls.push(progress);
      opts.onProgress?.(progress);
      return { clustersFound: 1, merged: 1, deleted: 2 };
    });
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));

    await mem.parseAsync(["consolidate", "--dry-run"], { from: "user" });

    expect(progressCalls).toEqual([{ clusterIndex: 1, totalClusters: 1, merged: 1 }]);
    const joined = lines.join("\n");
    expect(joined).not.toContain("consolidate — start");
    expect(joined).not.toContain("consolidate — complete");
    expect(joined).toContain("Consolidation complete: 1 clusters found, 1 merged, 2 deleted (dry-run)");
  });

  it("consolidate --verbose surfaces a failed heartbeat line when the underlying run rejects", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const runConsolidate = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));

    await expect(mem.parseAsync(["consolidate", "--dry-run", "--verbose"], { from: "user" })).rejects.toThrow(
      "provider unavailable",
    );

    const joined = lines.join("\n");
    expect(joined).toContain("consolidate — start");
    expect(joined).toMatch(/consolidate — failed after \d+s: .*provider unavailable/);
  });
});
