/**
 * Cross-agent audit log (Issue #790) — SQLite WAL, local-only.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseSqliteStore } from "./base-sqlite-store.js";

type AuditOutcome = "success" | "partial" | "failed";

export interface AuditEventInput {
  timestamp?: number;
  agentId: string;
  action: string;
  target?: string | null;
  outcome: AuditOutcome;
  durationMs?: number;
  error?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  model?: string;
  tokens?: number;
}

interface AuditEventRow {
  id: string;
  timestamp: number;
  agentId: string;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  durationMs: number | null;
  error: string | null;
  context: Record<string, unknown> | null;
  sessionId: string | null;
  model: string | null;
  tokens: number | null;
}

const SENSITIVE_KEYS = /(api[_-]?key|password|secret|authorization|bearer|cookie|\btoken\b)/i;

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  // Primitives (except bigint) are safe and JSON-serializable as-is.
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    // Normalize bigint to string to avoid JSON serialization errors.
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    // Functions and symbols are not JSON-serializable; avoid leaking details.
    return "[non-serializable]";
  }

  if (typeof value === "object") {
    const obj = value as object;

    if (seen.has(obj)) {
      // Prevent infinite recursion on cyclic structures.
      return "[circular]";
    }
    seen.add(obj);

    if (Array.isArray(value)) {
      // Recursively scrub each array element (handles arrays of objects with sensitive keys).
      return (value as unknown[]).map((item) => scrubValue(item, seen));
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = scrubValue(v, seen);
      }
    }
    return out;
  }

  // Fallback for any remaining unexpected types.
  return "[non-serializable]";
}

function scrubContext(obj: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const scrubbed = scrubValue(obj, seen);

  // Ensure we always return a plain object as declared.
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}

export class AuditStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failed')),
        duration_ms INTEGER,
        error TEXT,
        context TEXT,
        session_id TEXT,
        model TEXT,
        tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_log(agent_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
    `);
  }

  protected getSubsystemName(): string {
    return "audit-store";
  }

  append(input: AuditEventInput): string {
    const id = randomUUID();
    const ts = input.timestamp ?? Date.now();
    const ctxJson = input.context != null ? JSON.stringify(scrubContext(input.context)) : null;
    this.liveDb
      .prepare(
        `INSERT INTO audit_log (id, timestamp, agent_id, action, target, outcome, duration_ms, error, context, session_id, model, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ts,
        input.agentId,
        input.action,
        input.target ?? null,
        input.outcome,
        input.durationMs ?? null,
        input.error ?? null,
        ctxJson,
        input.sessionId ?? null,
        input.model ?? null,
        input.tokens ?? null,
      );
    return id;
  }

  query(opts: {
    sinceMs?: number;
    untilMs?: number;
    agentId?: string;
    action?: string;
    outcome?: AuditOutcome;
    targetContains?: string;
    limit?: number;
  }): AuditEventRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 5000);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sinceMs != null) {
      clauses.push("timestamp >= ?");
      params.push(opts.sinceMs);
    }
    if (opts.untilMs != null) {
      clauses.push("timestamp <= ?");
      params.push(opts.untilMs);
    }
    if (opts.agentId) {
      clauses.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.action) {
      clauses.push("action = ?");
      params.push(opts.action);
    }
    if (opts.outcome) {
      clauses.push("outcome = ?");
      params.push(opts.outcome);
    }
    if (opts.targetContains) {
      const escapedTarget = opts.targetContains.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
      clauses.push("target LIKE ? ESCAPE '\\'");
      params.push(`%${escapedTarget}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.liveDb
      .prepare(
        `SELECT id, timestamp, agent_id, action, target, outcome, duration_ms, error, context, session_id, model, tokens
         FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: string;
      timestamp: number;
      agent_id: string;
      action: string;
      target: string | null;
      outcome: string;
      duration_ms: number | null;
      error: string | null;
      context: string | null;
      session_id: string | null;
      model: string | null;
      tokens: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      agentId: r.agent_id,
      action: r.action,
      target: r.target,
      outcome: r.outcome as AuditOutcome,
      durationMs: r.duration_ms,
      error: r.error,
      context: r.context ? (JSON.parse(r.context) as Record<string, unknown>) : null,
      sessionId: r.session_id,
      model: r.model,
      tokens: r.tokens,
    }));
  }

  summary24h(): {
    total: number;
    byOutcome: Record<AuditOutcome, number>;
    byAgent: Record<string, number>;
  } {
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = this.liveDb
      .prepare("SELECT outcome, agent_id, COUNT(*) as c FROM audit_log WHERE timestamp >= ? GROUP BY outcome, agent_id")
      .all(since) as Array<{ outcome: string; agent_id: string; c: number }>;
    let total = 0;
    const byOutcome: Record<AuditOutcome, number> = { success: 0, partial: 0, failed: 0 };
    const byAgent: Record<string, number> = {};
    for (const r of rows) {
      const c = Number(r.c);
      total += c;
      const o = r.outcome as AuditOutcome;
      if (o in byOutcome) byOutcome[o] += c;
      byAgent[r.agent_id] = (byAgent[r.agent_id] ?? 0) + c;
    }
    return { total, byOutcome, byAgent };
  }

  /** Remove entries older than retention days (default 90). */
  prune(retentionDays = 90): number {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const r = this.liveDb.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(cutoff);
    return Number(r.changes ?? 0);
  }
}

export function auditDbPathForMemorySqlite(memorySqlitePath: string): string | null {
  if (!memorySqlitePath || memorySqlitePath === ":memory:") return null;
  return join(dirname(memorySqlitePath), "audit.db");
}
