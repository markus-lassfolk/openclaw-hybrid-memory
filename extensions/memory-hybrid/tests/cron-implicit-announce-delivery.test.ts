import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/install/cron-jobs.js";
import { parseDigestWeeklyDeliveryOnly } from "../config/parsers/features.js";

/**
 * Issue #2056: hybrid-memory cron jobs can install unsafe implicit announce delivery
 * (sessionTarget=isolated + payload.kind=agentTurn + delivery.mode=announce with missing
 * delivery.channel or delivery.to). The OpenClaw cron safety guard refuses delivery in that
 * shape and records the job as `error` even when the body work succeeded. These tests cover
 * both generation (so new jobs never ship unsafe) and repair/migration (so existing
 * hybrid-mem:* jobs with the unsafe shape are normalized by upgrade / verify --fix).
 */

const SAFE_DUMMY_TELEGRAM_TO = "12345";

function readJobs(openclawDir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  const parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

function findJob(jobs: Array<Record<string, unknown>>, pluginJobId: string): Record<string, unknown> | undefined {
  return jobs.find((j) => j?.pluginJobId === pluginJobId || j?.id === pluginJobId);
}

function freshOpenclawDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-cron-issue2056-"));
  mkdirSync(join(dir, "cron"), { recursive: true });
  writeFileSync(join(dir, "openclaw.json"), "{}", "utf-8");
  return dir;
}

