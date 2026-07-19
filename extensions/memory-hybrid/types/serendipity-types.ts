/**
 * Serendipity Protocol — Type Definitions (Issue #2119)
 *
 * Structured, bounded proactive findings: an agent notices an adjacent
 * improvement while doing requested work, records it with evidence, triages it
 * against a configurable engagement level, and resolves it within guardrails.
 *
 * NOTE: this is unrelated to the recall-time `autoRecall.serendipity` slot
 * (see services/serendipity.ts) — that surfaces an interesting fact during
 * recall. This subsystem is a proactive-findings workflow.
 */

export type SerendipityFindingType =
  | "stale_assumption"
  | "repeated_friction"
  | "low_risk_cleanup"
  | "missing_validation"
  | "packaging_defect"
  | "documentation_mismatch"
  | "unsafe_default"
  | "duplicate_state"
  | "load_reduction_opportunity"
  | "other";

export type SerendipitySuggestedAction =
  | "fix_now"
  | "remember"
  | "file_issue"
  | "propose_skill"
  | "ask_user"
  | "ignore"
  | "create_goal"
  | "create_task";

export type SerendipityStatus = "observed" | "fixed" | "filed" | "remembered" | "proposed" | "dismissed" | "deferred";

export type SerendipityRiskLevel = "low" | "medium" | "high";
export type SerendipityReversibility = "easy" | "moderate" | "hard" | "irreversible";
export type SerendipityAdjacency = "direct" | "near" | "broad" | "unrelated";
export type SerendipityLoadReduction = "none" | "small" | "medium" | "large";

export const SERENDIPITY_FINDING_TYPES: readonly SerendipityFindingType[] = [
  "stale_assumption",
  "repeated_friction",
  "low_risk_cleanup",
  "missing_validation",
  "packaging_defect",
  "documentation_mismatch",
  "unsafe_default",
  "duplicate_state",
  "load_reduction_opportunity",
  "other",
] as const;

export const SERENDIPITY_SUGGESTED_ACTIONS: readonly SerendipitySuggestedAction[] = [
  "fix_now",
  "remember",
  "file_issue",
  "propose_skill",
  "ask_user",
  "ignore",
  "create_goal",
  "create_task",
] as const;

export const SERENDIPITY_STATUSES: readonly SerendipityStatus[] = [
  "observed",
  "fixed",
  "filed",
  "remembered",
  "proposed",
  "dismissed",
  "deferred",
] as const;

export const SERENDIPITY_RISK_LEVELS: readonly SerendipityRiskLevel[] = ["low", "medium", "high"] as const;
export const SERENDIPITY_REVERSIBILITIES: readonly SerendipityReversibility[] = [
  "easy",
  "moderate",
  "hard",
  "irreversible",
] as const;
export const SERENDIPITY_ADJACENCIES: readonly SerendipityAdjacency[] = [
  "direct",
  "near",
  "broad",
  "unrelated",
] as const;
export const SERENDIPITY_LOAD_REDUCTIONS: readonly SerendipityLoadReduction[] = [
  "none",
  "small",
  "medium",
  "large",
] as const;

