import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import { collectDreamCycleLog } from "../routes/dashboard/workshop-collectors.js";

describe("collectDreamCycleLog", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads stage artifacts from run-* subdirectories", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-log-"));
    const runDir = join(tmpDir, "run-20260605T120000Z");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "stage-01-prune.json"),
      JSON.stringify({ runId: "20260605T120000Z", stageNumber: 1, stage: "prune", status: "complete" }),
    );
    writeFileSync(
      join(runDir, "stage-02-reflection.json"),
      JSON.stringify({ runId: "20260605T120000Z", stageNumber: 2, stage: "reflection", status: "complete" }),
    );

    const runs = collectDreamCycleLog(
      {
        cfg: {} as HybridMemoryConfig,
        factsDb: {} as never,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
        dreamCycleLogDir: tmpDir,
      },
      5,
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("20260605T120000Z");
    expect(runs[0]?.stages).toHaveLength(2);
    expect(runs[0]?.stages?.[0]?.stageNumber).toBe(1);
    expect(runs[0]?.stages?.[1]?.stageNumber).toBe(2);
  });
});
