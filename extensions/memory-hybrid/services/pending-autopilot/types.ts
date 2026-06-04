/**
 * Shared Pending Autopilot control-plane contracts (#1334).
 *
 * This foundation is intentionally queue-policy agnostic. Child issues #1326-#1330
 * plug concrete queue adapters for persona, procedures, verified facts, tool
 * proposals, and crystallization on top of these contracts without changing the
 * durable state or audit invariants defined here.
 */

export const PENDING_QUEUES = ["persona", "procedures", "verified", "tools", "crystallization"] as const;
export type PendingQueue = (typeof PENDING_QUEUES)[number];

export const AUTOPILOT_MODES = ["dry-run", "apply"] as const;
export type AutopilotMode = (typeof AUTOPILOT_MODES)[number];

export const AUTOPILOT_ACTIONS = [
  "reported",
  "classified",
  "applied",
  "rejected",
  "promoted-to-draft",
  "deferred-for-human",
  "failed-validation",
  "failed-audit",
  "unknown-decision",
  "skipped-by-policy",
] as const;
export type AutopilotAction = (typeof AUTOPILOT_ACTIONS)[number];

export const AUTOPILOT_REASON_CODES = [
  "already-processed",
  "approved",
  "audit-write-failed",
  "capability-not-allowed",
  "dry-run",
  "duplicate-input",
  "human-review-required",
  "input-hash-mismatch",
  "invalid-item",
  "lock-conflict",
  "lock-expired",
  "lock-missing",
  "lock-owner-mismatch",
  "policy-denied",
  "policy-report-only",
  "policy-requires-human",
  "policy-threshold-not-met",
  "duplicate-applied-proposal",
  "duplicate-pending-proposal",
  "already-in-file",
  "stale-target-context",
  "low-confidence",
  "non-actionable",
  "secret-or-private-data-risk",
  "identity-boundary-change",
  "privacy-boundary-change",
  "security-boundary-change",
  "user-preference-change-requires-approval",
  "missing-evidence",
  "validation-failed",
  "safe-low-risk-localized-change",
  "schema-validation-failed",
  "unknown-decision",
  "unknown-queue",
] as const;
export type AutopilotReasonCode = (typeof AUTOPILOT_REASON_CODES)[number];

/**
 * Ordered from least to most authority. `apply` is only intent; queue adapters
 * must map every planned action to one of these explicit approval boundaries.
 */
export const AUTOPILOT_CAPABILITY_CLASSES = [
  "read-only",
  "dry-run",
  "record-review-metadata",
  "safe-state-transition",
  "write-draft-artifact",
  "apply-low-risk-change",
  "enable-behaviour",
  "trust-changing-action",
  "external-side-effect",
  "destructive-action",
] as const;
export type AutopilotCapabilityClass = (typeof AUTOPILOT_CAPABILITY_CLASSES)[number];

export const AUTOPILOT_ACTION_CLASSES = [
  "observe",
  "preview",
  "record-review",
  "state-transition",
  "draft-artifact",
  "low-risk-apply",
  "enable-behaviour",
  "trust-change",
  "external-side-effect",
  "destructive",
] as const;
export type AutopilotActionClass = (typeof AUTOPILOT_ACTION_CLASSES)[number];

const enumSets = {
  queue: PENDING_QUEUES,
  mode: AUTOPILOT_MODES,
  action: AUTOPILOT_ACTIONS,
  reasonCode: AUTOPILOT_REASON_CODES,
  capabilityClass: AUTOPILOT_CAPABILITY_CLASSES,
  actionClass: AUTOPILOT_ACTION_CLASSES,
} as const;

type EnumName = keyof typeof enumSets;

export function isPendingQueue(value: unknown): value is PendingQueue {
  return includes(PENDING_QUEUES, value);
}

export function isAutopilotMode(value: unknown): value is AutopilotMode {
  return includes(AUTOPILOT_MODES, value);
}

export function isAutopilotAction(value: unknown): value is AutopilotAction {
  return includes(AUTOPILOT_ACTIONS, value);
}

export function isAutopilotReasonCode(value: unknown): value is AutopilotReasonCode {
  return includes(AUTOPILOT_REASON_CODES, value);
}