describe("issue #2056 — generation never produces unsafe implicit announce", () => {
  it("weekly-pending-digest with no digest.weekly.delivery config → delivery.mode none (was announce)", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
      });
      const jobs = readJobs(dir);
      const target = findJob(jobs, "hybrid-mem:weekly-pending-digest");
      expect(target).toBeTruthy();
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("weekly-pending-digest with digest.weekly.delivery.mode=system → delivery.mode none (legacy default)", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
        digestWeeklyDelivery: { mode: "system" },
      });
      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("weekly-pending-digest with digest.weekly.delivery.mode=telegram + chatId → announce with channel+to+bestEffort", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
        digestWeeklyDelivery: { mode: "telegram", chatId: SAFE_DUMMY_TELEGRAM_TO },
      });
      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      const d = target?.delivery as Record<string, unknown>;
      expect(d?.mode).toBe("announce");
      expect(d?.channel).toBe("telegram");
      expect(d?.to).toBe(SAFE_DUMMY_TELEGRAM_TO);
      expect(d?.bestEffort).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("weekly-pending-digest with digest.weekly.delivery.mode=telegram but missing chatId → delivery.mode none", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
        digestWeeklyDelivery: { mode: "telegram" },
      });
      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workshop-approval-reminder installs with delivery.mode none (was announce)", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: false,
        consolidatedCronJobs: false,
        featureGates: {
          "workshop.enabled": true,
          "sensorSweep.enabled": false,
          "nightlyCycle.enabled": false,
          "crystallization.enabled": false,
          "lifecycle.adapters.github.enabled": false,
        },
      });
      const target = findJob(readJobs(dir), "hybrid-mem:workshop-approval-reminder");
      expect(target).toBeTruthy();
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maintenance-log-analyzer installs with delivery.mode none (was announce)", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: false,
        consolidatedCronJobs: false,
      });
      const target = findJob(readJobs(dir), "hybrid-mem:maintenance-log-analyzer");
      expect(target).toBeTruthy();
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all other hybrid-mem cron jobs remain delivery.mode none", () => {
    const dir = freshOpenclawDir();
    try {
      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: false,
        consolidatedCronJobs: false,
      });
      const jobs = readJobs(dir).filter((j) => String(j?.pluginJobId ?? "").startsWith("hybrid-mem:"));
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) {
        const d = (j.delivery as { mode?: string } | undefined) ?? {};
        expect(["none"]).toContain(d.mode);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("issue #2056 — verify --fix repairs existing unsafe jobs", () => {
  function writeLegacyUnsafeJob(
    dir: string,
    pluginJobId: string,
    name: string,
    delivery: Record<string, unknown>,
  ): void {
    writeFileSync(
      join(dir, "cron", "jobs.json"),
      JSON.stringify(
        {
          jobs: [
            {
              pluginJobId,
              id: pluginJobId,
              name,
              schedule: { kind: "cron", expr: "30 3 * * *" },
              enabled: true,
              sessionTarget: "isolated",
              payload: { kind: "agentTurn", message: "legacy unsafe job body" },
              delivery,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  it("repairs hybrid-mem:maintenance-log-analyzer with delivery.mode=announce and no channel/to → mode none", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:maintenance-log-analyzer", "maintenance-log-analyzer", {
        mode: "announce",
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
      });

      const target = findJob(readJobs(dir), "hybrid-mem:maintenance-log-analyzer");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs hybrid-mem:workshop-approval-reminder with delivery.mode=announce and no channel/to → mode none", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:workshop-approval-reminder", "workshop-approval-reminder", {
        mode: "announce",
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
        featureGates: {
          "workshop.enabled": true,
          "sensorSweep.enabled": false,
          "nightlyCycle.enabled": false,
          "crystallization.enabled": false,
          "lifecycle.adapters.github.enabled": false,
        },
      });

      const target = findJob(readJobs(dir), "hybrid-mem:workshop-approval-reminder");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs hybrid-mem:weekly-pending-digest with delivery.mode=announce and no channel/to → mode none", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:weekly-pending-digest", "weekly-pending-digest", {
        mode: "announce",
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
      });

      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs hybrid-mem:* announce + channel=system to mode none (uniform apply)", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:maintenance-log-analyzer", "maintenance-log-analyzer", {
        mode: "announce",
        channel: "system",
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
      });

      const target = findJob(readJobs(dir), "hybrid-mem:maintenance-log-analyzer");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves valid explicit telegram delivery for weekly-pending-digest when configured", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:weekly-pending-digest", "weekly-pending-digest", {
        mode: "announce",
        channel: "telegram",
        to: SAFE_DUMMY_TELEGRAM_TO,
        bestEffort: true,
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
        digestWeeklyDelivery: { mode: "telegram", chatId: SAFE_DUMMY_TELEGRAM_TO },
      });

      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      const d = target?.delivery as Record<string, unknown>;
      expect(d?.mode).toBe("announce");
      expect(d?.channel).toBe("telegram");
      expect(d?.to).toBe(SAFE_DUMMY_TELEGRAM_TO);
      expect(d?.bestEffort).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downgrades weekly-pending-digest with telegram channel but stale announce without `to` to mode none when no chatId", () => {
    const dir = freshOpenclawDir();
    try {
      writeLegacyUnsafeJob(dir, "hybrid-mem:weekly-pending-digest", "weekly-pending-digest", {
        mode: "announce",
        channel: "telegram",
      });

      ensureMaintenanceCronJobs(dir, undefined, {
        normalizeExisting: true,
        consolidatedCronJobs: false,
      });

      const target = findJob(readJobs(dir), "hybrid-mem:weekly-pending-digest");
      expect(target?.delivery).toEqual({ mode: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("issue #2056 — parser default is mode=none (no implicit announce)", () => {
  it("parseDigestWeeklyDeliveryOnly({}) returns mode=none", () => {
    const out = parseDigestWeeklyDeliveryOnly({});
    expect(out.mode).toBe("none");
  });

  it("parseDigestWeeklyDeliveryOnly({ digest: {} }) returns mode=none", () => {
    const out = parseDigestWeeklyDeliveryOnly({ digest: {} });
    expect(out.mode).toBe("none");
  });

  it("parseDigestWeeklyDeliveryOnly ignores legacy 'system' as destinationless (mode=none)", () => {
    const out = parseDigestWeeklyDeliveryOnly({ digest: { weekly: { delivery: { mode: "system" } } } });
    expect(out.mode).toBe("none");
  });

  it("parseDigestWeeklyDeliveryOnly downgrades telegram without chatId to mode=none", () => {
    const out = parseDigestWeeklyDeliveryOnly({ digest: { weekly: { delivery: { mode: "telegram" } } } });
    expect(out.mode).toBe("none");
  });

  it("parseDigestWeeklyDeliveryOnly honors telegram + chatId", () => {
    const out = parseDigestWeeklyDeliveryOnly({
      digest: { weekly: { delivery: { mode: "telegram", chatId: SAFE_DUMMY_TELEGRAM_TO } } },
    });
    expect(out.mode).toBe("telegram");
    expect(out.chatId).toBe(SAFE_DUMMY_TELEGRAM_TO);
  });

  it("parseDigestWeeklyDeliveryOnly downgrades unknown mode string to mode=none (with warn)", () => {
    const out = parseDigestWeeklyDeliveryOnly({ digest: { weekly: { delivery: { mode: "carrier-pigeon" } } } });
    expect(out.mode).toBe("none");
  });
});
