/**
 * Proactive research loop A3: the research-overnight cron agentTurn job. Installed by default
 * (standalone under consolidated mode), gate-disableable via research.enabled, schedule
 * overridable, and — #2056 — never installed with an implicit announce delivery: announce
 * requires an explicit channel + to, everything else maps to mode "none".
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMaintenanceCronFeatureGates,
  ensureMaintenanceCronJobs,
  RESEARCH_OVERNIGHT_JOB_ID,
} from "../cli/install/cron-jobs.js";
import { RESEARCH_UNTRUSTED_CONTENT_SENTENCE } from "../services/research-cron-message.js";

function freshOpenclawDir(): string {
  const openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-research-"));
  mkdirSync(join(openclawDir, "cron"), { recursive: true });
  writeFileSync(join(openclawDir, "openclaw.json"), "{}", "utf-8");
  writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
  return openclawDir;
}

function readJobs(openclawDir: string): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8")) as { jobs: [] }).jobs;
}

describe("research-overnight cron job install", () => {
  it("installs under consolidated mode with the default-ON gate, delivery none, and the safety message", () => {
    const openclawDir = freshOpenclawDir();
    try {
      const result = ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({}),
        scheduleOverrides: { [RESEARCH_OVERNIGHT_JOB_ID]: "15 4 * * *" },
      });
      expect(result.added).toContain("research-overnight");

      const job = readJobs(openclawDir).find((j) => j.pluginJobId === RESEARCH_OVERNIGHT_JOB_ID);
      expect(job).toBeTruthy();
      expect(job?.enabled).toBe(true);
      expect((job?.schedule as { expr: string }).expr).toBe("15 4 * * *");
      expect((job?.delivery as { mode: string }).mode).toBe("none");
      const message = String(job?.message ?? "");
      expect(message).toContain("research pick --json");
      expect(message).toContain("research store --topic-id");
      expect(message).toContain(RESEARCH_UNTRUSTED_CONTENT_SENTENCE);
      expect(message).toContain("TOOLING_BLOCKED"); // both escape hatches present
      expect(message).toContain("SKIPPED: no research topic");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("research.enabled=false disables the job via the feature gate (system-disable, re-enableable)", () => {
    const openclawDir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({}),
      });
      ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({ research: { enabled: false } }),
      });
      const job = readJobs(openclawDir).find((j) => j.pluginJobId === RESEARCH_OVERNIGHT_JOB_ID);
      expect(job?.enabled).toBe(false);
      expect(job?.featureGateDisabled).toBe(true);

      // Gate back on → re-enabled (system-controlled disable, not user-controlled).
      ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({ research: { enabled: true } }),
      });
      expect(readJobs(openclawDir).find((j) => j.pluginJobId === RESEARCH_OVERNIGHT_JOB_ID)?.enabled).toBe(true);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("announce delivery with a missing destination maps to none (#2056)", () => {
    const openclawDir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({}),
        researchDelivery: {
          mode: "announce",
          channel: "telegram",
          to: undefined, // missing destination → must NOT install unsafe announce
          injectDays: 3,
          maxBriefings: 2,
        },
      });
      const job = readJobs(openclawDir).find((j) => j.pluginJobId === RESEARCH_OVERNIGHT_JOB_ID);
      expect((job?.delivery as { mode: string }).mode).toBe("none");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("announce delivery with explicit channel + to installs the announce shape", () => {
    const openclawDir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(openclawDir, undefined, {
        consolidatedCronJobs: true,
        featureGates: buildMaintenanceCronFeatureGates({}),
        researchDelivery: { mode: "announce", channel: "telegram", to: "12345", injectDays: 3, maxBriefings: 2 },
      });
      const job = readJobs(openclawDir).find((j) => j.pluginJobId === RESEARCH_OVERNIGHT_JOB_ID);
      expect(job?.delivery).toMatchObject({ mode: "announce", channel: "telegram", to: "12345" });
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
