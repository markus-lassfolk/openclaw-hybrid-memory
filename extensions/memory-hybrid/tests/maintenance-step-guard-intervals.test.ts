import { describe, expect, it } from "vitest";
import { getMaintenanceStep, resolveStepGuardIntervalMs } from "../services/maintenance-orchestrator.js";
import type { HybridMemoryConfig } from "../config.js";

describe("maintenance step guard intervals", () => {
  it("uses passiveObserver.intervalMinutes for passive-observer guard", () => {
    const step = getMaintenanceStep("passive-observer");
    expect(step).toBeTruthy();
    const cfg = {
      passiveObserver: { enabled: true, intervalMinutes: 15 },
    } as HybridMemoryConfig;
    expect(resolveStepGuardIntervalMs(step!, cfg)).toBe(15 * 60 * 1000);
  });
});
