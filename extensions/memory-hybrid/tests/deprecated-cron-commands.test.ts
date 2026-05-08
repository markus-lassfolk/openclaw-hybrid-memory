import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
} from "../services/deprecated-cron-commands.js";
import { ensureMaintenanceCronJobs } from "../cli/cmd-install.js";

describe("deprecated-cron-commands", () => {
  it("detects deprecated command tokens in cron message text", () => {
    const msg = "run: openclaw hybrid-mem consolidate-episodes --since 7d";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toContain("consolidate-episodes");
  });

  it("does not flag token substrings", () => {
    const msg = "note: consolidate-episodes-v2 is not a command";
    const hits = findDeprecatedHybridMemCronTokens(msg).map((h) => h.token);
    expect(hits).toEqual([]);
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
