import { createHash, randomUUID } from "node:crypto";
import { redactAutopilotValue } from "./redaction.js";
import type { PendingAutopilotRunSummary, PendingDecision, PendingQueue } from "./types.js";
import { AUTOPILOT_ACTIONS, type AUTOPILOT_MODES, PENDING_QUEUES, assertKnownEnum } from "./types.js";

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
  if (decision.capabilityClass) assertKnownEnum("capabilityClass", decision.capabilityClass);
  return {
    ...decision,
    summary: decision.summary ? (redactAutopilotValue(decision.summary) as PendingDecision["summary"]) : undefined,
    audit: decision.audit ? (redactAutopilotValue(decision.audit) as PendingDecision["audit"]) : undefined,
  };
}

export function createStableRunSummary(input: {
  runId: string;
  mode: (typeof AUTOPILOT_MODES)[number];
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
    const ak = `${a.queue}:${a.itemId}:${a.inputHash}:${a.policyVersion}`;
    const bk = `${b.queue}:${b.itemId}:${b.inputHash}:${b.policyVersion}`;
    return ak.localeCompare(bk);
  });
  for (const decision of decisions) totals[decision.action] += 1;
  return {
    runId: input.runId,
    mode: input.mode,
    policyVersion: input.policyVersion,
    queues: [...input.queues].sort((a, b) => PENDING_QUEUES.indexOf(a) - PENDING_QUEUES.indexOf(b)),
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    totals,
    decisions: decisions.map((d) => ({
      queue: d.queue,
      itemId: d.itemId,
      inputHash: d.inputHash,
      policyVersion: d.policyVersion,
      action: d.action,
      reasonCode: d.reasonCode,
    })),
  };
}

export function stableRunSummaryJson(summary: PendingAutopilotRunSummary): string {
  return `${canonicalJson(summary)}\n`;
}

export function shouldAdvancePendingCursor(decision: PendingDecision): boolean {
  return !["deferred-for-human", "failed-validation"].includes(decision.action);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortJson(v)]),
    );
  }
  return value;
}
