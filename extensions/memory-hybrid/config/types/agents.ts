/** Proposal statuses for persona evolution workflow */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Identity file types that can be proposed for modification */
export const IDENTITY_FILE_TYPES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;
export type IdentityFileType = (typeof IDENTITY_FILE_TYPES)[number];

/** Multi-agent memory scoping configuration (dynamic agent detection) */
export type MultiAgentConfig = {
  /** Agent ID of the orchestrator (main agent). Default: "main". This agent sees all scopes. */
  orchestratorId: string;
  /** Default storage scope for new facts. Options: "global" (backward compatible, default), "agent" (specialists auto-scope), "auto" (orchestrator→global, specialists→agent). */
  defaultStoreScope: "global" | "agent" | "auto";
  /** When true, throw error if agent detection fails in "agent" or "auto" scope mode (instead of silently falling back to orchestrator). Default: false. */
  strictAgentScoping?: boolean;
  /**
   * ⚠️ SECURITY: When true, tools can use caller-provided scope params (userId, agentId, sessionId) to access other users' memories.
   * This is UNSAFE in multi-tenant deployments but useful in single-user setups for advanced filtering.
   * Default: false (secure by default — tools only see memories from authenticated context).
   */
  trustToolScopeParams?: boolean;
};

/** Opt-in persona proposals: agent self-evolution with human approval gate */
export type PersonaProposalsConfig = {
  enabled: boolean;
  /** When true, approved proposals are applied automatically without human review (default: false). */
  autoApply: boolean;
  /** Identity files that can be modified via proposals (default: ["SOUL.md", "IDENTITY.md", "USER.md"]) */
  allowedFiles: IdentityFileType[];
  /** Max proposals per week to prevent spam (default: 5) */
  maxProposalsPerWeek: number;
  /** Min confidence score 0-1 for proposals (default: 0.7) */
  minConfidence: number;
  /** Days before proposals auto-expire if not reviewed (default: 30, 0 = never) */
  proposalTTLDays: number;
  /** Require minimum session evidence count (default: 10) */
  minSessionEvidence: number;
};
