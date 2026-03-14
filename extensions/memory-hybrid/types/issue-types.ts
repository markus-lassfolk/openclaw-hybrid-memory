/**
 * Issue Lifecycle Tracking — Type Definitions (Issue #137)
 *
 * Structured problem→resolution memory with state machine transitions.
 */

export type IssueStatus = "open" | "diagnosed" | "fix-attempted" | "resolved" | "verified" | "wont-fix";

export type IssueSeverity = "low" | "medium" | "high" | "critical";

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  severity: IssueSeverity;
  symptoms: string[];
  rootCause?: string;
  fix?: string;
  rollback?: string;
  relatedFacts: string[];
  detectedAt: string;
  resolvedAt?: string;
  verifiedAt?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIssueInput {
  title: string;
  severity?: IssueSeverity;
  symptoms: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Valid state transitions for the issue lifecycle.
 * Maps each status to the set of statuses it may transition to.
 */
export const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ["diagnosed", "fix-attempted", "wont-fix"],
  diagnosed: ["fix-attempted", "wont-fix"],
  "fix-attempted": ["resolved", "open", "wont-fix"],
  resolved: ["verified", "open"],
  verified: [],
  "wont-fix": ["open"],
};
