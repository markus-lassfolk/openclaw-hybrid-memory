import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { previewCrystallizationCycle } from "../services/crystallization-maintenance.js";

function makeCfg(tmpDir: string): HybridMemoryConfig {
  return {
    sqlitePath: join(tmpDir, "facts.db"),
    crystallization: {
      enabled: false,
      minUsageCount: 3,
      minSuccessRate: 0.5,
      autoApprove: false,
      outputDir: join(tmpDir, "skills"),
      maxCrystallized: 50,
      pruneUnusedDays: 30,
      maxPendingProposals: 100,
      evidenceCountBucketSize: 5,
      placeholderEmailDomains: ["example.com"],
      excludeSystemGoals: true,
    },
  } as HybridMemoryConfig;
}

describe("previewCrystallizationCycle", () => {
  let tmpDir: string;
  let wfPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "crystal-preview-"));
    wfPath = join(tmpDir, "workflow-traces.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns user-facing candidates when patterns qualify", () => {
    const wf = new WorkflowStore(wfPath);
    for (let i = 0; i < 5; i++) {
      wf.record({
        goal: `Deploy staging API release ${i}`,
        toolSequence: ["read", "exec", "write"],
        outcome: "success",
      });
    }
    wf.close();

    const preview = previewCrystallizationCycle(makeCfg(tmpDir), { workflowDbPath: wfPath });
    expect(preview.skippedReason).toBeUndefined();
    expect(preview.candidates.length).toBeGreaterThan(0);
    expect(preview.candidates[0]?.exampleGoals.some((g) => g.includes("Deploy"))).toBe(true);
  });

  it("explains when only cron patterns exist", () => {
    const wf = new WorkflowStore(wfPath);
    for (let i = 0; i < 4; i++) {
      wf.record({
        goal: `[cron:abc maintenance ${i}]`,
        toolSequence: ["read", "exec"],
        outcome: "success",
      });
    }
    wf.close();

    const preview = previewCrystallizationCycle(makeCfg(tmpDir), { workflowDbPath: wfPath });
    expect(preview.candidates).toHaveLength(0);
    expect(preview.reasons.join(" ")).toMatch(/excludeSystemGoals|user-facing workflow data/i);
    expect(preview.patternCounts.raw).toBeGreaterThan(0);
    expect(preview.patternCounts.userFacing).toBe(0);
  });
});
