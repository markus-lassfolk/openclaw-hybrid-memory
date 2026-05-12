import { createHash, randomUUID } from "node:crypto";
import { redactAutopilotValue } from "./redaction.js";
import type { AutopilotMode, PendingAutopilotRunSummary, PendingDecision, PendingQueue } from "./types.js";
import { AUTOPILOT_ACTIONS, PENDING_QUEUES, assertKnownEnum } from "./types.js";

export const PENDING_AUTOPILOT_SCHEMA_VERSION = 1;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function computePendingInputHash(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(redactAutopilotValue(input)))
    .digest("hex");
}

export function createPendingAutopilotRunId(): string {
  return randomUUID();
}

export function sanitizePendingDecision(decision: PendingDecision): PendingDecision {
  assertKnownEnum("queue", decision.queue);
  assertKnownEnum("mode", decision.mode);
  assertKnownEnum("action", decision.action);
  assertKnownEnum("reasonCode", decision.reasonCode);
  assertKnownEnum("actionClass", decision.actionClass);
  assertKnownEnum("capabilityClass", decision.capabilityClass);
  return {
    ...decision,
    summary: decision.summary ? (redactAutopilotValue(decision.summary) as PendingDecision["summary"]) : undefined,
    audit: decision.audit ? (redactAutopilotValue(decision.audit) as PendingDecision["audit"]) : undefined,
    evidence: redactAutopilotValue(decision.evidence) as PendingDecision["evidence"],
    actor: redactAutopilotValue(decision.actor) as PendingDecision["actor"],
  };
}

export function createStableRunSummary(input: {
  runId: string;
  mode: AutopilotMode;
  policy: string;
  policyVersion: string;
  queues: PendingQueue[];
  startedAt: number;
  finishedAt?: number;
  decisions: PendingDecision[];
}): PendingAutopilotRunSummary {
  const totals = Object.fromEntries(
    AUTOPILOT_ACTIONS.map((action) => [action, 0]),
  ) as PendingAutopilotRunSummary["totals"];
  const decisions = input.decisions.map(sanitizePendingDecision).sort((a, b) => {
    const ak = `${a.queue}:${a.itemId}:${a.inputHash}:${a.policy}:${a.policyVersion}`;
    const bk = `${b.queue}:${b.itemId}:${b.inputHash}:${b.policy}:${b.policyVersion}`;
    return compareCodePointOrder(ak, bk);
  });
  for (const decision of decisions) totals[decision.action] += 1;
  return {
    runId: input.runId,
    mode: input.mode,
    policy: input.policy,
    policyVersion: input.policyVersion,
    queues: [...input.queues].sort((a, b) => PENDING_QUEUES.indexOf(a) - PENDING_QUEUES.indexOf(b)),
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    totals,
    decisions: decisions.map((d) => ({
      queue: d.queue,
      itemId: d.itemId,
      inputHash: d.inputHash,
      policy: d.policy,
      policyVersion: d.policyVersion,
      action: d.action,
      reasonCode: d.reasonCode,
      capabilityClass: d.capabilityClass,
      confidence: d.confidence,
      humanReviewRequired: d.humanReviewRequired,
    })),
  };
}

export function stableRunSummaryJson(summary: PendingAutopilotRunSummary): string {
  return `${canonicalJson(summary)}\n`;
}

export function shouldAdvancePendingCursor(decision: PendingDecision): boolean {
  if (decision.humanReviewRequired) return false;
  return !["deferred-for-human", "failed-validation", "failed-audit", "unknown-decision"].includes(decision.action);
}

function compareCodePointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([k, v]) => [sortJson(k), sortJson(v)] as const)
      .sort(([a], [b]) => compareCodePointOrder(canonicalJson(a), canonicalJson(b)));
  }
  if (value instanceof Set) {
    return [...value.values()].map(sortJson).sort((a, b) => compareCodePointOrder(canonicalJson(a), canonicalJson(b)));
  }
  if (value && typeof value === "object") {
    const maybeToJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJson === "function" && Object.getPrototypeOf(value) !== Object.prototype) {
      return sortJson(maybeToJson.call(value));
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodePointOrder(a, b))
        .map(([k, v]) => [k, sortJson(v)]),
    );
  }
  return value;
}
