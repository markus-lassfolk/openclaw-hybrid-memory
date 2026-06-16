import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTimestampUtcFromMs } from "../utils/dates.js";
import { listMaintenanceRuns } from "../services/maintenance-job-run/run-catalog.js";

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
