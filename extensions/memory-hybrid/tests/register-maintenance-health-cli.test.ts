/**
 * `maintenance status` / `maintenance cron-health` must set process.exitCode when they detect
 * or fail to detect problems, so cron wrappers and CI can gate on the exit code instead of
 * having to scrape stdout for a warning icon.
 */
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceHealthCommands } from "../cli/commands/manage/register-maintenance-health.js";
import type { HybridMemoryConfig } from "../config.js";

describe("maintenance status / cron-health exit codes", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "hm-maint-health-"));
    mkdirSync(join(homeDir, ".openclaw", "cron"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function makeProgram(cfg: Partial<HybridMemoryConfig> = {}): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceHealthCommands(maintenance, cfg as HybridMemoryConfig);
    return mem;
  }

  it("maintenance status sets process.exitCode=1 when the nightly job is missing", async () => {
    writeFileSync(join(homeDir, ".openclaw", "cron", "jobs.json"), JSON.stringify({ jobs: [] }), "utf-8");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("maintenance status leaves process.exitCode unset when the nightly job is healthy", async () => {
    writeFileSync(
      join(homeDir, ".openclaw", "cron", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            pluginJobId: "hybrid-mem:maintenance-nightly",
            name: "maintenance-nightly",
            enabled: true,
            state: { lastRunAtMs: Date.now(), lastStatus: "success" },
          },
        ],
      }),
      "utf-8",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("cron-health sets process.exitCode=1 when a critical job is missing", async () => {
    writeFileSync(join(homeDir, ".openclaw", "cron", "jobs.json"), JSON.stringify({ jobs: [] }), "utf-8");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "cron-health"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("cron-health sets process.exitCode=1 when the cron store can't be read", async () => {
    writeFileSync(join(homeDir, ".openclaw", "cron", "jobs.json"), "{ not valid json", "utf-8");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "cron-health"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("cron-health leaves process.exitCode unset when all critical jobs are healthy", async () => {
    writeFileSync(
      join(homeDir, ".openclaw", "cron", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            pluginJobId: "hybrid-mem:maintenance-nightly",
            name: "maintenance-nightly",
            enabled: true,
            state: { lastRunAtMs: Date.now(), lastStatus: "success" },
          },
        ],
      }),
      "utf-8",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "cron-health"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });
});
