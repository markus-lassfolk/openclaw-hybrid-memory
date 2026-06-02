import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GUARD_SUBDIR } from "../services/cron-guard.js";
import { collectMaintenanceInventory, renderMaintenanceInventoryMarkdown } from "../services/maintenance-inventory.js";

function makeOpenclawDir(): string {
  const dir = join(tmpdir(), `maintenance-inventory-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGuard(openclawDir: string, jobName: string, timestampMs: number): void {
  const guardDir = join(openclawDir, GUARD_SUBDIR);
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(join(guardDir, `${jobName}.ms`), String(timestampMs), "utf-8");
}

describe("collectMaintenanceInventory", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges host crontab and gateway cron jobs into one inventory", () => {
    const openclawDir = makeOpenclawDir();
    cleanup.push(openclawDir);

    const logsDayDir = join(openclawDir, "logs", "cron-hybrid-mem", "20260602");
    mkdirSync(logsDayDir, { recursive: true });

    const weeklyReflectionLog = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.log");
    const weeklyReflectionExit = join(logsDayDir, "weekly-reflection-20260602T090000Z-123.exit.txt");
    writeFileSync(weeklyReflectionLog, "[weekly-reflection] run started\n", "utf-8");
    writeFileSync(
      weeklyReflectionExit,
      ["2026-06-02T09:00:00Z reflect exit=0", "2026-06-02T09:01:00Z reflect-rules exit=0", ""].join("\n"),
      "utf-8",
    );

    const vectordbLog = join(logsDayDir, "weekly-vectordb-optimize-sunday-20260602T044500Z-456.log");
    const vectordbExit = join(logsDayDir, "weekly-vectordb-optimize-sunday-20260602T044500Z-456.exit.txt");
    writeFileSync(vectordbLog, "[weekly-vectordb-optimize-sunday] run started\n", "utf-8");
    writeFileSync(vectordbExit, "2026-06-02T04:45:00Z vectordb-optimize exit=0\n", "utf-8");

    const recentGuardMs = Date.UTC(2026, 5, 2, 9, 5, 0);
    const olderArtifactMs = recentGuardMs - 60_000;
    const artifactMtime = new Date(olderArtifactMs);
    utimesSync(weeklyReflectionLog, artifactMtime, artifactMtime);
    utimesSync(weeklyReflectionExit, artifactMtime, artifactMtime);
    const vectordbMtime = new Date(Date.UTC(2026, 5, 2, 4, 45, 0));
    utimesSync(vectordbLog, vectordbMtime, vectordbMtime);
    utimesSync(vectordbExit, vectordbMtime, vectordbMtime);
    writeGuard(openclawDir, "weekly-reflection", recentGuardMs);

    const cronStoreText = JSON.stringify(
      {
        jobs: [
          {
            pluginJobId: "hybrid-mem:weekly-reflection",
            name: "weekly-reflection",
            enabled: true,
            schedule: { kind: "cron", expr: "0 3 * * 0" },
            state: { lastRunAtMs: recentGuardMs - 60_000, lastStatus: "ok" },
            payload: {
              message: "Weekly reflection pipeline.\n```bash\nopenclaw hybrid-mem reflect --verbose\n```",
            },
          },
          {
            name: "openclaw-hybrid-memory-pr-stewardship-minimax",
            enabled: true,
            schedule: { kind: "every", everyMs: 1_200_000 },
          },
        ],
      },
      null,
      2,
    );

    const crontabText = [
      "CRON_TZ=Europe/Helsinki",
      "19 9 * * 1 /home/markus/.openclaw/scripts/hybrid-mem-cli-job.sh weekly-reflection",
      "45 4 * * 0 /home/markus/.openclaw/scripts/hybrid-mem-cli-job.sh weekly-vectordb-optimize-sunday",
      "",
    ].join("\n");

    const report = collectMaintenanceInventory(openclawDir, { crontabText, cronStoreText });

    expect(report.jobs.map((job) => job.inventoryId)).toEqual(
      expect.arrayContaining([
        "gateway-cron:weekly-reflection",
        "gateway-cron:goal-stewardship-heartbeat",
        "host-cron:weekly-reflection",
        "host-cron:weekly-vectordb-optimize-sunday",
      ]),
    );

    const hostReflection = report.jobs.find((job) => job.inventoryId === "host-cron:weekly-reflection");
    expect(hostReflection?.timezone).toBe("Europe/Helsinki");
    expect(hostReflection?.command).toContain("hybrid-mem-cli-job.sh weekly-reflection");
    expect(hostReflection?.guardPath).toContain("weekly-reflection.ms");
    expect(hostReflection?.lastStatus).toBe("success");
    expect(hostReflection?.collisionGroups).toContain("sqlite-writer");

    const gatewayReflection = report.jobs.find((job) => job.inventoryId === "gateway-cron:weekly-reflection");
    expect(gatewayReflection?.timezone).toBe("UTC");
    expect(gatewayReflection?.lastRunSource).toBe("guard");
    expect(gatewayReflection?.lastRunAt).toBe(new Date(recentGuardMs).toISOString());
    expect(gatewayReflection?.prompt).toContain("Weekly reflection pipeline.");

    const stewardshipPulse = report.jobs.find((job) => job.inventoryId === "gateway-cron:goal-stewardship-heartbeat");
    expect(stewardshipPulse?.name).toBe("goal-stewardship-heartbeat");
    expect(stewardshipPulse?.schedule).toBe("every 1200000ms");
    expect(stewardshipPulse?.timezone).toBe("interval");

    const vectordb = report.jobs.find((job) => job.inventoryId === "host-cron:weekly-vectordb-optimize-sunday");
    expect(vectordb?.collisionGroups).toEqual(["lancedb-writer"]);
  });

  it("renders markdown output with combined collision groups", () => {
    const openclawDir = makeOpenclawDir();
    cleanup.push(openclawDir);

    const report = collectMaintenanceInventory(openclawDir, {
      crontabText: "0 2 * * * /home/markus/.openclaw/scripts/hybrid-mem-cli-job.sh nightly-memory-sweep\n",
      cronStoreText: JSON.stringify({
        jobs: [
          {
            pluginJobId: "hybrid-mem:nightly-distill",
            name: "nightly-memory-sweep",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *" },
          },
        ],
      }),
    });

    const markdown = renderMaintenanceInventoryMarkdown(report);
    expect(markdown).toContain(
      "| Scheduler | Job | Enabled | Schedule | TZ | Last run | Last status | Guard | Last log | Collision groups |",
    );
    expect(markdown).toContain("host-cron");
    expect(markdown).toContain("gateway-cron");
    expect(markdown).toContain("lancedb-writer");
  });
});
