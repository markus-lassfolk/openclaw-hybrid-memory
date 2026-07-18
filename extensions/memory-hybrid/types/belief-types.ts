/**
 * Belief graph / claim ledger (Issue #2151) and live-check contracts on claims
 * (Issue #2156). A claim is a justified, inspectable statement distinct from a
 * raw recalled fact — it carries confidence, staleness, evidence, and an
 * explicit live-check contract for mutable external state.
 */

export const CLAIM_STATUSES = [
  "believed",
  "verified",
  "stale",
  "contradicted",
  "superseded",
  "unverified",
  "must_live_check",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface SuggestedLiveCheck {
  kind: "command" | "api_call" | "manual" | "other";
  text: string;
  expected?: string;
}

export interface AssertClaimInput {
  entity: string;
  predicate: string;
  value: string;
  scope?: string;
  confidence?: number;
  why?: string;
  sourceFactIds?: string[];
  evidenceCapsuleIds?: string[];
  invalidationConditions?: string[];
  operationalImpact?: string;
  liveCheckRequired?: boolean;
  liveCheckReason?: string;
  suggestedChecks?: SuggestedLiveCheck[];
}

export interface Claim {
  id: string;
  entity: string;
  predicate: string;
  value: string;
  scope: string | null;
  status: ClaimStatus;
  confidence: number;
  why: string | null;
  createdAt: string;
  lastVerifiedAt: string | null;
  sourceFactIds: string[];
  evidenceCapsuleIds: string[];
  contradictsClaimIds: string[];
  supersedesClaimIds: string[];
  supersededByClaimId: string | null;
  invalidationConditions: string[];
  liveCheckRequired: boolean;
  liveCheckReason: string | null;
  suggestedChecks: SuggestedLiveCheck[];
  operationalImpact: string | null;
  updatedAt: string;
}

export interface ClaimFilter {
  entity?: string;
  predicate?: string;
  scope?: string;
  status?: ClaimStatus[];
  liveCheckRequired?: boolean;
  limit?: number;
}

/** A record of a live check being satisfied against a claim (#2156). */
export interface LiveCheckEvent {
  id: string;
  claimId: string;
  satisfiedAt: string;
  expiresAt: string | null;
  evidenceCapsuleId: string | null;
  note: string | null;
  satisfiedBy: string | null;
}

export interface SatisfyLiveCheckInput {
  claimId: string;
  evidenceCapsuleId?: string;
  note?: string;
  satisfiedBy?: string;
  ttlHours?: number;
}

/** Live-check status of a claim as of "now" — used by loom brief / goal completion gates. */
export type LiveCheckState = "not_required" | "required_unsatisfied" | "satisfied" | "expired";

export interface LiveCheckStatus {
  claimId: string;
  state: LiveCheckState;
  reason: string | null;
  suggestedChecks: SuggestedLiveCheck[];
  lastSatisfiedAt: string | null;
  expiresAt: string | null;
}
