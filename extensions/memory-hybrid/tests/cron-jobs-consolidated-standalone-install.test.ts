/**
 * Regression test (loop iteration 74): under consolidated-cron mode, standalone/optional jobs
 * (weekly-pending-digest, maintenance-log-analyzer, sensor-sweep — all `supersededByOrchestrator:
 * false`) were never actually installed on a fresh setup, even though
 * buildMaintenanceCronJobDefsForEnsure() correctly includes them in the defs it hands to the
 * install loop (its own doc comment: "Standalone / optional jobs still normalized in consolidated
 * orchestrator mode"). shouldSkipAddingMaintenanceCronJob()'s `useConsolidated` branch re-derived
 * membership in CONSOLIDATED_CRON_JOBS from scratch and skipped anything not in that set —
 * silently undoing buildMaintenanceCronJobDefsForEnsure()'s inclusion of these jobs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/install/cron-jobs.js";

describe("ensureMaintenanceCronJobs — standalone jobs under consolidated mode (loop iteration 74 regression)", () => {
  it("installs weekly-pending-digest and maintenance-log-analyzer on a fresh setup with consolidatedCronJobs: true", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-consolidated-standalone-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");
      const jobsPath = join(openclawDir, "cron", "jobs.json");
      writeFileSync(jobsPath, JSON.stringify({ jobs: [] }, null, 2), "utf-8");

      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: false,
        reEnableDisabled: false,
        consolidatedCronJobs: true,
      });

      expect(result.added).toContain("weekly-pending-digest");
      expect(result.added).toContain("maintenance-log-analyzer");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const digestJob = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:weekly-pending-digest");
      const analyzerJob = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:maintenance-log-analyzer");
      expect(digestJob).toBeTruthy();
      expect(analyzerJob).toBeTruthy();
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
