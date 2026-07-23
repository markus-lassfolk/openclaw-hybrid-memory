/**
 * Types and helpers for dream candidate entries (#2170).
 *
 * Store revision hashing lives in `utils/fact-occ.ts` (shared with #2175 OCC).
 * Prefer `factsDb.computeStoreRevision()` at dream-run boundaries.
 */

import { createHash } from "node:crypto";
import type { StoreFactInput } from "../backends/facts-db/crud.js";
import { computeInputStoreRevision, occTokenForFact } from "../utils/fact-occ.js";

export type DreamRunStatus =
  | "pending"
  | "running"
  | "gated"
  | "promoted"
  | "quarantined"
  | "rolled_back"
  | "failed";

export const DREAM_RUN_STATUSES: readonly DreamRunStatus[] = [
  "pending",
  "running",
  "gated",
  "promoted",
  "quarantined",
  "rolled_back",
  "failed",
] as const;

export type CandidateOpKind = "add" | "supersede" | "delete" | "merge" | "boost";

export type CandidateEntryStatus =
  | "proposed"
  | "gated_ok"
  | "gated_block"
  | "applied"
  | "rolled_back"
  | "skipped";

export type ReverseOpKind = "delete_fact" | "unsupersede" | "restore_text" | "noop";

export type CandidatePrevalence = {
  sessions: number;
  agents: number;
  spanDays?: number;
};

export type CandidateEvidence = {
  sessionIds: string[];
  prevalence: CandidatePrevalence;
  rationale: string;
};

/** Forward payload for add/supersede/merge/boost. Optional id used when caller wants a stable applied id. */
export type CandidatePayload = StoreFactInput & {
  id?: string;
  /** Test/stub: mark that applying this entry would worsen contradictions (#2170 gate stub). */
  contradictionWorsens?: boolean;
};

export type ReversePlan = {
  op: ReverseOpKind;
  payload: Record<string, unknown>;
};

export type CandidateEntryInput = {
  op: CandidateOpKind;
  payload: CandidatePayload;
  targetFactId?: string | null;
  evidence: CandidateEvidence;
  preHash?: string | null;
  reverse: ReversePlan;
  sortOrder?: number;
};

export type DreamRunRecord = {
  id: string;
  status: DreamRunStatus;
  inputStoreRevision: string;
  sessionIds: string[];
  steeringPolicyId: string | null;
  gateReportJson: string | null;
  shadow: boolean;
  createdAt: number;
  startedAt: number | null;
  gatedAt: number | null;
  promotedAt: number | null;
  rolledBackAt: number | null;
  failedAt: number | null;
  failureReason: string | null;
  rollbackReason: string | null;
  metricsBaselineJson: string | null;
  metricsObserveUntil: number | null;
  /** Per-run ROI / cost summary (#2179). */
  metricsSummaryJson: string | null;
};

export type CandidateEntryRecord = {
  id: string;
  dreamRunId: string;
  op: CandidateOpKind;
  status: CandidateEntryStatus;
  payload: CandidatePayload;
  targetFactId: string | null;
  sessionIds: string[];
  prevalence: CandidatePrevalence | null;
  rationale: string | null;
  preHash: string | null;
  postHash: string | null;
  reverse: ReversePlan;
  appliedFactId: string | null;
  sortOrder: number;
  createdAt: number;
};

export type GateDecision = {
  entryId: string;
  pass: boolean;
  reason: string;
};

export type GateReport = {
  ok: boolean;
  decisions: GateDecision[];
  wouldPromote: boolean;
  reason?: string;
};

export type PromoteResult = {
  applied: boolean;
  shadow: boolean;
  status: DreamRunStatus;
  gateReport: GateReport;
  appliedFactIds: string[];
  error?: string;
};

export type RollbackResult = {
  rolledBack: boolean;
  status: DreamRunStatus;
  restoredFactIds: string[];
  abortedEntries: Array<{ entryId: string; reason: string }>;
  error?: string;
};

export { computeInputStoreRevision, occTokenForFact };

/** SHA-256 of canonical fact content fields (promote/rollback drift checks). */
export function hashFactContent(entry: {
  text: string;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  scope?: string | null;
  scopeTarget?: string | null;
  importance?: number | null;
}): string {
  const canonical = JSON.stringify({
    text: entry.text,
    entity: entry.entity ?? null,
    key: entry.key ?? null,
    value: entry.value ?? null,
    scope: entry.scope ?? "global",
    scopeTarget: entry.scopeTarget ?? null,
    importance: entry.importance ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function makeDreamRunId(now = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `dream-${iso}-${process.pid}`;
}
