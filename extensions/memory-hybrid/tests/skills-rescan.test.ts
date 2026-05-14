/**
 * Re-scan of installed crystallization skills (#1392) — validates on-disk SKILL.md
 * and quarantines rows that fail generated-skill validation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";

const CFG_BASE: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
  evidenceCountBucketSize: 5,
};

describe("CrystallizationProposer.rescanInstalledSkills", () => {
  let tmpDir: string;
  let cStore: CrystallizationStore;
  let wfStore: WorkflowStore;

  afterEach(() => {
    wfStore.close();
    cStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quarantines installed proposal when on-disk SKILL.md fails validation", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-rescan-"));
    const outputDir = join(tmpDir, "skills");
    const skillDir = join(outputDir, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    const outputPath = join(skillDir, "SKILL.md");
    writeFileSync(outputPath, "# not a valid generated skill\n", "utf-8");

    cStore = new CrystallizationStore(join(tmpDir, "cp.db"));
    wfStore = new WorkflowStore(join(tmpDir, "wf.db"));

    const pattern: WorkflowPattern = {
      toolSequence: ["read", "write"],
      totalCount: 5,
      successCount: 5,
      failureCount: 0,
      successRate: 1,
      avgDurationMs: 100,
      exampleGoals: ["Deploy production application release with full verification steps"],
    };

    const p = cStore.create({
      patternId: "pid1",
      evidenceHash: "ev1",
      skillName: "bad-skill",
      skillContent: "# placeholder",
      patternSnapshot: JSON.stringify(pattern),
      status: "validated",
    });
    expect(cStore.approve(p.id)).not.toBeNull();
    cStore.install(p.id, outputPath);

    const cfg: CrystallizationConfig = { ...CFG_BASE, outputDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.rescanInstalledSkills();

    expect(result.scanned).toBe(1);
    expect(result.quarantined).toBe(1);
    const row = cStore.getById(p.id);
    expect(row?.status).toBe("quarantined");
    expect(row?.rejectionReason ?? "").toMatch(/^stale validation:/);
  });
});
