/** Loom brief — pre-action synthesis command (Issue #2154). */

export type LoomBriefItemLabel = "memory" | "evidence" | "live_check_requirement" | "recommendation";

export interface LoomBriefBeliefItem {
  label: LoomBriefItemLabel;
  claimId: string;
  text: string;
  status: string;
  confidence: number;
}

export interface LoomBriefLiveCheck {
  label: LoomBriefItemLabel;
  claimId: string;
  text: string;
  suggestedChecks: string[];
}

export interface LoomBriefOpenLoop {
  label: LoomBriefItemLabel;
  loopId: string;
  title: string;
  status: string;
  closureCriteria: string | null;
}

export interface LoomBriefDriftWarning {
  label: LoomBriefItemLabel;
  driftId: string;
  text: string;
  severity: string;
}

export interface LoomBriefEvidence {
  label: LoomBriefItemLabel;
  capsuleId: string;
  title: string;
  createdAt: string;
}

export interface LoomBriefProcedure {
  label: LoomBriefItemLabel;
  clusterId: string;
  text: string;
}

export interface LoomBriefOptions {
  scope: string;
  task?: string;
  maxChars?: number;
}

export interface LoomBrief {
  scope: string;
  generatedAt: string;
  scopeInterpretation: string;
  verifiedBeliefs: LoomBriefBeliefItem[];
  staleOrUnverifiedBeliefs: LoomBriefBeliefItem[];
  contradictions: LoomBriefBeliefItem[];
  mustLiveCheck: LoomBriefLiveCheck[];
  openLoops: LoomBriefOpenLoop[];
  recentEvidence: LoomBriefEvidence[];
  driftWarnings: LoomBriefDriftWarning[];
  recommendedProcedures: LoomBriefProcedure[];
  attentionPriorities: string[];
  nextActions: string[];
  truncated: boolean;
}
