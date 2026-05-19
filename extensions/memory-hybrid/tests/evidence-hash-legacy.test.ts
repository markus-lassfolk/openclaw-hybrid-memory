import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { computeEvidenceHash, computeLegacyEvidenceHash, computePatternId } from "../services/pattern-detector.js";

describe("legacy crystallization evidence hashes", () => {
  const pattern: WorkflowPattern = {
    toolSequence: ["exec", "write"],
    totalCount: 10,
    successCount: 7,
    failureCount: 3,
    successRate: 0.7,
    avgDurationMs: 100,
    exampleGoals: ["deploy app"],
  };

  it("keeps legacy hash stable across milestone metric changes", () => {
    const changedMetrics: WorkflowPattern = { ...pattern, totalCount: 95, successRate: 1 };
    expect(computeLegacyEvidenceHash(pattern)).toBe(computeLegacyEvidenceHash(changedMetrics));
    expect(computeLegacyEvidenceHash(pattern)).not.toBe(computeEvidenceHash(pattern, { evidenceCountBucketSize: 5 }));
  });

  it("allows re-proposal when metrics cross milestones despite legacy hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-evidence-hash-"));
    const store = new CrystallizationStore(join(dir, "cp.db"));
    try {
      const patternId = computePatternId(pattern.toolSequence);
      store.create({
        patternId,
        evidenceHash: computeLegacyEvidenceHash(pattern),
        skillName: "legacy-rejected-skill",
        skillContent: "# rejected",
        patternSnapshot: JSON.stringify(pattern),
        status: "rejected",
        rejectionReason: "human: not useful",
      });

      const milestoneHash = computeEvidenceHash(pattern, { evidenceCountBucketSize: 5 });
      const legacyHash = computeLegacyEvidenceHash(pattern);

      // Milestone-only check: stored legacy hash does not equal milestone hash string
      expect(store.isRejectedWithSameEvidence(patternId, milestoneHash)).toBe(false);

      // Legacy-stored rejection with unchanged metrics since snapshot: still suppressed
      expect(
        store.isRejectedWithSameEvidence(patternId, milestoneHash, {
          legacyEvidenceHash: legacyHash,
          evidenceCountBucketSize: 5,
        }),
      ).toBe(true);

      const crossedMetrics: WorkflowPattern = { ...pattern, totalCount: 95, successRate: 1 };
      const crossedMilestoneHash = computeEvidenceHash(crossedMetrics, { evidenceCountBucketSize: 5 });
      expect(
        store.isRejectedWithSameEvidence(patternId, crossedMilestoneHash, {
          legacyEvidenceHash: computeLegacyEvidenceHash(crossedMetrics),
          evidenceCountBucketSize: 5,
        }),
      ).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