export interface SerendipityFinding {
  id: string;
  title: string;
  description: string;
  findingType: SerendipityFindingType;
  suggestedAction: SerendipitySuggestedAction;
  status: SerendipityStatus;
  riskLevel: SerendipityRiskLevel;
  reversibility: SerendipityReversibility;
  adjacency: SerendipityAdjacency;
  estimatedHumanLoadReduction: SerendipityLoadReduction;
  confidence: number;
  sourceTask?: string;
  sourceSession?: string;
  repo?: string;
  entity?: string;
  evidence: string[];
  relatedFacts: string[];
  relatedIssues: string[];
  relatedProcedures: string[];
  relatedSkills: string[];
  /** The Loom alignment (#2149): links into the belief graph / open-loop ledger / drift scout. */
  relatedClaims: string[];
  relatedLoops: string[];
  relatedDriftFindings: string[];
  /** Loom scoring (#2149): 0-1 leverage/risk-reduction/time-saved/cognitive-load-reduction estimates. */
  leverage: number;
  riskReduction: number;
  timeSaved: number;
  cognitiveLoadReduction: number;
  /** True until the finding is promoted (status fixed/filed/proposed) — it is noticing, not a task. */
  notAnActiveTask: boolean;
  /** Guardrail signals — any of these forces `ask_user` regardless of level. */
  external: boolean;
  destructive: boolean;
  privacySensitive: boolean;
  actionTaken?: string;
  metadata: Record<string, unknown>;
  /** ISO 8601 TTL for the deferred backlog (null = never expires). */
  expiresAt?: string | null;
  /** ISO 8601 timestamp of last resurfacing (cooldown bookkeeping). */
  lastSurfacedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSerendipityFindingInput {
  title: string;
  description: string;
  findingType: SerendipityFindingType;
  suggestedAction?: SerendipitySuggestedAction;
  riskLevel?: SerendipityRiskLevel;
  reversibility?: SerendipityReversibility;
  adjacency?: SerendipityAdjacency;
  estimatedHumanLoadReduction?: SerendipityLoadReduction;
  confidence?: number;
  sourceTask?: string;
  sourceSession?: string;
  repo?: string;
  entity?: string;
  evidence?: string[];
  relatedFacts?: string[];
  relatedIssues?: string[];
  relatedProcedures?: string[];
  relatedSkills?: string[];
  relatedClaims?: string[];
  relatedLoops?: string[];
  relatedDriftFindings?: string[];
  leverage?: number;
  riskReduction?: number;
  timeSaved?: number;
  cognitiveLoadReduction?: number;
  external?: boolean;
  destructive?: boolean;
  privacySensitive?: boolean;
  metadata?: Record<string, unknown>;
  /** Override the store's default TTL (days). null = never expires; undefined = use default. */
  ttlDays?: number | null;
}

/** Kinds of related record a finding can link to (mirrors IssueStore.linkFact). */
export type SerendipityLinkKind = "fact" | "issue" | "procedure" | "skill" | "claim" | "loop" | "drift_finding";

/**
 * Valid state transitions for the finding lifecycle. `observed` and `deferred`
 * are the "backlog" states; everything else is an outcome (with limited re-open
 * paths so a mistakenly-closed finding can be resurrected).
 */
export const SERENDIPITY_TRANSITIONS: Record<SerendipityStatus, SerendipityStatus[]> = {
  observed: ["fixed", "filed", "remembered", "proposed", "dismissed", "deferred"],
  deferred: ["fixed", "filed", "remembered", "proposed", "dismissed", "observed"],
  fixed: [],
  filed: ["fixed", "dismissed", "observed"],
  remembered: ["observed", "dismissed"],
  proposed: ["fixed", "dismissed", "observed"],
  dismissed: ["observed"],
};

/** Statuses that still represent pending, revisit-able work. */
export const SERENDIPITY_BACKLOG_STATUSES: readonly SerendipityStatus[] = ["observed", "deferred"] as const;

/** Suggested actions that imply outstanding work worth resurfacing. */
export const SERENDIPITY_ACTIONABLE_ACTIONS: readonly SerendipitySuggestedAction[] = [
  "fix_now",
  "file_issue",
  "propose_skill",
  "create_task",
  "create_goal",
  "ask_user",
] as const;

// --- Scoped policy levels ---------------------------------------------------

export type SerendipityScope = "global" | "user" | "agent" | "session" | "repo" | "channel";

export const SERENDIPITY_SCOPES: readonly SerendipityScope[] = [
  "global",
  "user",
  "agent",
  "session",
  "repo",
  "channel",
] as const;

export interface SerendipityPref {
  scope: SerendipityScope;
  scopeTarget: string | null;
  level: number;
  enabled: boolean;
  updatedAt: string;
}

/** Inputs used to resolve the effective level for the current caller. */
export interface SerendipityScopeContext {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  repo?: string | null;
  channel?: string | null;
}

export interface ListFindingsFilter {
  status?: SerendipityStatus[];
  findingType?: SerendipityFindingType[];
  riskLevel?: SerendipityRiskLevel[];
  suggestedAction?: SerendipitySuggestedAction[];
  repo?: string;
  limit?: number;
}

export interface ListActionableDeferredOptions {
  /** Effective serendipity level for the caller (gates which items are eligible). */
  level: number;
  repo?: string;
  limit?: number;
}
