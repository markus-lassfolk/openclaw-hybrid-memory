/** Durable SQLite state for Pending Autopilot control-plane runs (#1334). */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { BaseSqliteStore } from "../../backends/base-sqlite-store.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { sanitizePendingDecision, shouldAdvancePendingCursor, stableRunSummaryJson } from "./foundation.js";
import type {
  AutopilotMode,
  PendingAutopilotLock,
  PendingAutopilotRunSummary,
  PendingDecision,
  PendingQueue,
} from "./types.js";
import { assertKnownEnum } from "./types.js";

export interface CreatePendingRunInput {
  runId: string;
  mode: AutopilotMode;
  policy: string;
  policyVersion: string;
  inputHash: string;
  queues: PendingQueue[];
  startedAt?: number;
  summary?: PendingAutopilotRunSummary;
}

export class PendingAutopilotStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    migratePendingAutopilotTables(this.liveDb);
  }

  protected getSubsystemName(): string {
    return "pending-autopilot-store";
  }

  createRun(input: CreatePendingRunInput): void {
    assertKnownEnum("mode", input.mode);
    for (const queue of input.queues) assertKnownEnum("queue", queue);
    if (input.mode === "dry-run") return;
    const now = input.startedAt ?? nowSeconds();
    this.liveDb
      .prepare(
        `INSERT OR IGNORE INTO pending_autopilot_runs
          (id, mode, policy, policy_version, input_hash, queues_json, started_at, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.mode,
        input.policy,
        input.policyVersion,
        input.inputHash,
        JSON.stringify(input.queues),
        now,
        input.summary ? stableRunSummaryJson(input.summary) : null,
      );
  }

  finishRun(runId: string, summary: PendingAutopilotRunSummary, finishedAt = nowSeconds()): void {
    if (summary.mode === "dry-run") return;
    this.liveDb
      .prepare("UPDATE pending_autopilot_runs SET finished_at = ?, summary_json = ? WHERE id = ?")
      .run(finishedAt, stableRunSummaryJson(summary), runId);
  }

  recordDecision(decision: PendingDecision): { inserted: boolean } {
    const safe = sanitizePendingDecision(decision);
    if (safe.mode === "dry-run") return { inserted: false };
    return this.insertDecision(safe);
  }

  recordLatestDecision(decision: PendingDecision): { inserted: boolean } {
    const safe = sanitizePendingDecision(decision);
    if (safe.mode === "dry-run") return { inserted: false };
    const tx = createTransaction(
      this.liveDb,
      () => {
        this.liveDb
          .prepare(
            `DELETE FROM pending_autopilot_decisions
             WHERE queue = ?
               AND item_id = ?
               AND policy = ?
               AND policy_version = ?
               AND action = ?
               AND input_hash <> ?`,
          )
          .run(safe.queue, safe.itemId, safe.policy, safe.policyVersion, safe.action, safe.inputHash);
        return this.insertDecision(safe);
      },
      "IMMEDIATE",
    );
    return tx();
  }

  advanceCursorIfSafe(decision: PendingDecision, cursor: string): boolean {
    const safe = sanitizePendingDecision(decision);
    if (safe.mode === "dry-run" || !shouldAdvancePendingCursor(safe)) return false;
    this.liveDb
      .prepare(
        `INSERT INTO pending_autopilot_cursors (queue, policy, cursor, input_hash, policy_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue, policy) DO UPDATE SET
           cursor = excluded.cursor,
           input_hash = excluded.input_hash,
           policy_version = excluded.policy_version,
           updated_at = excluded.updated_at`,
      )
      .run(safe.queue, safe.policy, cursor, safe.inputHash, safe.policyVersion, nowSeconds());
    return true;
  }

  getCursor(
    queue: PendingQueue,
    policy = "default",
  ): {
    queue: PendingQueue;
    policy: string;
    cursor: string;
    inputHash: string;
    policyVersion: string;
    updatedAt: number;
  } | null {
    assertKnownEnum("queue", queue);
    const row = this.liveDb
      .prepare("SELECT * FROM pending_autopilot_cursors WHERE queue = ? AND policy = ?")
      .get(queue, policy) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      queue,
      policy: row.policy as string,
      cursor: row.cursor as string,
      inputHash: row.input_hash as string,
      policyVersion: row.policy_version as string,
      updatedAt: row.updated_at as number,
    };
  }

  acquireLock(input: {
    queue: PendingQueue;
    itemId: string;
    inputHash: string;
    owner: string;
    ttlSeconds: number;
    mode: AutopilotMode;
  }): boolean {
    assertKnownEnum("queue", input.queue);
    assertKnownEnum("mode", input.mode);
    if (input.mode === "dry-run") return false;
    const now = nowSeconds();
    const tx = createTransaction(
      this.liveDb,
      () => {
        this.liveDb.prepare("DELETE FROM pending_autopilot_locks WHERE expires_at <= ?").run(now);
        const result = this.liveDb
          .prepare(
            `INSERT OR IGNORE INTO pending_autopilot_locks (queue, item_id, input_hash, owner, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.queue, input.itemId, input.inputHash, input.owner, now + input.ttlSeconds, now);
        return result.changes > 0;
      },
      "IMMEDIATE",
    );
    return tx();
  }

  releaseLock(input: {
    queue: PendingQueue;
    itemId: string;
    inputHash: string;
    owner: string;
    mode: AutopilotMode;
  }): boolean {
    assertKnownEnum("queue", input.queue);
    assertKnownEnum("mode", input.mode);
    if (input.mode === "dry-run") return false;
    const result = this.liveDb
      .prepare("DELETE FROM pending_autopilot_locks WHERE queue = ? AND item_id = ? AND input_hash = ? AND owner = ?")
      .run(input.queue, input.itemId, input.inputHash, input.owner);
    return result.changes > 0;
  }

  mutateWithLockAndAudit(input: {
    decision: PendingDecision;
    owner: string;
    actualInputHash: string;
    mutate: () => void;
    audit: () => void;
  }): boolean {
    const safe = sanitizePendingDecision(input.decision);
    if (safe.mode === "dry-run") return false;
    assertKnownEnum("queue", safe.queue);
    const tx = createTransaction(
      this.liveDb,
      () => {
        if (safe.inputHash !== input.actualInputHash) return false;
        const lock = this.getActiveLockInternal(safe.queue, safe.itemId, input.owner, nowSeconds());
        if (!lock || lock.inputHash !== safe.inputHash) return false;
        const inserted = this.insertDecision(safe).inserted;
        if (!inserted) return false;
        input.audit();
        input.mutate();
        return true;
      },
      "IMMEDIATE",
    );
    return tx();
  }

  /**
   * @deprecated Use mutateWithLockAndAudit so lock ownership and audit atomicity are enforced.
   * This legacy CAS-only helper intentionally no-ops: #1334 requires every mutating path
   * to revalidate an active lock and write audit state transactionally before mutation.
   */
  mutateWithInputHash(input: {
    queue: PendingQueue;
    itemId: string;
    expectedInputHash: string;
    actualInputHash: string;
    mode: AutopilotMode;
    mutate: () => void;
  }): boolean {
    assertKnownEnum("queue", input.queue);
    assertKnownEnum("mode", input.mode);
    void input.itemId;
    void input.expectedInputHash;
    void input.actualInputHash;
    void input.mutate;
    return false;
  }

  listDecisions(filter: { queue?: PendingQueue; itemId?: string } = {}): PendingDecision[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.queue) {
      clauses.push("queue = ?");
      params.push(filter.queue);
    }
    if (filter.itemId) {
      clauses.push("item_id = ?");
      params.push(filter.itemId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.liveDb
      .prepare(`SELECT * FROM pending_autopilot_decisions ${where} ORDER BY created_at, queue, item_id`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToDecision);
  }

  listLocks(): PendingAutopilotLock[] {
    const rows = this.liveDb.prepare("SELECT * FROM pending_autopilot_locks ORDER BY queue, item_id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      queue: row.queue as PendingQueue,
      itemId: row.item_id as string,
      inputHash: row.input_hash as string,
      owner: row.owner as string,
      expiresAt: row.expires_at as number,
      createdAt: row.created_at as number,
    }));
  }

  tableCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of [
      "pending_autopilot_runs",
      "pending_autopilot_decisions",
      "pending_autopilot_cursors",
      "pending_autopilot_locks",
    ] as const) {
      out[table] = (this.liveDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return out;
  }

  private insertDecision(safe: PendingDecision): { inserted: boolean } {
    const createdAt = safe.createdAt ?? nowSeconds();
    const result = this.liveDb
      .prepare(
        `INSERT OR IGNORE INTO pending_autopilot_decisions
          (queue, item_id, input_hash, policy, policy_version, mode, action, reason_code, action_class, capability_class, confidence, human_review_required, evidence_json, actor_json, run_id, job_id, summary_json, audit_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        safe.queue,
        safe.itemId,
        safe.inputHash,
        safe.policy,
        safe.policyVersion,
        safe.mode,
        safe.action,
        safe.reasonCode,
        safe.actionClass,
        safe.capabilityClass,
        safe.confidence,
        safe.humanReviewRequired ? 1 : 0,
        JSON.stringify(safe.evidence),
        JSON.stringify(safe.actor),
        safe.runId,
        safe.jobId ?? null,
        safe.summary ? JSON.stringify(safe.summary) : null,
        safe.audit ? JSON.stringify(safe.audit) : null,
        createdAt,
      );
    return { inserted: result.changes > 0 };
  }

  private getActiveLockInternal(
    queue: PendingQueue,
    itemId: string,
    owner: string,
    now: number,
  ): PendingAutopilotLock | null {
    const row = this.liveDb
      .prepare(
        `SELECT * FROM pending_autopilot_locks
         WHERE queue = ? AND item_id = ? AND owner = ? AND expires_at > ?`,
      )
      .get(queue, itemId, owner, now) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      queue: row.queue as PendingQueue,
      itemId: row.item_id as string,
      inputHash: row.input_hash as string,
      owner: row.owner as string,
      expiresAt: row.expires_at as number,
      createdAt: row.created_at as number,
    };
  }
}

export function migratePendingAutopilotTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_autopilot_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'default',
      policy_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      queues_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_autopilot_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL,
      item_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'default',
      policy_version TEXT NOT NULL,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      action_class TEXT NOT NULL,
      capability_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      human_review_required INTEGER NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      actor_json TEXT NOT NULL DEFAULT '{}',
      run_id TEXT NOT NULL,
      job_id TEXT,
      summary_json TEXT,
      audit_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(queue, item_id, input_hash, policy, policy_version, action)
    );
  `);

  migrateDecisionPolicyVersionUnique(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_autopilot_cursors (
      queue TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'default',
      cursor TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(queue, policy)
    );

    CREATE TABLE IF NOT EXISTS pending_autopilot_locks (
      queue TEXT NOT NULL,
      item_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(queue, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_autopilot_runs_started ON pending_autopilot_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_autopilot_decisions_run ON pending_autopilot_decisions(run_id);
    CREATE INDEX IF NOT EXISTS idx_pending_autopilot_decisions_queue ON pending_autopilot_decisions(queue, item_id);
    CREATE INDEX IF NOT EXISTS idx_pending_autopilot_locks_expiry ON pending_autopilot_locks(expires_at);
  `);
}

function migrateDecisionPolicyVersionUnique(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_autopilot_decisions'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql?.includes("UNIQUE(queue, item_id, input_hash, policy, action)")) return;

  db.exec(`
    BEGIN;

    ALTER TABLE pending_autopilot_decisions RENAME TO pending_autopilot_decisions_old_policy_unique;

    CREATE TABLE pending_autopilot_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL,
      item_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'default',
      policy_version TEXT NOT NULL,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      action_class TEXT NOT NULL,
      capability_class TEXT NOT NULL,
      confidence REAL NOT NULL,
      human_review_required INTEGER NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      actor_json TEXT NOT NULL DEFAULT '{}',
      run_id TEXT NOT NULL,
      job_id TEXT,
      summary_json TEXT,
      audit_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(queue, item_id, input_hash, policy, policy_version, action)
    );

    INSERT OR IGNORE INTO pending_autopilot_decisions
      (id, queue, item_id, input_hash, policy, policy_version, mode, action, reason_code, action_class, capability_class, confidence, human_review_required, evidence_json, actor_json, run_id, job_id, summary_json, audit_json, created_at)
    SELECT
      id, queue, item_id, input_hash, policy, policy_version, mode, action, reason_code, action_class, capability_class, confidence, human_review_required, evidence_json, actor_json, run_id, job_id, summary_json, audit_json, created_at
    FROM pending_autopilot_decisions_old_policy_unique;

    DROP TABLE pending_autopilot_decisions_old_policy_unique;

    COMMIT;
  `);
}

function rowToDecision(row: Record<string, unknown>): PendingDecision {
  return {
    queue: row.queue as PendingQueue,
    itemId: row.item_id as string,
    inputHash: row.input_hash as string,
    policy: row.policy as string,
    policyVersion: row.policy_version as string,
    mode: row.mode as AutopilotMode,
    action: row.action as PendingDecision["action"],
    reasonCode: row.reason_code as PendingDecision["reasonCode"],
    actionClass: row.action_class as PendingDecision["actionClass"],
    capabilityClass: row.capability_class as PendingDecision["capabilityClass"],
    confidence: row.confidence as number,
    humanReviewRequired: Boolean(row.human_review_required),
    evidence: JSON.parse(row.evidence_json as string),
    actor: JSON.parse(row.actor_json as string),
    runId: row.run_id as string,
    jobId: (row.job_id as string | null) ?? undefined,
    summary: row.summary_json ? JSON.parse(row.summary_json as string) : undefined,
    audit: row.audit_json ? JSON.parse(row.audit_json as string) : undefined,
    createdAt: row.created_at as number,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
