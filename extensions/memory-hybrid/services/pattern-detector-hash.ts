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

export interface ComputeEvidenceHashOptions {
  /** Bucket width for totalCount (default 5). Must be >= 1. */
  evidenceCountBucketSize?: number;
}

function normalizeEvidenceGoals(pattern: WorkflowPattern): string[] {
  return pattern.exampleGoals
    .map((g) => g.trim().replace(/\s+/g, " "))
    .filter((g) => g.length > 0)
    .slice(0, 5);
}

/**
 * Compute the pre-milestone evidence hash used by older stored rejected/quarantined proposals.
 * Keep this for compatibility so existing human rejections remain suppressed until evidence changes.
 */
export function computeLegacyEvidenceHash(pattern: WorkflowPattern): string {
  const payload = {
    toolSequence: pattern.toolSequence,
    exampleGoals: normalizeEvidenceGoals(pattern),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Compute a stable hash of "evidence" used to generate proposal content.
 * Tool sequence and example goals are exact; usage metrics enter only as coarse buckets
 * so small drift does not churn the hash while milestone-scale changes do.
 */
export function computeEvidenceHash(pattern: WorkflowPattern, opts?: ComputeEvidenceHashOptions): string {
  const m = Math.max(1, Math.floor(opts?.evidenceCountBucketSize ?? 5));
  const totalCountBucket = Math.floor(pattern.totalCount / m) * m;
  const successRateBucket = Math.round(pattern.successRate * 10) / 10;
  const payload = {
    toolSequence: pattern.toolSequence,
    exampleGoals: normalizeEvidenceGoals(pattern),
    totalCountBucket,
    successRateBucket,
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
