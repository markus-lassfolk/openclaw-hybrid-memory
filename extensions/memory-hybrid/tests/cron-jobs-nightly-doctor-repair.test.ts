/**
 * hybrid-mem:nightly-doctor-repair: `doctor --fix --reconcile` runs nightly so SQLite/LanceDB
 * drift self-heals without an operator running it manually (issue #2103 follow-up).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/install/cron-jobs.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../services/hybrid-mem-cron-default-job-steps.js";

function setupCronStore(): { openclawDir: string; jobsPath: string } {
  const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-doctor-repair-"));
  mkdirSync(join(openclawDir, "cron"), { recursive: true });
  writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");
  const jobsPath = join(openclawDir, "cron", "jobs.json");
  writeFileSync(jobsPath, JSON.stringify({ jobs: [] }, null, 2), "utf-8");
  return { openclawDir, jobsPath };
}

describe("hybrid-mem:nightly-doctor-repair cron job", () => {
  it("is installed on a fresh setup under default (consolidated) mode", () => {
    const { openclawDir, jobsPath } = setupCronStore();
    try {
      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: false,
        reEnableDisabled: false,
      });
      expect(result.added).toContain("nightly-doctor-repair");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-doctor-repair");
      expect(job).toBeTruthy();
      expect(job?.schedule).toEqual({ kind: "cron", expr: "15 3 * * *" });
      expect(String(job?.message)).toContain("openclaw hybrid-mem doctor --fix --reconcile");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("is installed under non-consolidated (legacy per-task) mode too", () => {
    const { openclawDir, jobsPath } = setupCronStore();
    try {
      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: false,
        reEnableDisabled: false,
        consolidatedCronJobs: false,
      });
      expect(result.added).toContain("nightly-doctor-repair");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-doctor-repair");
      expect(job).toBeTruthy();
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("has a required-step entry matching its cron message step name", () => {
    expect(HYBRID_MEM_CRON_DEFAULT_JOB_STEPS["hybrid-mem:nightly-doctor-repair"]).toEqual(["doctor-fix-reconcile"]);
  });
});
