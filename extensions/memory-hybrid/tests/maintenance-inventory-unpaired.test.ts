import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectMaintenanceInventory } from "../services/maintenance-inventory.js";

function makeOpenclawDir(): string {
  const dir = join(tmpdir(), `maintenance-inventory-unpaired-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("collectMaintenanceInventory - unpaired artifacts", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should only use paired log and exit files from the same run", () => {
    const openclawDir = makeOpenclawDir();
    cleanup.push(openclawDir);

    const logsDayDir = join(openclawDir, "logs", "cron-hybrid-mem", "20260602");
    mkdirSync(logsDayDir, { recursive: true });

    const nowMs = Date.now();

    // Create older exit file for run 123
    const olderExitPath = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.exit.txt");
    writeFileSync(olderExitPath, ["2026-06-02T09:00:00Z reflect exit=1", ""].join("\n"), "utf-8");
    const olderExitTime = new Date(nowMs - 180_000);
    utimesSync(olderExitPath, olderExitTime, olderExitTime);

    // Create matching log file for run 123
    const olderLogPath = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.log");
    writeFileSync(olderLogPath, "[weekly-reflection] run 123 failed\n", "utf-8");
    utimesSync(olderLogPath, olderExitTime, olderExitTime);

    // Create newer log file for run 456 (no exit file - in progress or partial)
    const newerLogPath = join(logsDayDir, "weekly-reflection-20260602T100000Z-456.log");
    writeFileSync(newerLogPath, "[weekly-reflection] run 456 started\n", "utf-8");
    const newerLogTime = new Date(nowMs - 60_000);
    utimesSync(newerLogPath, newerLogTime, newerLogTime);

    const cronStoreText = JSON.stringify({
      jobs: [
        {
          pluginJobId: "hybrid-mem:weekly-reflection",
          name: "weekly-reflection",
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * 0" },
          state: { lastRunAtMs: nowMs - 120_000, lastStatus: "ok" },
        },
      ],
    });

    const report = collectMaintenanceInventory(openclawDir, { cronStoreText });

    const gatewayReflection = report.jobs.find((job) => job.inventoryId === "gateway-cron:weekly-reflection");

    // Both log and exit should be from run 123 (the only complete pair)
    expect(gatewayReflection?.lastLogPath).toContain("20260602T090000Z-123.log");
    expect(gatewayReflection?.lastExitPath).toContain("20260602T090000Z-123.exit.txt");

    // Status should reflect the paired artifacts (failed based on exit=1)
    expect(gatewayReflection?.lastStatus).toBe("failed");
  });

  it("should use the latest paired artifacts when multiple complete pairs exist", () => {
    const openclawDir = makeOpenclawDir();
    cleanup.push(openclawDir);

    const logsDayDir = join(openclawDir, "logs", "cron-hybrid-mem", "20260602");
    mkdirSync(logsDayDir, { recursive: true });

    const nowMs = Date.now();

    // Create older paired run 123 (failed)
    const olderExitPath = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.exit.txt");
    writeFileSync(olderExitPath, ["2026-06-02T09:00:00Z reflect exit=1", ""].join("\n"), "utf-8");
    const olderLogPath = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.log");
    writeFileSync(olderLogPath, "[weekly-reflection] run 123 failed\n", "utf-8");
    const olderTime = new Date(nowMs - 180_000);
    utimesSync(olderExitPath, olderTime, olderTime);
    utimesSync(olderLogPath, olderTime, olderTime);

    // Create newer paired run 456 (success)
    const newerExitPath = join(logsDayDir, "weekly-reflection-20260602T100000Z-456.exit.txt");
    writeFileSync(
      newerExitPath,
      ["2026-06-02T10:00:00Z reflect exit=0", "2026-06-02T10:01:00Z reflect-rules exit=0", ""].join("\n"),
      "utf-8",
    );
    const newerLogPath = join(logsDayDir, "weekly-reflection-20260602T100000Z-456.log");
    writeFileSync(newerLogPath, "[weekly-reflection] run 456 succeeded\n", "utf-8");
    const newerTime = new Date(nowMs - 60_000);
    utimesSync(newerExitPath, newerTime, newerTime);
    utimesSync(newerLogPath, newerTime, newerTime);

    const cronStoreText = JSON.stringify({
      jobs: [
        {
          pluginJobId: "hybrid-mem:weekly-reflection",
          name: "weekly-reflection",
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * 0" },
        },
      ],
    });

    const report = collectMaintenanceInventory(openclawDir, { cronStoreText });

    const gatewayReflection = report.jobs.find((job) => job.inventoryId === "gateway-cron:weekly-reflection");

    // Should use the newer paired run 456
    expect(gatewayReflection?.lastLogPath).toContain("20260602T100000Z-456.log");
    expect(gatewayReflection?.lastExitPath).toContain("20260602T100000Z-456.exit.txt");

    // Status should reflect the newer paired artifacts (success)
    expect(gatewayReflection?.lastStatus).toBe("success");
  });
});
