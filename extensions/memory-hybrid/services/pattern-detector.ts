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
 * Score a pattern for crystallization priority.
 * Formula: usageCount × successRate
 * Both components are bounded and well-defined.
 */
export function scorePattern(pattern: WorkflowPattern): number {
  return pattern.totalCount * pattern.successRate;
}

// ---------------------------------------------------------------------------
// PatternDetector
// ---------------------------------------------------------------------------

export class PatternDetector {
  constructor(
    private readonly workflowStore: WorkflowStore,
    private readonly crystallizationStore: CrystallizationStore,
    private readonly cfg: CrystallizationConfig,
  ) {}

  /**
   * Detect crystallization candidates from recent workflow patterns.
   * Applies min usage count and success rate thresholds, skips already-proposed patterns.
   * Returns candidates sorted by score descending.
   */
  detect(): CrystallizationCandidate[] {
    if (!this.cfg.enabled) return [];

    let patterns: WorkflowPattern[];
    try {
      patterns = this.workflowStore.getPatterns({
        minSuccessRate: this.cfg.minSuccessRate,
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
      if (pattern.totalCount < this.cfg.minUsageCount) continue;

      // Must meet minimum success rate
      if (pattern.successRate < this.cfg.minSuccessRate) continue;

      // Must have at least one tool in sequence
      if (pattern.toolSequence.length === 0) continue;

      const patternId = computePatternId(pattern.toolSequence);

      // Skip if already proposed (pending or approved)
      try {
        if (this.crystallizationStore.hasPendingOrApprovedForPattern(patternId)) {
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
        pattern,
        score: scorePattern(pattern),
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates;
  }
}
