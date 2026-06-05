import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveMaintenanceExitPathForSummary,
  resolveMaintenanceSummaryPath,
} from "../services/maintenance-artifact-paths.js";

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
