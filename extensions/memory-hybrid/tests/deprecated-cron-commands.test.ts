import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/cmd-install.js";
import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
} from "../services/deprecated-cron-commands.js";

describe("deprecated-cron-commands", () => {
  it("detects deprecated command tokens in cron message text", () => {
    const msg = "run: openclaw hybrid-mem consolidate-episodes --since 7d";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("consolidate-episodes");
  });

  it("detects removed workshop remind-pending command", () => {
    const msg =
      "Workshop approval reminder. Run: openclaw hybrid-mem workshop remind-pending. If empty, reply briefly.";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("workshop remind-pending");
  });

  it("detects legacy audit health --strict cron step (#1955)", () => {
    const msg = "hm_step audit-health openclaw hybrid-mem audit health --strict --json";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("audit health --strict --json");
  });

  it("detects free-form workshop reminder without bash harness (#1962)", () => {
    const msg = "Workshop approval reminder. Run: openclaw hybrid-mem digest pending --since 7d";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("Workshop approval reminder. Run:");
  });

  it("verify --fix path normalizes stale audit health --strict cron messages (#1955)", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-test-openclaw-"));
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
                pluginJobId: "hybrid-mem:weekly-audit-health",
                id: "hybrid-mem:weekly-audit-health",
                name: "weekly-audit-health",
                schedule: { kind: "cron", expr: "0 5 * * 0" },
                enabled: true,
                sessionTarget: "isolated",
                payload: {
                  kind: "agentTurn",
                  message:
                    'EXECUTION\n```bash\nhm_step "audit-health" openclaw hybrid-mem audit health --strict --json\n```',
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
        consolidatedCronJobs: false,
      });
      expect(result.normalized).toContain("weekly-audit-health");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:weekly-audit-health") as
        | Record<string, unknown>
        | undefined;
      expect(job).toBeTruthy();
      const payload = job?.payload as { message?: unknown } | undefined;
      const msg = String(payload?.message ?? job?.message ?? "");
      expect(msg).toContain("openclaw hybrid-mem audit health --strict-errors --json");
      expect(msg).not.toContain("audit health --strict --json");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("verify --fix path normalizes stale workshop remind-pending messages", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-test-openclaw-"));
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
                schedule: { kind: "cron", expr: "50 1,13 * * *" },
                enabled: true,
                sessionTarget: "isolated",
                delivery: { mode: "announce" },
                payload: {
                  kind: "agentTurn",
                  message:
                    "Workshop approval reminder. Run: openclaw hybrid-mem workshop remind-pending. If throttled or empty, reply briefly.",
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
        consolidatedCronJobs: false,
      });
      expect(result.normalized).toContain("workshop-approval-reminder");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:workshop-approval-reminder") as
        | Record<string, unknown>
        | undefined;
      expect(job).toBeTruthy();
      const payload = job?.payload as { message?: unknown } | undefined;
      const msg = String(payload?.message ?? job?.message ?? "");
      expect(msg).toContain("openclaw hybrid-mem digest pending --since 7d");
      expect(msg).not.toContain("workshop remind-pending");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("does not flag token substrings", () => {
    const msg = "note: consolidate-episodes-v2 is not a command";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toEqual([]);
  });

  it("detects the stale monthly enrich-entities limit 500 command", () => {
    const msg = 'hm_step "enrich-entities" openclaw hybrid-mem enrich-entities --limit 500 --verbose';
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("enrich-entities --limit 500");
  });

  it("verify --fix path normalizes stale monthly enrich-entities limit 500 messages", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-test-openclaw-"));
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
                pluginJobId: "hybrid-mem:monthly-consolidation",
                name: "monthly-consolidation",
                schedule: { kind: "cron", expr: "0 5 1 * *" },
                enabled: true,
                payload: {
                  kind: "agentTurn",
                  message:
                    'EXECUTION\n```bash\nhm_step "enrich-entities" openclaw hybrid-mem enrich-entities --limit 500 --verbose\n```',
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
        consolidatedCronJobs: false,
      });
      expect(result.normalized).toContain("monthly-consolidation");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:monthly-consolidation") as
        | Record<string, unknown>
        | undefined;
      expect(job).toBeTruthy();
      const payload = job?.payload as { message?: unknown } | undefined;
      const msg = String(payload?.message ?? job?.message ?? "");
      expect(msg).toContain(
        `openclaw hybrid-mem enrich-entities --limit "\${HYBRID_MEM_CLI_JOB_ENRICH_LIMIT:-25}" --verbose`,
      );
      expect(msg).not.toContain("enrich-entities --limit 500");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("detects deprecated step tokens in HM_EXIT output", () => {
    const exit = ["2026-05-08T06:47:17Z consolidate-episodes exit=1", "2026-05-08T06:47:18Z dream-cycle exit=0"].join(
      "\n",
    );
    const hits = findDeprecatedTokensInHmExitContent(exit);
    expect(hits.map((h) => h.token.token)).toEqual(["consolidate-episodes"]);
    expect(hits[0]?.exitCode).toBe(1);
  });

  it("verify --fix path can normalize stale cron job messages", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-test-openclaw-"));
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
                pluginJobId: "hybrid-mem:nightly-dream-cycle",
                name: "nightly-dream-cycle",
                schedule: { kind: "cron", expr: "45 2 * * *" },
                enabled: true,
                payload: {
                  kind: "agentTurn",
                  message: "EXECUTION\n```bash\nopenclaw hybrid-mem consolidate-episodes --verbose\n```",
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
        consolidatedCronJobs: false,
      });
      expect(result.normalized).toContain("nightly-dream-cycle");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const job = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-dream-cycle") as
        | Record<string, unknown>
        | undefined;
      expect(job).toBeTruthy();
      const payload = job?.payload as { message?: unknown } | undefined;
      const msg = String(payload?.message ?? job?.message ?? "");
      expect(msg).toContain("openclaw hybrid-mem dream-cycle");
      expect(msg).not.toContain("consolidate-episodes");
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("consolidated mode disables legacy jobs and adds maintenance-nightly", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-test-openclaw-"));
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
                pluginJobId: "hybrid-mem:nightly-distill",
                name: "nightly-memory-sweep",
                schedule: { kind: "cron", expr: "0 2 * * *" },
                enabled: true,
                payload: { kind: "agentTurn", message: "legacy sweep" },
              },
              {
                pluginJobId: "hybrid-mem:weekly-reflection",
                name: "weekly-reflection",
                schedule: { kind: "cron", expr: "0 3 * * 0" },
                enabled: true,
                payload: { kind: "agentTurn", message: "legacy reflect" },
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
      expect(result.added).toContain("maintenance-nightly");
      expect(result.normalized).toContain("nightly-memory-sweep");
      expect(result.normalized).toContain("weekly-reflection");

      const next = JSON.parse(readFileSync(jobsPath, "utf-8")) as { jobs: Array<Record<string, unknown>> };
      const legacy = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:nightly-distill");
      expect(legacy?.enabled).toBe(false);
      expect(legacy?.superseded).toBe(true);
      const consolidated = next.jobs.find((j) => j.pluginJobId === "hybrid-mem:maintenance-nightly");
      expect(consolidated?.enabled).not.toBe(false);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("collects recent .exit.txt from log root and nested folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-exit-scan-"));
    try {
      const cutoffMs = Date.now() - 120_000;
      writeFileSync(join(dir, "root.exit.txt"), "x");
      mkdirSync(join(dir, "20260101"), { recursive: true });
      writeFileSync(join(dir, "20260101", "day.exit.txt"), "y");
      mkdirSync(join(dir, "manual-rerun"), { recursive: true });
      writeFileSync(join(dir, "manual-rerun", "rerun.exit.txt"), "z");
      const paths = collectRecentHmExitLedgerPaths(dir, cutoffMs);
      expect(paths.length).toBe(3);
      expect(paths.some((p) => p.endsWith("root.exit.txt"))).toBe(true);
      expect(paths.some((p) => p.includes("manual-rerun"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
