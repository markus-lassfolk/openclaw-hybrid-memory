/**
 * Regression test for CrystallizationProposer.restoreProposal's rollback path: if both the
 * DB status flip AND the rename-back-to-quarantine attempt fail, the just-restored skill
 * directory must be left in place, not deleted — it is the only surviving copy of the skill.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";

let quarantineDirPath: string;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      const to = args[1];
      if (typeof to === "string" && to === quarantineDirPath) {
        throw new Error("simulated rename-back-to-quarantine failure");
      }
      return actual.renameSync(...args);
    },
  };
});

const BASE_CFG: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
  maxPendingProposals: 100,
  evidenceCountBucketSize: 5,
  placeholderEmailDomains: ["example.com", "localhost", "test.com", "example.org"],
  excludeSystemGoals: true,
};

let tmpDir: string;
let wfStore: WorkflowStore;
let cStore: CrystallizationStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crystal-proposer-restore-rollback-"));
  wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
  cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
});

afterEach(() => {
  wfStore.close();
  cStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CrystallizationProposer.restoreProposal — rollback data-loss regression", () => {
  it("leaves the restored skill directory in place when both the DB update and the rename-back both fail", () => {
    const outputDir = join(tmpDir, "restore-skills");
    mkdirSync(outputDir, { recursive: true });
    quarantineDirPath = join(outputDir, "..", "crystallization-quarantine", "2026-06-07", "double-fail-skill");
    mkdirSync(quarantineDirPath, { recursive: true });
    const quarantineSkillPath = join(quarantineDirPath, "SKILL.md");
    writeFileSync(quarantineSkillPath, "# Double failure rollback test\n", "utf-8");

    const proposal = cStore.create({
      patternId: "double-fail-pattern",
      evidenceHash: "ev-double-fail",
      skillName: "double-fail-skill",
      skillContent: readFileSync(quarantineSkillPath, "utf-8"),
      patternSnapshot: "{}",
      status: "quarantined",
      rejectionReason: "stale validation: test",
    });
    cStore.updateOutputPath(proposal.id, quarantineSkillPath);

    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    vi.spyOn(cStore, "restoreFromQuarantine").mockReturnValue(null);

    const result = proposer.restoreProposal(proposal.id);

    expect(result.success).toBe(false);
    // The forward move succeeded and the rollback-to-quarantine rename failed, so the skill's
    // only surviving copy is at its restored (active) location. Without the fix, the catch
    // block's `removeCrystallizedSkillDir` call deletes exactly this directory.
    expect(existsSync(join(outputDir, "double-fail-skill", "SKILL.md"))).toBe(true);
  });
});
