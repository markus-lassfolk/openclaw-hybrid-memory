import { describe, expect, it } from "vitest";

import { resolveLightJobRunOutcome } from "../services/maintenance-job-run/light-job-run-bridge.js";

describe("resolveLightJobRunOutcome monitoring outcome (#2043)", () => {
  it("reports monitoring for a deadline-limited stop with no other error", () => {
    expect(
      resolveLightJobRunOutcome({
        monitoring: true,
        inputsProcessed: 10,
        outputsProduced: 5,
      }),
    ).toBe("monitoring");
  });

  it("still reports partial when a genuine failure is present, even if monitoring is also set", () => {
    expect(
      resolveLightJobRunOutcome({
        partialFailure: true,
        monitoring: true,
        inputsProcessed: 10,
        outputsProduced: 5,
      }),
    ).toBe("partial");
  });

  it("reports success when neither partialFailure nor monitoring is set and work was produced", () => {
    expect(
      resolveLightJobRunOutcome({
        inputsProcessed: 10,
        outputsProduced: 5,
      }),
    ).toBe("success");
  });

  it("skipped/dryRun still take priority over monitoring", () => {
    expect(resolveLightJobRunOutcome({ skipped: true, monitoring: true })).toBe("skipped");
    expect(resolveLightJobRunOutcome({ dryRun: true, monitoring: true })).toBe("skipped");
  });
});