export function isAutopilotCapabilityClass(value: unknown): value is AutopilotCapabilityClass {
  return includes(AUTOPILOT_CAPABILITY_CLASSES, value);
}

export function isAutopilotActionClass(value: unknown): value is AutopilotActionClass {
  return includes(AUTOPILOT_ACTION_CLASSES, value);
}

export function assertKnownEnum<T extends EnumName>(name: T, value: unknown): (typeof enumSets)[T][number] {
  const values = enumSets[name];
  if (!includes(values, value)) {
    throw new Error(`Unknown pending-autopilot ${name}: ${String(value)}`);
  }
  return value;
}

function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export interface RedactedAutopilotText {
  redacted: string;
  redactionCount: number;
}

export interface PendingItem<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  queue: PendingQueue;
  id: string;
  /** Stable content/policy input hash. Queue adapters must not include raw secrets in hash sources. */
  inputHash: string;
  policyVersion: string;
  capabilityClasses: AutopilotCapabilityClass[];
  payload: TPayload;
  visibleAfterCursor?: string | null;
  requiresHumanReview?: boolean;
  validationFailed?: boolean;
}

export interface PendingDecisionEvidence {
  type: string;
  id?: string;
  summary?: string;
}

export interface PendingDecisionActorContext {
  type: "system" | "agent" | "human" | "cron" | "test";
  id: string;
}

export interface PendingDecision {
  queue: PendingQueue;
  itemId: string;
  inputHash: string;
  /** Stable policy identifier/name; policyVersion identifies the exact revision. */
  policy: string;
  policyVersion: string;
  mode: AutopilotMode;
  action: AutopilotAction;
  reasonCode: AutopilotReasonCode;
  actionClass: AutopilotActionClass;
  capabilityClass: AutopilotCapabilityClass;
  confidence: number;
  humanReviewRequired: boolean;
  evidence: PendingDecisionEvidence[];
  actor: PendingDecisionActorContext;
  runId: string;
  jobId?: string;
  summary?: RedactedAutopilotSummary;
  audit?: RedactedAutopilotAudit;
  createdAt?: number;
}

export interface PendingQueueAdapter<TItem extends PendingItem = PendingItem> {
  queue: PendingQueue;
  listPending(cursor?: PendingAutopilotCursor | null): Promise<TItem[]> | TItem[];
  decide(item: TItem, context: PendingDecisionContext): Promise<PendingDecision> | PendingDecision;
  apply?(decision: PendingDecision, item: TItem): Promise<void> | void;
}

export interface PendingDecisionContext {
  runId: string;
  jobId?: string;
  mode: AutopilotMode;
  policy: string;
  policyVersion: string;
  inputHash: string;
  actor: PendingDecisionActorContext;
}

export interface PendingAutopilotRunSummary {
  runId: string;
  mode: AutopilotMode;
  policy: string;
  policyVersion: string;
  queues: PendingQueue[];
  startedAt: number;
  finishedAt?: number;
  totals: Record<AutopilotAction, number>;
  decisions: Array<
    Pick<
      PendingDecision,
      | "queue"
      | "itemId"
      | "inputHash"
      | "policy"
      | "policyVersion"
      | "action"
      | "reasonCode"
      | "capabilityClass"
      | "confidence"
      | "humanReviewRequired"
    >
  >;
}

export interface RedactedAutopilotSummary {
  title?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface RedactedAutopilotAudit {
  queue: PendingQueue;
  itemId: string;
  inputHash: string;
  policy: string;
  policyVersion: string;
  action: AutopilotAction;
  reasonCode: AutopilotReasonCode;
  capabilityClass: AutopilotCapabilityClass;
  humanReviewRequired: boolean;
  evidence: PendingDecisionEvidence[];
  actor: PendingDecisionActorContext;
  runId: string;
  jobId?: string;
  summary?: RedactedAutopilotSummary;
}

export interface PendingAutopilotCursor {
  queue: PendingQueue;
  policy: string;
  cursor: string;
  inputHash: string;
  policyVersion: string;
  updatedAt: number;
}

export interface PendingAutopilotLock {
  queue: PendingQueue;
  itemId: string;
  inputHash: string;
  owner: string;
  expiresAt: number;
  createdAt: number;
}
