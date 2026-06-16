import { describe, expect, it, vi } from "vitest";
import { emitFeatureTelemetry } from "../services/feature-telemetry.js";

describe("feature-telemetry", () => {
  it("warns when duration exceeds budget", () => {
    const warn = vi.fn();
    const info = vi.fn();
    emitFeatureTelemetry({ warn, info }, {
      feature: "recall",
      operation: "memory_recall",
      durationMs: 200,
      warnBudgetMs: 150,
      outcome: "ok",
      fields: { mode: "hybrid" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain("feature-telemetry");
    expect(warn.mock.calls[0]?.[0]).toContain("duration_ms=200");
  });

  it("info when within budget", () => {
    const warn = vi.fn();
    const info = vi.fn();
    emitFeatureTelemetry({ warn, info }, {
      feature: "recall",
      operation: "memory_recall",
      durationMs: 50,
      warnBudgetMs: 150,
      outcome: "ok",
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
