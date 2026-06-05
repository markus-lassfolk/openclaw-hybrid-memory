/**
 * Pattern Detector — identify crystallization candidates from WorkflowStore (Issue #208).
 *
 * Analyses workflow patterns from WorkflowStore.getPatterns() and scores them
 * by usage count × success rate to identify strong candidates.
 * Deduplication: skips patterns that already have a pending/approved proposal.
 */

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern, WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { capturePluginError } from "./error-reporter.js";
import {
  computeEvidenceHash,
  computeLegacyEvidenceHash,
  computePatternId,
  scorePattern,
} from "./pattern-detector-hash.js";
import { patternHasUserFacingGoal } from "./workflow-goal-classifier.js";

export {
  computeEvidenceHash,
  computeLegacyEvidenceHash,
  computePatternId,
  scorePattern,
} from "./pattern-detector-hash.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrystallizationCandidate {
  /** Stable hash of the tool sequence used as a pattern identifier */
  patternId: string;
  /** Stable hash of non-metric evidence (used to suppress immediate regen after rejection). */
  evidenceHash: string;
  pattern: WorkflowPattern;
  /** Composite score: usageCount × successRate (higher = better candidate) */
  score: number;
}

// ---------------------------------------------------------------------------
// PatternDetector — exported as a free function (no class wrapper needed)
// ---------------------------------------------------------------------------

/**
 * Detect crystallization candidates from recent workflow patterns.
 * Applies min usage count and success rate thresholds, skips already-proposed patterns.
 * Returns candidates sorted by score descending.
 */
export function detectCrystallizationCandidates(
  workflowStore: WorkflowStore,
  crystallizationStore: CrystallizationStore,
  cfg: CrystallizationConfig,
): CrystallizationCandidate[] {
  if (!cfg.enabled) return [];

  let patterns: WorkflowPattern[];
  try {
    patterns = workflowStore.getPatterns({
      minSuccessRate: cfg.minSuccessRate,
      traceSampleLimit: 6000,
      limit: 200,
      excludeSystemGoals: cfg.excludeSystemGoals,
      excludeGoalPatterns: cfg.excludeGoalPatterns,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "detect-patterns",
      subsystem: "pattern-detector",
    });
    return [];
  }

  const candidates: CrystallizationCandidate[] = [];

  for (const pattern of patterns) {
    // Must meet minimum usage threshold
    if (pattern.totalCount < cfg.minUsageCount) continue;

    // Must meet minimum success rate
    if (pattern.successRate < cfg.minSuccessRate) continue;

    // Must have at least one tool in sequence
    if (pattern.toolSequence.length === 0) continue;

    if (
      !patternHasUserFacingGoal(pattern.exampleGoals, {
        excludeSystemGoals: cfg.excludeSystemGoals,
        excludeGoalPatterns: cfg.excludeGoalPatterns,
      })
    ) {
      continue;
    }

    const patternId = computePatternId(pattern.toolSequence);
    const evidenceHash = computeEvidenceHash(pattern, {
      evidenceCountBucketSize: cfg.evidenceCountBucketSize,
    });
    const legacyEvidenceHash = computeLegacyEvidenceHash(pattern);

    // Skip if latest rejected/quarantined proposal was based on the same unchanged evidence.
    // Prevents "spammy" re-proposals after a human rejection unless substantive
    // inputs (tool sequence / example goals / metric milestones) changed.
    try {
      if (
        crystallizationStore.isRejectedWithSameEvidence(patternId, evidenceHash, {
          legacyEvidenceHash,
          evidenceCountBucketSize: cfg.evidenceCountBucketSize,
        })
      ) {
        continue;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "check-rejected-evidence",
        subsystem: "pattern-detector",
      });
      continue;
    }

    // Skip if already proposed (pending or approved)
    try {
      if (crystallizationStore.hasPendingOrApprovedForPattern(patternId)) {
        continue;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "check-existing-proposal",
        subsystem: "pattern-detector",
      });
      continue;
    }

    // Skip if an installed skill already covers this evidence milestone (re-propose only on metric/goals change).
    try {
      if (
        crystallizationStore.hasInstalledWithSameEvidence(patternId, evidenceHash, {
          legacyEvidenceHash,
          evidenceCountBucketSize: cfg.evidenceCountBucketSize,
        })
      ) {
        continue;
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "check-installed-evidence",
        subsystem: "pattern-detector",
      });
      continue;
    }

    candidates.push({
      patternId,
      evidenceHash,
      pattern,
      score: scorePattern(pattern),
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}
