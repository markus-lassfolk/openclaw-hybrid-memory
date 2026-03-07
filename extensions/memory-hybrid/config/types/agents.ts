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

/** Memory-to-skills: nightly synthesis of skill drafts from clustered procedures (issue #114). */
export type MemoryToSkillsConfig = {
  /** Enable memory-to-skills pipeline (default: false; set true to run clustering/synthesis). */
  enabled: boolean;
  /** Cron schedule for nightly run (default: "15 2 * * *" = 2:15 AM) */
  schedule: string;
  /** Procedures updated in last N days (default: 30) */
  windowDays: number;
  /** Minimum procedure instances per cluster (default: 3) */
  minInstances: number;
  /** Step consistency threshold 0–1 (default: 0.7) */
  consistencyThreshold: number;
  /** Output directory relative to workspace (default: "skills/auto-generated") */
  outputDir: string;
  /**
   * Whether cron message asks agent to notify on new drafts (default: true).
   * NOTE: Reserved for future use; currently not consumed by the plugin/CLI.
   * External tooling may read this flag, but changing it has no effect on pipeline behavior.
   */
  notify: boolean;
  /**
   * Control for auto-publishing synthesized skills (default: false).
   * NOTE: Reserved for future use; currently a no-op and does not affect promotion
   * or review behavior. Kept for configuration schema stability and documentation.
   */
  autoPublish: boolean;
  /** Optional: path to post-generation validation script (e.g. quick_validate.py). Not invoked by plugin; for user/documentation. */
  validateScript?: string;
  /** When false (default), skills-suggest only previews; use --apply to write. When true, writes by default (--dry-run to preview). */
  writeByDefault?: boolean;
};
