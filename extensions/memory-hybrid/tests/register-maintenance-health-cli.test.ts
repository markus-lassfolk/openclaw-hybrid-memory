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

describe("maintenance status folds in analyze-maintenance-logs strict findings (#2033)", () => {
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

  function writeHealthyNightlyJob() {
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
  }

  function writeStrictFailingMaintenanceLog() {
    const logRoot = join(homeDir, ".openclaw", "logs", "cron-hybrid-mem");
    mkdirSync(logRoot, { recursive: true });
    const exitPath = join(logRoot, "maintenance-nightly-20260705T020000Z-123.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, `${new Date().toISOString()} distill exit=1\n`);
    writeFileSync(logPath, "openclaw-hybrid-memory 2026.7.51\nTypeError: Cannot read properties of undefined\n");
  }

  it("does not print the unconditional healthy line and exits non-zero when logs have strict findings", async () => {
    writeHealthyNightlyJob();
    writeStrictFailingMaintenanceLog();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(process.exitCode).toBe(1);
    // Scheduler cadence is still reported as healthy (distinct from log/semantic health)...
    expect(lines.some((l) => l.includes("Scheduler freshness"))).toBe(true);
    // ...but the unconditional "healthy" claim from before #2033 must be gone...
    expect(lines).not.toContain("✅ All maintenance jobs healthy.");
    // ...and the strict log-health failure must be surfaced.
    expect(lines.some((l) => l.includes("Log health") && l.includes("strict findings"))).toBe(true);
  });

  it("reports ok:false and logHealth.strictFailed in --json mode", async () => {
    writeHealthyNightlyJob();
    writeStrictFailingMaintenanceLog();

    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut);
    expect(parsed.ok).toBe(false);
    expect(parsed.logHealth.strictFailed).toBe(true);
    expect(parsed.logHealth.findingsCount).toBeGreaterThan(0);
  });

  it("stays healthy and quiet about log health when no maintenance logs exist yet", async () => {
    writeHealthyNightlyJob();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
    expect(lines.some((l) => l.includes("Log health"))).toBe(false);
  });
});

describe("maintenance status surfaces active/stale maintenance step locks (#2031)", () => {
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

  it("lists a held step lock so operators can see what `maintenance step --force` would report as locked", async () => {
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
    const { acquireStepLock } = await import("../services/cron-guard.js");
    acquireStepLock("distill", join(homeDir, ".openclaw"));

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceHealthCommands(maintenance, {} as HybridMemoryConfig);

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(lines.some((l) => l.includes("Active/stale maintenance step locks"))).toBe(true);
    expect(lines.some((l) => l.includes("step--distill"))).toBe(true);
  });
});
