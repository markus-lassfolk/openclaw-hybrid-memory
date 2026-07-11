import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs, buildMaintenanceCronFeatureGates } from "../cli/install/cron-jobs.js";

describe("ensureMaintenanceCronJobs verify --fix (#1971, #1972)", () => {
  it("matches existing jobs by id when pluginJobId is missing (#1971)", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-id-match-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");

      const jobsPath = join(openclawDir, "cron", "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify(
          {
            jobs: [
              {
                id: "hybrid-mem:maintenance-nightly",
                name: "maintenance-nightly",
                schedule: { kind: "cron", expr: "0 2 * * *" },
                enabled: true,
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: "legacy nightly" },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: true,
        reEnableDisabled: false,
        consolidatedCronJobs: true,
      });

      expect(result.added).not.toContain("maintenance-nightly");
      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const nightlyJobs = next.jobs.filter((j) => j.id === "hybrid-mem:maintenance-nightly");
      expect(nightlyJobs).toHaveLength(1);
      expect(nightlyJobs[0]?.pluginJobId).toBe("hybrid-mem:maintenance-nightly");
      expect(result.normalized).toContain("maintenance-nightly");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("normalizes workshop-approval-reminder in consolidated mode (#1972)", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-workshop-consolidated-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");

      const jobsPath = join(openclawDir, "cron", "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify(
          {
            jobs: [
              {
                id: "hybrid-mem:maintenance-nightly",
                pluginJobId: "hybrid-mem:maintenance-nightly",
                name: "maintenance-nightly",
                schedule: { kind: "cron", expr: "0 2 * * *" },
                enabled: true,
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: "nightly ok" },
              },
              {
                pluginJobId: "hybrid-mem:workshop-approval-reminder",
                id: "hybrid-mem:workshop-approval-reminder",
                name: "workshop-approval-reminder",
                schedule: { kind: "cron", expr: "50 1,13 * * *" },
                enabled: true,
                sessionTarget: "isolated",
                delivery: { mode: "announce" },
                payload: {
                  kind: "agentTurn",
                  message:
                    "Workshop approval reminder. Run: openclaw hybrid-mem digest pending --since 7d. If empty, reply briefly.",
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: true,
        reEnableDisabled: false,
        consolidatedCronJobs: true,
      });

      expect(result.normalized).toContain("workshop-approval-reminder");
      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:workshop-approval-reminder");
      expect(job).toBeTruthy();
      const payload = job?.payload as { message?: string } | undefined;
      const msg = String(payload?.message ?? job?.message ?? "");
      expect(msg).toContain("openclaw hybrid-mem digest pending --since 7d --format md");
      expect(msg).toContain("```bash");
      expect(msg).not.toBe(
        "Workshop approval reminder. Run: openclaw hybrid-mem digest pending --since 7d. If empty, reply briefly.",
      );
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("buildMaintenanceCronFeatureGates includes workshop and lifecycle github gates", () => {
    const gates = buildMaintenanceCronFeatureGates({
      sensorSweep: { enabled: true },
      nightlyCycle: { enabled: false },
      crystallization: { enabled: true },
      workshop: { enabled: true },
      lifecycle: { adapters: { github: { enabled: true } } },
    });
    expect(gates).toEqual({
      "sensorSweep.enabled": true,
      "nightlyCycle.enabled": false,
      "crystallization.enabled": true,
      "workshop.enabled": true,
      "lifecycle.adapters.github.enabled": true,
      // research is the one default-ON gate (proactive research loop ships enabled)
      "research.enabled": true,
    });
  });

  it("disables workshop-approval-reminder when workshop.enabled is false", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-workshop-gate-off-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");

      const jobsPath = join(openclawDir, "cron", "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify(
          {
            jobs: [
              {
                pluginJobId: "hybrid-mem:workshop-approval-reminder",
                id: "hybrid-mem:workshop-approval-reminder",
                name: "workshop-approval-reminder",
                enabled: true,
                schedule: { kind: "cron", expr: "50 1,13 * * *" },
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: "Workshop reminder" },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: true,
        reEnableDisabled: false,
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({ workshop: { enabled: false } }),
      });

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:workshop-approval-reminder");
      expect(job?.enabled).toBe(false);
      expect(job?.featureGateDisabled).toBe(true);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("re-enables feature-gate-disabled daily-lifecycle-sync when github adapter enabled", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-lifecycle-gate-on-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");

      const jobsPath = join(openclawDir, "cron", "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify(
          {
            jobs: [
              {
                pluginJobId: "hybrid-mem:daily-lifecycle-sync",
                id: "hybrid-mem:daily-lifecycle-sync",
                name: "daily-lifecycle-sync",
                enabled: false,
                featureGateDisabled: true,
                schedule: { kind: "cron", expr: "0 4 * * *" },
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: "lifecycle sync" },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      ensureMaintenanceCronJobs(openclawDir, undefined, {
        normalizeExisting: true,
        reEnableDisabled: false,
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({
          lifecycle: { adapters: { github: { enabled: true } } },
        }),
      });

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:daily-lifecycle-sync");
      expect(job?.enabled).toBe(true);
      expect(job?.featureGateDisabled).toBeUndefined();
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
