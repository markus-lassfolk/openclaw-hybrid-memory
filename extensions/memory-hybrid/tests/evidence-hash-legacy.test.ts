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

  it("treats stored legacy rejected hashes as unchanged evidence", () => {
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

      expect(
        store.isRejectedWithSameEvidence(
          patternId,
          computeEvidenceHash(pattern, { evidenceCountBucketSize: 5 }),
          computeLegacyEvidenceHash(pattern),
        ),
      ).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
