import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/cmd-install.js";

function readJobs(openclawDir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  const parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

function writeJobs(openclawDir: string, jobs: Array<Record<string, unknown>>): void {
  const cronDir = join(openclawDir, "cron");
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs }, null, 2), "utf-8");
}

function seedMaintenanceJobs(openclawDir: string): void {
  ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });
}

describe("ensureMaintenanceCronJobs sessionKey normalization (#977)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function newOpenclawDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-cron-sessionkey-"));
    dirs.push(dir);
    return dir;
  }

  it("adds hybrid-mem maintenance jobs without top-level sessionKey", () => {
    const openclawDir = newOpenclawDir();
    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });

    const jobs = readJobs(openclawDir).filter((j) => String(j.pluginJobId ?? "").startsWith("hybrid-mem:"));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job).not.toHaveProperty("sessionKey");
    }
  });

  it("removes top-level sessionKey for isolated hybrid-mem jobs using sessionTarget", () => {
    const openclawDir = newOpenclawDir();
    seedMaintenanceJobs(openclawDir);

    const jobs = readJobs(openclawDir);
    const target = jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-distill");
    expect(target).toBeTruthy();
    target!.sessionTarget = "isolated";
    target!.sessionKey = "agent:main:main";
    writeJobs(openclawDir, jobs);

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });

    const after = readJobs(openclawDir);
    const fixed = after.find((j) => j.pluginJobId === "hybrid-mem:nightly-distill");
    expect(fixed).toBeTruthy();
    expect(fixed).not.toHaveProperty("sessionKey");
  });

  it("removes top-level sessionKey for isolated hybrid-mem jobs using payload.sessionTarget=isolated", () => {
    const openclawDir = newOpenclawDir();
    seedMaintenanceJobs(openclawDir);

    const jobs = readJobs(openclawDir);
    const target = jobs.find((j) => j.pluginJobId === "hybrid-mem:self-correction-analysis");
    expect(target).toBeTruthy();
    // Simulate payload-level isolation (used by some OpenClaw versions)
    target!.payload = { ...target!.payload, sessionTarget: "isolated" as const, isolated: true as const };
    target!.sessionKey = "agent:main:main";
    writeJobs(openclawDir, jobs);

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });

    const after = readJobs(openclawDir);
    const fixed = after.find((j) => j.pluginJobId === "hybrid-mem:self-correction-analysis");
    expect(fixed).toBeTruthy();
    expect(fixed).not.toHaveProperty("sessionKey");
  });
  it("removes top-level sessionKey for isolated hybrid-mem jobs using legacy isolated=true", () => {
    const openclawDir = newOpenclawDir();
    seedMaintenanceJobs(openclawDir);

    const jobs = readJobs(openclawDir);
    const target = jobs.find((j) => j.pluginJobId === "hybrid-mem:weekly-reflection");
    expect(target).toBeTruthy();
    target!.isolated = true;
    target!.sessionTarget = "shared";
    target!.sessionKey = "agent:main:main";
    writeJobs(openclawDir, jobs);

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });

    const after = readJobs(openclawDir);
    const fixed = after.find((j) => j.pluginJobId === "hybrid-mem:weekly-reflection");
    expect(fixed).toBeTruthy();
    expect(fixed).not.toHaveProperty("sessionKey");
  });

  it("keeps sessionKey for non-isolated hybrid-mem jobs", () => {
    const openclawDir = newOpenclawDir();
    seedMaintenanceJobs(openclawDir);

    const jobs = readJobs(openclawDir);
    const target = jobs.find((j) => j.pluginJobId === "hybrid-mem:monthly-consolidation");
    expect(target).toBeTruthy();
    target!.isolated = false;
    target!.sessionTarget = "shared";
    target!.sessionKey = "agent:main:main";
    writeJobs(openclawDir, jobs);

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });

    const after = readJobs(openclawDir);
    const unchanged = after.find((j) => j.pluginJobId === "hybrid-mem:monthly-consolidation");
    expect(unchanged).toBeTruthy();
    expect(unchanged?.sessionKey).toBe("agent:main:main");
  });

  it("is stable across repeated normalizeExisting runs", () => {
    const openclawDir = newOpenclawDir();
    seedMaintenanceJobs(openclawDir);

    const jobs = readJobs(openclawDir);
    const target = jobs.find((j) => j.pluginJobId === "hybrid-mem:self-correction-analysis");
    expect(target).toBeTruthy();
    target!.sessionTarget = "isolated";
    target!.sessionKey = "agent:main:main";
    writeJobs(openclawDir, jobs);

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });
    const once = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");

    ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });
    const twice = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");

    expect(twice).toBe(once);
  });
});
