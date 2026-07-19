/** Evidence capsules — durable proof objects for verified work reports (Issue #2148). */

export type EvidenceRedactionStatus = "clean" | "redacted";

/** One piece of evidence within a capsule: a command run, a tool output, a live read-back, etc. */
export interface EvidenceItem {
  kind: "command" | "tool_output" | "live_readback" | "observation" | "artifact_ref" | "other";
  text: string;
}

export interface EvidenceArtifact {
  path: string;
  description?: string;
}

export interface CreateEvidenceCapsuleInput {
  title: string;
  /** The claim/statement this capsule supports. */
  claim: string;
  actor?: string;
  sessionId?: string;
  evidence?: EvidenceItem[];
  commandsRun?: string[];
  artifacts?: EvidenceArtifact[];
  unverifiedItems?: string[];
  riskFlags?: string[];
  /** Free text describing what was NOT checked / scope limits. */
  limits?: string;
  linkedClaimIds?: string[];
  linkedTaskLabel?: string;
  linkedGoalId?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceCapsule {
  id: string;
  title: string;
  claim: string;
  actor: string | null;
  sessionId: string | null;
  evidence: EvidenceItem[];
  commandsRun: string[];
  artifacts: EvidenceArtifact[];
  unverifiedItems: string[];
  riskFlags: string[];
  limits: string | null;
  redactionStatus: EvidenceRedactionStatus;
  redactionCount: number;
  verifiedAt: string | null;
  linkedClaimIds: string[];
  linkedTaskLabel: string | null;
  linkedGoalId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceCapsuleFilter {
  linkedClaimId?: string;
  linkedTaskLabel?: string;
  linkedGoalId?: string;
  since?: string;
  limit?: number;
}
