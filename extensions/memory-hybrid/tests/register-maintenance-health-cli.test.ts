/**
 * `maintenance status` / `maintenance cron-health` must set process.exitCode when they detect
 * or fail to detect problems, so cron wrappers and CI can gate on the exit code instead of
 * having to scrape stdout for a warning icon.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactsDB } from "../backends/facts-db.js";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import { registerMaintenanceHealthCommands } from "../cli/commands/manage/register-maintenance-health.js";
import type { HybridMemoryConfig } from "../config.js";
import { recordMaintenanceCronRunOutcome } from "../services/maintenance-audit-journal.js";

function openTestFactsDb(): { db: DatabaseSync; factsDb: FactsDB } {
  const dir = mkdtempSync(join(tmpdir(), "hm-maint-health-db-"));
  const db = new DatabaseSync(join(dir, "facts.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.5,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL
    )
  `);
  runFactsMigrations(db);
  return { db, factsDb: { getRawDb: () => db } as unknown as FactsDB };
}

/** #2231: `status`/`cron-health` now also monitor nightly-doctor-repair, so a "healthy" cron-store
 *  fixture must include it alongside maintenance-nightly for exit-code assertions to still hold. */
const HEALTHY_DOCTOR_REPAIR_JOB = {
  pluginJobId: "hybrid-mem:nightly-doctor-repair",
  name: "nightly-doctor-repair",
  enabled: true,
  state: { lastRunAtMs: Date.now(), lastStatus: "success" },
};

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
          HEALTHY_DOCTOR_REPAIR_JOB,
        ],
      }),
      "utf-8",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("maintenance status includes nightly-doctor-repair as a monitored job (#2231)", async () => {
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
          HEALTHY_DOCTOR_REPAIR_JOB,
        ],
      }),
      "utf-8",
    );
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut) as { jobs: Array<{ name: string; lastSuccessfulRunAt: string | null }> };
    const doctorRepair = parsed.jobs.find((j) => j.name === "nightly-doctor-repair");
    expect(doctorRepair).toBeDefined();
    expect(doctorRepair).toHaveProperty("lastSuccessfulRunAt");
  });

  it("maintenance status sets process.exitCode=1 when nightly-doctor-repair is missing (#2231)", async () => {
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

    expect(process.exitCode).toBe(1);
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
          HEALTHY_DOCTOR_REPAIR_JOB,
        ],
      }),
      "utf-8",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "cron-health"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("cron-health sets process.exitCode=1 when nightly-doctor-repair is missing (#2231)", async () => {
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "cron-health"], { from: "user" });

    expect(process.exitCode).toBe(1);
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
          HEALTHY_DOCTOR_REPAIR_JOB,
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

  it("prints an unambiguous Overall verdict line distinguishing scheduler cadence from log health (#2094)", async () => {
    writeHealthyNightlyJob();
    writeStrictFailingMaintenanceLog();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    // Cron cadence is fresh (scheduler OK) but maintenance is semantically failing (log health
    // strict findings) — the bottom-line verdict must call this out explicitly, not just leave
    // the two individual lines above for the reader to reconcile themselves.
    const overallLine = lines.find((l) => l.includes("Overall:"));
    expect(overallLine).toBeDefined();
    expect(overallLine).toContain("ATTENTION NEEDED");
    expect(overallLine).toMatch(/cadence is fresh, but maintenance is semantically failing/);
  });

  it("prints a healthy Overall verdict when both scheduler cadence and log health are clean", async () => {
    writeHealthyNightlyJob();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    const mem = makeProgram();

    await mem.parseAsync(["maintenance", "status"], { from: "user" });

    const overallLine = lines.find((l) => l.includes("Overall:"));
    expect(overallLine).toBeDefined();
    expect(overallLine).toContain("healthy");
    expect(overallLine).not.toContain("ATTENTION NEEDED");
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

describe("maintenance status exposes last-successful-run per job from local audit journal (#2231)", () => {
  let homeDir: string;
  let db: DatabaseSync;
  let factsDb: FactsDB;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "hm-maint-health-"));
    mkdirSync(join(homeDir, ".openclaw", "cron"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    ({ db, factsDb } = openTestFactsDb());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    db.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeHealthyJobs() {
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
          HEALTHY_DOCTOR_REPAIR_JOB,
        ],
      }),
      "utf-8",
    );
  }

  it("reports lastSuccessfulRunAt=null when no cron-lane run has been recorded yet", async () => {
    writeHealthyJobs();
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceHealthCommands(maintenance, {} as HybridMemoryConfig, factsDb);

    await mem.parseAsync(["maintenance", "status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut) as { jobs: Array<{ name: string; lastSuccessfulRunAt: string | null }> };
    expect(parsed.jobs.find((j) => j.name === "maintenance-nightly")?.lastSuccessfulRunAt).toBeNull();
    expect(parsed.jobs.find((j) => j.name === "nightly-doctor-repair")?.lastSuccessfulRunAt).toBeNull();
  });

  it("surfaces the most recent successful cron-lane run recorded via recordMaintenanceCronRunOutcome", async () => {
    writeHealthyJobs();
    recordMaintenanceCronRunOutcome(db, {
      jobName: "nightly-doctor-repair",
      maintenanceStatus: "success",
    });

    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceHealthCommands(maintenance, {} as HybridMemoryConfig, factsDb);

    await mem.parseAsync(["maintenance", "status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut) as { jobs: Array<{ name: string; lastSuccessfulRunAt: string | null }> };
    const doctorRepair = parsed.jobs.find((j) => j.name === "nightly-doctor-repair");
    expect(doctorRepair?.lastSuccessfulRunAt).not.toBeNull();
    // A failed cron-lane run for a DIFFERENT job must not leak into maintenance-nightly's own field.
    expect(parsed.jobs.find((j) => j.name === "maintenance-nightly")?.lastSuccessfulRunAt).toBeNull();
  });

  it("does not surface a failed cron-lane run as a successful one", async () => {
    writeHealthyJobs();
    recordMaintenanceCronRunOutcome(db, {
      jobName: "maintenance-nightly",
      maintenanceStatus: "failed",
      primaryFailure: {
        stepName: "distill",
        failureClass: "nonzero_exit",
        message: "maintenance-nightly:distill exited non-zero",
      },
      failingStepNames: ["distill"],
    });

    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceHealthCommands(maintenance, {} as HybridMemoryConfig, factsDb);

    await mem.parseAsync(["maintenance", "status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut) as { jobs: Array<{ name: string; lastSuccessfulRunAt: string | null }> };
    expect(parsed.jobs.find((j) => j.name === "maintenance-nightly")?.lastSuccessfulRunAt).toBeNull();
  });
});
