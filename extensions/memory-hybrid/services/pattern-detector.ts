/**
 * Pattern Detector — identify crystallization candidates from WorkflowStore (Issue #208).
 *
 * Analyses workflow patterns from WorkflowStore.getPatterns() and scores them
 * by usage count × success rate to identify strong candidates.
 * Deduplication: skips patterns that already have a pending/approved proposal.
 */

import { createHash } from "node:crypto";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern, WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { capturePluginError } from "./error-reporter.js";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable string id for a WorkflowPattern based on its tool sequence.
 * Uses SHA-256 truncated to 16 hex chars.
 */
export function computePatternId(toolSequence: string[]): string {
  return createHash("sha256").update(JSON.stringify(toolSequence)).digest("hex").slice(0, 16);
}

/**
 * Compute a stable hash of "evidence" used to generate proposal content, intentionally
 * excluding metric counters so we don't regenerate immediately from unchanged substance.
 */
export function computeEvidenceHash(pattern: WorkflowPattern): string {
  const payload = {
    toolSequence: pattern.toolSequence,
    exampleGoals: pattern.exampleGoals
      .map((g) => g.trim().replace(/\s+/g, " "))
      .filter((g) => g.length > 0)
      .slice(0, 5),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Score a pattern for crystallization priority.
 * Formula: usageCount × successRate
 * Both components are bounded and well-defined.
 */
export function scorePattern(pattern: WorkflowPattern): number {
  return pattern.totalCount * pattern.successRate;
}

// ---------------------------------------------------------------------------
// PatternDetector — exported as a free function (no class wrapper needed)
// ---------------------------------------------------------------------------

/**
 * Detect crystallization candidates from recent workflow patterns.
 * Applies min usage count and success rate thresholds, skips already-proposed patterns.
 * Returns candidates sorted by score descending.
 */
export function detectCandidates(
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

// ---------------------------------------------------------------------------
// Deprecated class wrapper for backward compatibility
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `detectCandidates` function directly instead.
 * This class wrapper is retained for backward compatibility only.
 */
export class PatternDetector {
  constructor(
    private workflowStore: WorkflowStore,
    private crystallizationStore: CrystallizationStore,
    private cfg: CrystallizationConfig,
  ) {}

  detect(): CrystallizationCandidate[] {
    return detectCandidates(this.workflowStore, this.crystallizationStore, this.cfg);
  }
}
