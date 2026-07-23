/**
 * skipNightlyOverlap must not drop curation when dream-run is unscheduled.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import {
  MAINTENANCE_STEPS,
  type MaintenanceOrchestratorContext,
  runMaintenanceOrchestrator,
} from "../services/maintenance-orchestrator.js";
import { nightlyStepsOwnedByDream } from "../services/dream-run.js";

describe("dream-run scheduling vs skipNightlyOverlap", () => {
  it("lists distill among owned steps when dreaming.enabled + skipNightlyOverlap", () => {
    const owned = nightlyStepsOwnedByDream({
      ...structuredClone(DEFAULT_DREAMING_CONFIG),
      enabled: true,
      skipNightlyOverlap: true,
      compose: ["distill", "reflect", "consolidate"],
    });
    expect(owned.has("distill")).toBe(true);
    expect(owned.has("reflect")).toBe(true);
    expect(owned.has("consolidate")).toBe(true);
  });

  it("registers dream-run step gated by dreaming.enabled", () => {
    const step = MAINTENANCE_STEPS.find((s) => s.name === "dream-run");
    expect(step).toBeTruthy();
    expect(step!.featureGate?.({ dreaming: { enabled: true } } as never)).toBe(true);
    expect(step!.featureGate?.({ dreaming: { enabled: false } } as never)).toBe(false);
  });

  it("runs owned nightly step when dream-run runner is missing (fail closed)", async () => {
    const distill = async () => "distill-ran";
    const runners = new Map<string, () => Promise<string>>([["distill", distill]]);
    // Intentionally omit dream-run runner.
    const cfg = {
      dreaming: {
        ...structuredClone(DEFAULT_DREAMING_CONFIG),
        enabled: true,
        skipNightlyOverlap: true,
        compose: ["distill"] as ["distill"],
      },
      maintenance: { orchestrator: { stepTimeoutMinutes: 1 } },
    };
    const ctx: MaintenanceOrchestratorContext = {
      cfg: cfg as never,
      runners: runners as never,
      logger: { info: () => {}, warn: () => {} },
      openclawDir: "/tmp",
    };
    const result = await runMaintenanceOrchestrator(ctx, {
      tiers: ["nightly"],
      force: true,
      openclawDir: "/tmp",
      include: ["distill"],
    });
    const distillResult = result.steps.find((r) => r.name === "distill");
    expect(distillResult?.status).not.toBe("skipped_gate");
    expect(distillResult?.summary).toContain("distill-ran");
  });
});
