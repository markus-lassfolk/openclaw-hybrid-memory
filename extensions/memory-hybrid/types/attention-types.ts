/** Attention steward — ranking, demotion, and focus across Loom objects (Issue #2153). */

export const ATTENTION_TARGET_KINDS = [
  "claim",
  "open_loop",
  "drift_finding",
  "procedure",
  "serendipity_finding",
  "evidence_capsule",
] as const;
export type AttentionTargetKind = (typeof ATTENTION_TARGET_KINDS)[number];

export const ATTENTION_CATEGORIES = [
  "urgent",
  "important_not_urgent",
  "blocked",
  "needs_verification",
  "stale_or_noisy",
  "candidate_for_deletion",
  "candidate_for_skill_or_wrapper",
  "interesting_not_actionable",
] as const;
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];

export const ATTENTION_OVERRIDE_ACTIONS = ["snooze", "demote", "restore"] as const;
export type AttentionOverrideAction = (typeof ATTENTION_OVERRIDE_ACTIONS)[number];

export interface AttentionOverride {
  targetKind: AttentionTargetKind;
  targetId: string;
  action: AttentionOverrideAction;
  reason: string | null;
  snoozedUntil: string | null;
  createdAt: string;
}

export interface AttentionItem {
  targetKind: AttentionTargetKind;
  targetId: string;
  title: string;
  category: AttentionCategory;
  score: number;
  reasons: string[];
  scope: string | null;
  overridden: AttentionOverrideAction | null;
}

export interface AttentionRankOptions {
  scope?: string;
  entity?: string;
  targetKinds?: AttentionTargetKind[];
  limit?: number;
  includeSnoozed?: boolean;
}

export interface AttentionRankReport {
  generatedAt: string;
  items: AttentionItem[];
  totalConsidered: number;
}
