import { describe, expect, it } from "vitest";
import {
  resolveScanMaintenanceOverrides,
  registerScanMaintenanceOverrideOptions,
  scanMaintenanceOverridePayload,
} from "../cli/maintenance-overrides.js";

describe("maintenance-overrides", () => {
  it("resolveScanMaintenanceOverrides: neither flag → no bypass", () => {
    expect(resolveScanMaintenanceOverrides({})).toEqual({
      bypassScanCooldown: false,
      bypassWatermark: false,
    });
  });

  it("resolveScanMaintenanceOverrides: --full enables both bypasses", () => {
    expect(resolveScanMaintenanceOverrides({ full: true })).toEqual({
      bypassScanCooldown: true,
      bypassWatermark: true,
    });
  });

  it("resolveScanMaintenanceOverrides: --force enables both bypasses", () => {
    expect(resolveScanMaintenanceOverrides({ force: true })).toEqual({
      bypassScanCooldown: true,
      bypassWatermark: true,
    });
  });

  it("scanMaintenanceOverridePayload mirrors resolveScanMaintenanceOverrides", () => {
    expect(scanMaintenanceOverridePayload({ force: true })).toEqual({ force: true, full: true });
    expect(scanMaintenanceOverridePayload({})).toEqual({ force: false, full: false });
  });

  it("registerScanMaintenanceOverrideOptions chains on a mock commander", () => {
    const options: Array<{ flags: string; desc?: string }> = [];
    const cmd = {
      option(flags: string, desc?: string) {
        options.push({ flags, desc });
        return cmd;
      },
    };
    registerScanMaintenanceOverrideOptions(cmd);
    expect(options.map((o) => o.flags)).toEqual(["--force", "--full"]);
    expect(options[0]?.desc).toContain("23h");
  });
});
