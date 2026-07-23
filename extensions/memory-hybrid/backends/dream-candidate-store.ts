/**
 * Dream candidate store — durable dream_runs + memory_candidate_entries (#2170).
 *
 * Option B: proposed-diff + reverse plan in the facts DB. Does not clone FactsDB.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CandidateEntryInput,
  type CandidateEntryRecord,
  type CandidateEntryStatus,
  type CandidateOpKind,
  type CandidatePayload,
  type CandidatePrevalence,
  type DreamRunRecord,
  type DreamRunStatus,
  type ReversePlan,
  DREAM_RUN_STATUSES,
  makeDreamRunId,
} from "../services/dream-candidate-ops.js";
import { pluginLogger } from "../utils/logger.js";

const ALLOWED_TRANSITIONS: Record<DreamRunStatus, readonly DreamRunStatus[]> = {
  pending: ["running", "failed"],
  running: ["gated", "failed", "quarantined"],
  gated: ["promoted", "quarantined", "failed"],
  promoted: ["rolled_back"],
  quarantined: [],
  rolled_back: [],
  failed: [],
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type DreamRunRow = {
  id: string;
  status: string;
  input_store_revision: string;
  session_ids_json: string;
  steering_policy_id: string | null;
  gate_report_json: string | null;
  shadow: number;
  created_at: number;
  started_at: number | null;
  gated_at: number | null;
  promoted_at: number | null;
  rolled_back_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
  rollback_reason: string | null;
  metrics_baseline_json: string | null;
  metrics_observe_until: number | null;
  metrics_summary_json: string | null;
};

type CandidateRow = {
  id: string;
  dream_run_id: string;
  op: string;
  status: string;
  payload_json: string;
  target_fact_id: string | null;
  session_ids_json: string;
  prevalence_json: string | null;
  rationale: string | null;
  pre_hash: string | null;
  post_hash: string | null;
  reverse_op: string;
  reverse_payload_json: string;
  applied_fact_id: string | null;
  sort_order: number;
  created_at: number;
};

function mapDreamRun(row: DreamRunRow): DreamRunRecord {
  return {
    id: row.id,
    status: row.status as DreamRunStatus,
    inputStoreRevision: row.input_store_revision,
    sessionIds: parseJsonArray(row.session_ids_json),
    steeringPolicyId: row.steering_policy_id,
    gateReportJson: row.gate_report_json,
    shadow: row.shadow === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    gatedAt: row.gated_at,
    promotedAt: row.promoted_at,
    rolledBackAt: row.rolled_back_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    rollbackReason: row.rollback_reason,
    metricsBaselineJson: row.metrics_baseline_json,
    metricsObserveUntil: row.metrics_observe_until,
    metricsSummaryJson: row.metrics_summary_json ?? null,
  };
}

function mapCandidate(row: CandidateRow): CandidateEntryRecord {
  return {
    id: row.id,
    dreamRunId: row.dream_run_id,
    op: row.op as CandidateOpKind,
    status: row.status as CandidateEntryStatus,
    payload: parseJsonObject<CandidatePayload>(row.payload_json, { text: "", category: "preference", importance: 0.5, source: "dream", entity: null, key: null, value: null }),
    targetFactId: row.target_fact_id,
    sessionIds: parseJsonArray(row.session_ids_json),
    prevalence: row.prevalence_json
      ? parseJsonObject<CandidatePrevalence | null>(row.prevalence_json, null)
      : null,
    rationale: row.rationale,
    preHash: row.pre_hash,
    postHash: row.post_hash,
    reverse: {
      op: row.reverse_op as ReversePlan["op"],
      payload: parseJsonObject<Record<string, unknown>>(row.reverse_payload_json, {}),
    },
    appliedFactId: row.applied_fact_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export class DreamCandidateStore {
  constructor(private readonly db: DatabaseSync) {}

  createDreamRun(input: {
    inputStoreRevision: string;
    sessionIds?: string[];
    steeringPolicyId?: string | null;
    shadow?: boolean;
    id?: string;
  }): DreamRunRecord {
    const id = input.id ?? makeDreamRunId();
    const createdAt = nowSec();
    const shadow = input.shadow !== false ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO dream_runs (
          id, status, input_store_revision, session_ids_json, steering_policy_id,
          shadow, created_at
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.inputStoreRevision,
        JSON.stringify(input.sessionIds ?? []),
        input.steeringPolicyId ?? null,
        shadow,
        createdAt,
      );
    const run = this.getDreamRun(id);
    if (!run) throw new Error(`dream-candidate-store: failed to create dream run ${id}`);
    return run;
  }

  /** Rebase OCC snapshot after intentional compose (or before promote). */
  setInputStoreRevision(id: string, inputStoreRevision: string): DreamRunRecord {
    const current = this.getDreamRun(id);
    if (!current) throw new Error(`dream-candidate-store: dream run not found: ${id}`);
    if (current.status !== "pending" && current.status !== "running" && current.status !== "gated") {
      throw new Error(
        `dream-candidate-store: cannot rebase revision in status ${current.status} for ${id}`,
      );
    }
    this.db
      .prepare("UPDATE dream_runs SET input_store_revision = ? WHERE id = ?")
      .run(inputStoreRevision, id);
    const updated = this.getDreamRun(id);
    if (!updated) throw new Error(`dream-candidate-store: dream run missing after rebase: ${id}`);
    return updated;
  }

  getDreamRun(id: string): DreamRunRecord | null {
    const row = this.db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id) as DreamRunRow | undefined;
    return row ? mapDreamRun(row) : null;
  }

  listDreamRuns(limit = 50): DreamRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM dream_runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.floor(limit))) as DreamRunRow[];
    return rows.map(mapDreamRun);
  }

  updateDreamRunStatus(
    id: string,
    status: DreamRunStatus,
    extra?: {
      failureReason?: string | null;
      rollbackReason?: string | null;
      gateReportJson?: string | null;
      metricsBaselineJson?: string | null;
      metricsObserveUntil?: number | null;
      metricsSummaryJson?: string | null;
    },
  ): DreamRunRecord {
    const current = this.getDreamRun(id);
    if (!current) throw new Error(`dream-candidate-store: dream run not found: ${id}`);
    if (current.status === status) {
      // Idempotent no-op for same status (allows re-writing gate report).
    } else {
      const allowed = ALLOWED_TRANSITIONS[current.status];
      if (!allowed.includes(status)) {
        throw new Error(
          `dream-candidate-store: illegal status transition ${current.status} → ${status} for ${id}`,
        );
      }
    }
    if (!DREAM_RUN_STATUSES.includes(status)) {
      throw new Error(`dream-candidate-store: invalid status ${status}`);
    }

    const ts = nowSec();
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (status === "running" && current.startedAt == null) {
      sets.push("started_at = ?");
      params.push(ts);
    }
    if (status === "gated") {
      sets.push("gated_at = ?");
      params.push(ts);
    }
    if (status === "promoted") {
      sets.push("promoted_at = ?");
      params.push(ts);
    }
    if (status === "rolled_back") {
      sets.push("rolled_back_at = ?");
      params.push(ts);
    }
    if (status === "failed" || status === "quarantined") {
      sets.push("failed_at = ?");
      params.push(ts);
    }
    if (extra?.failureReason !== undefined) {
      sets.push("failure_reason = ?");
      params.push(extra.failureReason);
    }
    if (extra?.rollbackReason !== undefined) {
      sets.push("rollback_reason = ?");
      params.push(extra.rollbackReason);
    }
    if (extra?.gateReportJson !== undefined) {
      sets.push("gate_report_json = ?");
      params.push(extra.gateReportJson);
    }
    if (extra?.metricsBaselineJson !== undefined) {
      sets.push("metrics_baseline_json = ?");
      params.push(extra.metricsBaselineJson);
    }
    if (extra?.metricsObserveUntil !== undefined) {
      sets.push("metrics_observe_until = ?");
      params.push(extra.metricsObserveUntil);
    }
    if (extra?.metricsSummaryJson !== undefined) {
      sets.push("metrics_summary_json = ?");
      params.push(extra.metricsSummaryJson);
    }

    params.push(id);
    this.db.prepare(`UPDATE dream_runs SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]));
    const updated = this.getDreamRun(id);
    if (!updated) throw new Error(`dream-candidate-store: dream run missing after update: ${id}`);
    return updated;
  }

  setDreamRunMetrics(
    id: string,
    extra: { metricsSummaryJson?: string | null },
  ): DreamRunRecord {
    const current = this.getDreamRun(id);
    if (!current) throw new Error(`dream-candidate-store: dream run not found: ${id}`);
    if (extra.metricsSummaryJson !== undefined) {
      this.db
        .prepare("UPDATE dream_runs SET metrics_summary_json = ? WHERE id = ?")
        .run(extra.metricsSummaryJson, id);
    }
    const updated = this.getDreamRun(id);
    if (!updated) throw new Error(`dream-candidate-store: dream run missing after metrics patch: ${id}`);
    return updated;
  }

  appendCandidateEntries(dreamRunId: string, entries: CandidateEntryInput[]): CandidateEntryRecord[] {
    const run = this.getDreamRun(dreamRunId);
    if (!run) throw new Error(`dream-candidate-store: dream run not found: ${dreamRunId}`);
    if (run.status !== "pending" && run.status !== "running") {
      throw new Error(
        `dream-candidate-store: cannot append candidates to run in status ${run.status}`,
      );
    }

    const created: CandidateEntryRecord[] = [];
    const insert = this.db.prepare(
      `INSERT INTO memory_candidate_entries (
        id, dream_run_id, op, status, payload_json, target_fact_id,
        session_ids_json, prevalence_json, rationale, pre_hash, post_hash,
        reverse_op, reverse_payload_json, applied_fact_id, sort_order, created_at
      ) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    );

    const createdAt = nowSec();
    let sortBase = this.db
      .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM memory_candidate_entries WHERE dream_run_id = ?")
      .get(dreamRunId) as { m: number };

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const id = randomUUID();
      const sortOrder = entry.sortOrder ?? sortBase.m + 1 + i;
      insert.run(
        id,
        dreamRunId,
        entry.op,
        JSON.stringify(entry.payload),
        entry.targetFactId ?? null,
        JSON.stringify(entry.evidence.sessionIds ?? []),
        JSON.stringify(entry.evidence.prevalence ?? { sessions: 0, agents: 0 }),
        entry.evidence.rationale ?? null,
        entry.preHash ?? null,
        entry.reverse.op,
        JSON.stringify(entry.reverse.payload ?? {}),
        sortOrder,
        createdAt,
      );
      const row = this.db.prepare("SELECT * FROM memory_candidate_entries WHERE id = ?").get(id) as CandidateRow;
      created.push(mapCandidate(row));
    }
    return created;
  }

  listCandidateEntries(dreamRunId: string): CandidateEntryRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memory_candidate_entries WHERE dream_run_id = ? ORDER BY sort_order ASC, created_at ASC",
      )
      .all(dreamRunId) as CandidateRow[];
    return rows.map(mapCandidate);
  }

  updateCandidateEntry(
    id: string,
    patch: {
      status?: CandidateEntryStatus;
      appliedFactId?: string | null;
      postHash?: string | null;
      reverse?: ReversePlan;
      preHash?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.appliedFactId !== undefined) {
      sets.push("applied_fact_id = ?");
      params.push(patch.appliedFactId);
    }
    if (patch.postHash !== undefined) {
      sets.push("post_hash = ?");
      params.push(patch.postHash);
    }
    if (patch.preHash !== undefined) {
      sets.push("pre_hash = ?");
      params.push(patch.preHash);
    }
    if (patch.reverse !== undefined) {
      sets.push("reverse_op = ?");
      params.push(patch.reverse.op);
      sets.push("reverse_payload_json = ?");
      params.push(JSON.stringify(patch.reverse.payload ?? {}));
    }
    if (sets.length === 0) return;
    params.push(id);
    const result = this.db
      .prepare(`UPDATE memory_candidate_entries SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(params as never[]));
    if (Number(result.changes ?? 0) === 0) {
      pluginLogger.warn(`dream-candidate-store: updateCandidateEntry missed id=${id}`);
    }
  }
}
