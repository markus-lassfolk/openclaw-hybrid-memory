import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isJobRunSummaryPath,
  isOrchestratorSummaryPath,
  listMaintenanceRuns,
  resolveRunArtifacts,
} from "../services/maintenance-job-run/run-catalog.js";
import { formatTimestampUtcFromMs } from "../utils/dates.js";

function recentMaintenanceDayDir(root: string, offsetMs = 0): { dayDir: string; dayStamp: string; iso: string } {
  const at = Date.now() - offsetMs;
  const dayStamp = formatTimestampUtcFromMs(at).slice(0, 10).replace(/-/g, "");
  return {
    dayDir: join(root, dayStamp),
    dayStamp,
    iso: new Date(at).toISOString(),
  };
}

describe("maintenance run catalog", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("lists standalone JobRun summaries without misclassifying them as orchestrator runs", () => {
    root = mkdtempSync(join(tmpdir(), "run-catalog-"));
    const { dayDir, iso } = recentMaintenanceDayDir(root);
    const standaloneDir = join(dayDir, "job-runs-standalone", "generate-proposals-abc123");
    mkdirSync(standaloneDir, { recursive: true });
    writeFileSync(
      join(standaloneDir, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobRunId: "generate-proposals-abc123",
        command: "generate-proposals",
        startedAt: iso,
        semanticOutcome: "partial",
        phases: [],
        artifactPaths: { summary: join(standaloneDir, "summary.json") },
      }),
      "utf-8",
    );

    const runs = listMaintenanceRuns({ logRoot: root, since: "7d" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("job");
    expect(runs[0]?.id).toBe("generate-proposals-abc123");
  });

  it("lists orchestrator summaries separately from standalone job runs", () => {
    root = mkdtempSync(join(tmpdir(), "run-catalog-orch-"));
    const { dayDir, iso } = recentMaintenanceDayDir(root, 60 * 60 * 1000);
    mkdirSync(dayDir, { recursive: true });
    const startedAt = iso;
    const finishedAt = new Date(Date.parse(iso) + 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(dayDir, "maintenance-nightly-xyz.summary.json"),
      JSON.stringify({
        runId: "maintenance-nightly-xyz",
        startedAt,
        finishedAt,
        exitCode: 0,
      }),
      "utf-8",
    );

    const runs = listMaintenanceRuns({ logRoot: root, since: "7d" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("orchestrator");
    expect(runs[0]?.id).toBe("maintenance-nightly-xyz");
  });
});

describe("isJobRunSummaryPath / isOrchestratorSummaryPath (loop iteration 96 regression, Windows path separators)", () => {
  const winJobRunPath =
    "C:\\Users\\ci\\.openclaw\\logs\\cron-hybrid-mem\\20260101\\job-runs\\generate-proposals-abc123\\summary.json";
  const winStandaloneJobRunPath =
    "C:\\Users\\ci\\.openclaw\\logs\\cron-hybrid-mem\\20260101\\job-runs-standalone\\generate-proposals-abc123\\summary.json";
  const winOrchestratorPath =
    "C:\\Users\\ci\\.openclaw\\logs\\cron-hybrid-mem\\20260101\\maintenance-nightly-xyz.summary.json";
  const posixJobRunPath =
    "/home/ci/.openclaw/logs/cron-hybrid-mem/20260101/job-runs/generate-proposals-abc123/summary.json";
  const posixOrchestratorPath = "/home/ci/.openclaw/logs/cron-hybrid-mem/20260101/maintenance-nightly-xyz.summary.json";

  it("classifies job-run summary.json paths with Windows-style backslash separators", () => {
    expect(isJobRunSummaryPath(winJobRunPath)).toBe(true);
    expect(isJobRunSummaryPath(winStandaloneJobRunPath)).toBe(true);
    expect(isOrchestratorSummaryPath(winJobRunPath)).toBe(false);
  });

  it("classifies orchestrator .summary.json paths with Windows-style backslash separators", () => {
    expect(isOrchestratorSummaryPath(winOrchestratorPath)).toBe(true);
    expect(isJobRunSummaryPath(winOrchestratorPath)).toBe(false);
  });

  it("still classifies POSIX-style forward-slash paths correctly (no regression)", () => {
    expect(isJobRunSummaryPath(posixJobRunPath)).toBe(true);
    expect(isOrchestratorSummaryPath(posixJobRunPath)).toBe(false);
    expect(isOrchestratorSummaryPath(posixOrchestratorPath)).toBe(true);
    expect(isJobRunSummaryPath(posixOrchestratorPath)).toBe(false);
  });

  it("resolveRunArtifacts derives log-root-relative log/exit paths for a Windows-style orchestrator summary", () => {
    const artifacts = resolveRunArtifacts({
      kind: "orchestrator",
      id: "maintenance-nightly-xyz",
      path: winOrchestratorPath,
    });
    expect(artifacts.log).toBe("C:\\Users\\ci\\.openclaw\\logs\\cron-hybrid-mem\\maintenance-nightly-xyz.log");
    expect(artifacts.exit).toBe("C:\\Users\\ci\\.openclaw\\logs\\cron-hybrid-mem\\maintenance-nightly-xyz.exit.txt");
  });

  it("resolveRunArtifacts derives log-root-relative log/exit paths for a POSIX orchestrator summary (no regression)", () => {
    const artifacts = resolveRunArtifacts({
      kind: "orchestrator",
      id: "maintenance-nightly-xyz",
      path: posixOrchestratorPath,
    });
    expect(artifacts.log).toBe("/home/ci/.openclaw/logs/cron-hybrid-mem/maintenance-nightly-xyz.log");
    expect(artifacts.exit).toBe("/home/ci/.openclaw/logs/cron-hybrid-mem/maintenance-nightly-xyz.exit.txt");
  });
});
