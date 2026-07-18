/**
 * Memory lifecycle workflows — forgetting, demotion, and archival (Issue #2155).
 * Distinct from the existing `lifecycle.*` config (GitHub sync adapters).
 */

export const LIFECYCLE_TARGET_KINDS = ["fact", "claim", "open_loop", "drift_finding"] as const;
export type LifecycleTargetKind = (typeof LIFECYCLE_TARGET_KINDS)[number];

export const LIFECYCLE_ACTIONS = ["demote", "archive", "delete", "quarantine"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export const LIFECYCLE_CANDIDATE_REASONS = [
  "contradicted",
  "superseded",
  "stale_low_access",
  "duplicate",
  "stale_endpoint_replaced",
  "historical_only",
  "failed_verification",
  "prompt_injection_like",
] as const;
export type LifecycleCandidateReason = (typeof LIFECYCLE_CANDIDATE_REASONS)[number];

export interface LifecycleCandidate {
  targetKind: LifecycleTargetKind;
  targetId: string;
  label: string;
  reasons: LifecycleCandidateReason[];
  explanation: string;
  suggestedAction: LifecycleAction;
  isVerifiedOrCritical: boolean;
}

export interface LifecycleCandidatesOptions {
  targetKinds?: LifecycleTargetKind[];
  limit?: number;
}

export interface LifecycleCandidatesReport {
  generatedAt: string;
  candidates: LifecycleCandidate[];
  totalConsidered: number;
}

export interface LifecycleUpdateInput {
  targetKind: LifecycleTargetKind;
  targetId: string;
  action: LifecycleAction;
  reason: string;
  confirm?: boolean;
  strongConfirm?: string;
  confirmedBy?: string;
}

export interface LifecycleAuditEntry {
  id: string;
  targetKind: LifecycleTargetKind;
  targetId: string;
  action: LifecycleAction;
  reason: string;
  confirmedBy: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}
