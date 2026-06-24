import { describe, expect, it } from "vitest";
import {
  getConsolidatedSupersededLegacyCronJobKeys,
  getMaintenanceCronJobKeys,
  shouldDisableJobUnderConsolidatedOrchestrator,
} from "../cli/install/cron-jobs.js";

describe("consolidated cron superseded job keys (#1925)", () => {
  it("excludes standalone plugin cron jobs from superseded legacy set", () => {
    const superseded = getConsolidatedSupersededLegacyCronJobKeys();
    expect(superseded).toContain("nightly-memory-sweep");
    expect(superseded).toContain("weekly-audit-health");
    expect(superseded).not.toContain("workshop-approval-reminder");
    expect(superseded).not.toContain("weekly-pending-digest");
    expect(superseded).not.toContain("weekly-pending-digest-autopilot");
    expect(superseded).not.toContain("maintenance-log-analyzer");
    expect(superseded).not.toContain("sensor-sweep");
    expect(superseded).not.toContain("daily-lifecycle-sync");
  });

  it("shouldDisableJobUnderConsolidatedOrchestrator keeps standalone jobs enabled", () => {
    expect(
      shouldDisableJobUnderConsolidatedOrchestrator(
        "hybrid-mem:workshop-approval-reminder",
        "workshop-approval-reminder",
      ),
    ).toBe(false);
    expect(shouldDisableJobUnderConsolidatedOrchestrator("hybrid-mem:nightly-distill", "nightly-memory-sweep")).toBe(
      true,
    );
    expect(shouldDisableJobUnderConsolidatedOrchestrator("hybrid-mem:maintenance-nightly")).toBe(false);
    expect(shouldDisableJobUnderConsolidatedOrchestrator("hybrid-mem:unknown-job")).toBe(false);
  });

  it("getMaintenanceCronJobKeys includes standalone and superseded jobs", () => {
    const all = getMaintenanceCronJobKeys();
    expect(all).toContain("workshop-approval-reminder");
    expect(all).toContain("nightly-memory-sweep");
  });
});
