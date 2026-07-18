/** Open-loop obligations ledger (Issue #2152). */

export const LOOP_TYPES = [
  "promise_made",
  "blocked_task",
  "unresolved_incident",
  "needs_verification",
  "pending_decision",
  "operator_followup",
  "future_cleanup",
  "watch_condition",
] as const;
export type LoopType = (typeof LOOP_TYPES)[number];

export const LOOP_OWNERS = ["human", "agent", "system", "unknown"] as const;
export type LoopOwner = (typeof LOOP_OWNERS)[number];

export const LOOP_STATUSES = ["open", "waiting", "blocked", "ready", "closed", "superseded"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export interface CreateOpenLoopInput {
  title: string;
  description?: string;
  loopType: LoopType;
  scope?: string;
  entity?: string;
  repo?: string;
  owner?: LoopOwner;
  nextAction?: string;
  closureCriteria?: string;
  evidenceRequired?: boolean;
  linkedGoalIds?: string[];
  linkedTaskLabels?: string[];
  linkedClaimIds?: string[];
  linkedEvidenceCapsuleIds?: string[];
  resurfaceAt?: string;
  urgency?: number;
  importance?: number;
  operatorLoadRisk?: number;
}

export interface OpenLoop {
  id: string;
  title: string;
  description: string;
  loopType: LoopType;
  scope: string | null;
  entity: string | null;
  repo: string | null;
  owner: LoopOwner;
  status: LoopStatus;
  nextAction: string | null;
  closureCriteria: string | null;
  evidenceRequired: boolean;
  linkedGoalIds: string[];
  linkedTaskLabels: string[];
  linkedClaimIds: string[];
  linkedEvidenceCapsuleIds: string[];
  resurfaceAt: string | null;
  urgency: number;
  importance: number;
  operatorLoadRisk: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  closeEvidenceCapsuleId: string | null;
  supersededByLoopId: string | null;
  lastResurfacedAt: string | null;
}

export interface OpenLoopFilter {
  status?: LoopStatus[];
  loopType?: LoopType[];
  scope?: string;
  entity?: string;
  repo?: string;
  owner?: LoopOwner;
  limit?: number;
}

export interface CloseOpenLoopInput {
  reason?: string;
  evidenceCapsuleId?: string;
  status?: "closed" | "superseded";
  supersededByLoopId?: string;
}
