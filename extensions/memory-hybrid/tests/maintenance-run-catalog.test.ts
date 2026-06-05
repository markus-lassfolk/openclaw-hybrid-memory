import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMaintenanceRuns } from "../services/maintenance-job-run/run-catalog.js";

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
    const standaloneDir = join(root, "job-runs-standalone", "20260605", "generate-proposals-abc123");
    mkdirSync(standaloneDir, { recursive: true });
    writeFileSync(
      join(standaloneDir, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobRunId: "generate-proposals-abc123",
        command: "generate-proposals",
        startedAt: "2026-06-05T12:00:00.000Z",
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
    const dayDir = join(root, "20260605");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "maintenance-nightly-xyz.summary.json"),
      JSON.stringify({
        runId: "maintenance-nightly-xyz",
        startedAt: "2026-06-05T02:00:00.000Z",
        finishedAt: "2026-06-05T03:00:00.000Z",
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
