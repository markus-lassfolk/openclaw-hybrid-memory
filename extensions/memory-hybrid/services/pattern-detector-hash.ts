/**
 * Pure hash/scoring helpers for workflow pattern crystallization (Issue #1430).
 */

import { createHash } from "node:crypto";
import type { WorkflowPattern } from "../backends/workflow-store.js";

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
 */
export function scorePattern(pattern: WorkflowPattern): number {
  return pattern.totalCount * pattern.successRate;
}
