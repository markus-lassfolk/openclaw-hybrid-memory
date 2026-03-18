/**
 * OCTAVE-style Structured Handoff Types (Issue #615)
 *
 * Defines typed fields for subagent → main-agent handoff artifacts.
 * Replaces unstructured prose summaries with canonical, schema-validated blocks.
 *
 * Inspired by the OCTAVE MCP format (https://github.com/elevanaltd/octave-mcp),
 * implemented as a zero-dependency TypeScript schema for Phase 1.
 */

/** Terminal status of a subagent task at handoff time. */
export type HandoffStatus = "completed" | "failed" | "partial" | "escalate";

/** Type of artifact produced by a subagent task. */
export type HandoffArtifactType = "commit" | "pr" | "file" | "branch" | "test-result" | "report" | "issue" | "other";

/** A concrete artifact (commit, PR, file, etc.) produced during a task. */
export interface HandoffArtifact {
  type: HandoffArtifactType;
  /** Reference identifier — commit SHA, PR number, file path, etc. */
  ref: string;
  /** Optional branch name (for commit / file artifacts). */
  branch?: string;
  /** Human-readable description of the artifact. */
  description?: string;
}

/**
 * Structured handoff block emitted by a subagent upon task completion.
 *
 * Canonical YAML representation:
 * ```yaml
 * handoff:
 *   task_id: forge-pr583-fix
 *   goal: "Fix ambientBudgetTokens cap in stage-injection.ts"
 *   status: completed
 *   completed:
 *     - "Changed Math.max(100, …) → Math.max(0, …) in stage-injection.ts:165"
 *   pending: []
 *   risks: []
 *   artifacts:
 *     - type: commit
 *       ref: e529d11
 *       branch: feat/581-architecture-refactor-hybrid-memory-core
 *   verification:
 *     - "npm test: 3610 tests passed"
 *     - "tsc --noEmit: clean"
 *   rollback: "git revert e529d11"
 * ```
 */
export interface HandoffBlock {
  /** Unique identifier for the task (e.g. "forge-pr583-fix"). */
  task_id: string;
  /** One-sentence description of the task goal. */
  goal: string;
  /** Terminal status of the task. */
  status: HandoffStatus;
  /** Steps or actions completed during the task. */
  completed: string[];
  /** Work items that remain open (empty = none). */
  pending: string[];
  /** Known risks or concerns to surface to the main agent. */
  risks: string[];
  /** Concrete artifacts produced (commits, PRs, files, etc.). */
  artifacts: HandoffArtifact[];
  /** Verification steps run and their outcomes. */
  verification: string[];
  /** Rollback instructions if the changes need to be reverted. */
  rollback?: string;
  /** ISO-8601 timestamp when the handoff was generated. */
  generated_at?: string;
}

/** Input shape for creating a new handoff — generated_at is auto-populated. */
export type CreateHandoffInput = Omit<HandoffBlock, "generated_at">;

/** Wrapper envelope emitted in agent output (preserves forward compat). */
export interface HandoffEnvelope {
  handoff: HandoffBlock;
}
