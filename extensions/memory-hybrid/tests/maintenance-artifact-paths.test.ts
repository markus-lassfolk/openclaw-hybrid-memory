import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveMaintenanceExitPathForSummary,
  resolveMaintenanceSummaryPath,
} from "../services/maintenance-artifact-paths.js";
import { buildJobRunId } from "../services/maintenance-job-run/artifact-paths.js";

describe("buildJobRunId", () => {
  it("sanitizes raw separators in the fingerprint instead of producing malformed ids (#2024)", () => {
    // Regression: `::14:false` previously sliced to `::14:fal`, producing `job-distill-::14:fal`.
    const id = buildJobRunId("distill", "::14:false");
    expect(id).toBe("job-distill-14-false");
    expect(id).not.toContain(":");
  });

  it("keeps ids stable and safe for typical fingerprints", () => {
    expect(buildJobRunId("distill", "true:2026-01-01:3:false")).toBe("job-distill-true-202");
    expect(buildJobRunId("self correction", "::::")).toBe("job-self-correction-0");
  });

  it("leaves purely-alphanumeric (hex hash) fingerprints byte-identical to the legacy 8-char slice", () => {
    // Hash-fingerprinted job-runs (self-correction / batch) must keep stable checkpoint dir names
    // across upgrade — sanitize is a no-op for hex, and the cap stays at 8 chars (#2024 review).
    expect(buildJobRunId("self-correction", "a1b2c3d4e5f6a7b8")).toBe("job-self-correction-a1b2c3d4");
  });
});

describe("resolveMaintenanceSummaryPath", () => {
  it("finds summary in YYYYMMDD day subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-summary-path-"));
    const exitPath = join(root, "maintenance-nightly-20260605T030000Z-42.exit.txt");
    const summaryPath = join(root, "20260605", "maintenance-nightly-20260605T030000Z-42.summary.json");
    mkdirSync(join(root, "20260605"), { recursive: true });
    writeFileSync(exitPath, "exit\n");
    writeFileSync(summaryPath, '{"schemaVersion":1}\n');

    expect(resolveMaintenanceSummaryPath(exitPath)).toBe(summaryPath);
  });

  it("falls back to sibling summary next to exit file", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-summary-sibling-"));
    const exitPath = join(root, "maintenance-nightly-20260605T030000Z-7.exit.txt");
    const summaryPath = join(root, "maintenance-nightly-20260605T030000Z-7.summary.json");
    writeFileSync(exitPath, "exit\n");
    writeFileSync(summaryPath, '{"schemaVersion":1}\n');

    expect(resolveMaintenanceSummaryPath(exitPath)).toBe(summaryPath);
  });

  it("returns null when no summary exists", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-summary-missing-"));
    const exitPath = join(root, "maintenance-nightly-20260605T030000Z-1.exit.txt");
    writeFileSync(exitPath, "exit\n");

    expect(resolveMaintenanceSummaryPath(exitPath)).toBeNull();
  });
});

describe("resolveMaintenanceExitPathForSummary", () => {
  it("resolves exit path from day-dir summary layout", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-exit-from-summary-"));
    const exitPath = join(root, "maintenance-nightly-20260605T030000Z-42.exit.txt");
    const summaryPath = join(root, "20260605", "maintenance-nightly-20260605T030000Z-42.summary.json");

    expect(resolveMaintenanceExitPathForSummary(summaryPath)).toBe(exitPath);
  });

  it("resolves sibling exit path when summary is next to exit", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-exit-sibling-"));
    const exitPath = join(root, "maintenance-nightly-20260605T030000Z-7.exit.txt");
    const summaryPath = join(root, "maintenance-nightly-20260605T030000Z-7.summary.json");

    expect(resolveMaintenanceExitPathForSummary(summaryPath)).toBe(exitPath);
  });
});
