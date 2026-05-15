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
import { computeEvidenceHash, computePatternId, scorePattern } from "./pattern-detector-hash.js";

export { computeEvidenceHash, computePatternId, scorePattern } from "./pattern-detector-hash.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface CrystallizationCandidate {
  /** Stable hash of the tool sequence used as a pattern identifier */
  patternId: string;
  /** Stable hash of non-metric evidence (used to suppress immediate regen after rejection). */
  evidenceHash: string;
  pattern: WorkflowPattern;
  /** Composite score: usageCount × successRate (higher = better candidate) */
  score: number;
}

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
      // Fetch more than needed to allow filtering by usage count
      limit: 200,
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

    const patternId = computePatternId(pattern.toolSequence);
    const evidenceHash = computeEvidenceHash(pattern);

    // Skip if latest rejected proposal was based on the same unchanged evidence.
    // Prevents "spammy" re-proposals after a human rejection unless substantive
    // inputs (tool sequence / example goals) changed.
    try {
      if (crystallizationStore.isRejectedWithSameEvidence(patternId, evidenceHash)) {
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
