import { describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { buildCliMaintenanceRunners } from "../cli/commands/manage/maintenance-step-runners.js";
import type { HybridMemoryConfig } from "../config.js";

/**
 * Pin regression for #2089: the "dream-cycle-core" orchestrator step must keep its default
 * mutating behavior — it must never pass dryRun through to runDreamCycle(), since the
 * orchestrator's own step-runner options carry no dry-run flag today. This is exactly the trap
 * the #2089 plan called out ("orchestrator path keeps default mutate behavior — pin with a
 * test"): a future refactor threading dryRun into shared options could accidentally leak it into
 * this scheduled/cron path and silently stop nightly maintenance from ever mutating anything.
 */
function minimalBindings(runDreamCycle: ManageBindings["runDreamCycle"]): ManageBindings {
  return {
    cfg: { maintenance: { orchestrator: { llmCooldownBetweenStepsMs: 0 } } } as HybridMemoryConfig,
    factsDb: {} as ManageBindings["factsDb"],
    vectorDb: {} as ManageBindings["vectorDb"],
    embeddings: { embed: vi.fn() } as unknown as ManageBindings["embeddings"],
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    runDreamCycle,
  } as unknown as ManageBindings;
}

describe("maintenance-step-runners dream-cycle-core (#2089 dry-run regression)", () => {
  it("calls runDreamCycle without dryRun set — the orchestrator path always mutates", async () => {
    const runDreamCycle = vi.fn().mockResolvedValue({
      skipped: false,
      success: true,
      digestSummary: "ok",
      failedStages: [],
    });
    const runner = buildCliMaintenanceRunners(minimalBindings(runDreamCycle)).get("dream-cycle-core");
    expect(runner).toBeDefined();

    await runner?.();

    expect(runDreamCycle).toHaveBeenCalledTimes(1);
    const passedOpts = runDreamCycle.mock.calls[0][0];
    expect(passedOpts?.dryRun).not.toBe(true);
  });

  it("throws when the underlying binding is unavailable", async () => {
    const runner = buildCliMaintenanceRunners(minimalBindings(undefined)).get("dream-cycle-core");
    await expect(runner?.()).rejects.toThrow(/dream-cycle unavailable/);
  });
});
