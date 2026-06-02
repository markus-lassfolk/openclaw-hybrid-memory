import { afterEach, describe, expect, it, vi } from "vitest";
import type { HybridMemoryConfig } from "../config.js";

describe("maintenance-failure-reporter", () => {
  afterEach(() => {
    delete process.env.HYBRID_MEMORY_DISABLE_MAINTENANCE_ERROR_REPORTING;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function buildConfig() {
    return {
      errorReporting: {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1",
        sampleRate: 1,
        updateNudge: { enabled: true, intervalHours: 24, cacheTtlHours: 24 },
      },
      maintenance: {
        failureReporting: {
          enabled: true,
        },
      },
    } satisfies Pick<HybridMemoryConfig, "errorReporting" | "maintenance">;
  }

  it("reports when maintenance and error reporting are both enabled", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    expect(shouldReportMaintenanceFailures(buildConfig())).toBe(true);
  });

  it("honors the maintenance reporting environment opt-out", async () => {
    process.env.HYBRID_MEMORY_DISABLE_MAINTENANCE_ERROR_REPORTING = "1";
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    expect(shouldReportMaintenanceFailures(buildConfig())).toBe(false);
  });

  it("honors config opt-out even when global error reporting remains enabled", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    const cfg = buildConfig();
    cfg.maintenance.failureReporting.enabled = false;
    expect(shouldReportMaintenanceFailures(cfg)).toBe(false);
  });
});
