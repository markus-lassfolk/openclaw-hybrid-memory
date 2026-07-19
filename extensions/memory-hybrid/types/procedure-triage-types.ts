/** Procedure refinery — ranked triage batches over the procedure backlog (Issue #2147). */

export const PROCEDURE_TRIAGE_RECOMMENDED_ACTIONS = [
  "promote_to_skill",
  "promote_to_wrapper",
  "file_issue",
  "no_action",
] as const;
export type ProcedureTriageRecommendedAction = (typeof PROCEDURE_TRIAGE_RECOMMENDED_ACTIONS)[number];

export interface ProcedureTriageBatchItem {
  clusterId: string;
  representativeProcedureId: string;
  taskPattern: string;
  count: number;
  successCount: number;
  confidence: number;
  risk: "low" | "medium" | "high";
  why: string;
  recommendedAction: ProcedureTriageRecommendedAction;
  existingWrapper: string | null;
  relatedProcedureIds: string[];
}

export interface ProcedureTriageOptions {
  batchSize?: number;
  cluster?: boolean;
}

export interface ProcedureTriageBatchReport {
  backlog: number;
  recommendedBatch: ProcedureTriageBatchItem[];
}

export interface ProcedureTriageDecisionInput {
  clusterId: string;
  decision: ProcedureTriageRecommendedAction;
  rationale?: string;
  decidedBy?: string;
}

export interface ProcedureTriageDecision {
  clusterId: string;
  decision: ProcedureTriageRecommendedAction;
  rationale: string | null;
  decidedAt: string;
  decidedBy: string | null;
}
