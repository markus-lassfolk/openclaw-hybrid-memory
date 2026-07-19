import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  LifecycleAction,
  LifecycleAuditEntry,
  LifecycleTargetKind,
} from "../../types/lifecycle-workflow-types.js";
import { nowIso } from "../../utils/dates.js";
import { parseJsonColumn } from "./json-helpers.js";

interface AuditRow {
  id: string;
  target_kind: string;
  target_id: string;
  action: string;
  reason: string;
  confirmed_by: string | null;
  metadata: string;
  created_at: string;
}

function rowToAudit(row: AuditRow): LifecycleAuditEntry {
  return {
    id: row.id,
    targetKind: row.target_kind as LifecycleTargetKind,
    targetId: row.target_id,
    action: row.action as LifecycleAction,
    reason: row.reason,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
    metadata: parseJsonColumn<Record<string, unknown>>(row.metadata, {}, "loom-lifecycle-audit"),
  };
}

export function recordLifecycleAudit(
  db: DatabaseSync,
  input: {
    targetKind: LifecycleTargetKind;
    targetId: string;
    action: LifecycleAction;
    reason: string;
    confirmedBy?: string;
    metadata?: Record<string, unknown>;
  },
): LifecycleAuditEntry {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO loom_lifecycle_audit (id, target_kind, target_id, action, reason, confirmed_by, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.targetKind,
    input.targetId,
    input.action,
    input.reason,
    input.confirmedBy ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
  );
  const row = db.prepare("SELECT * FROM loom_lifecycle_audit WHERE id = ?").get(id) as unknown as AuditRow;
  return rowToAudit(row);
}

export function listLifecycleAudit(
  db: DatabaseSync,
  filter?: { targetKind?: LifecycleTargetKind; targetId?: string; limit?: number },
): LifecycleAuditEntry[] {
  let query = "SELECT * FROM loom_lifecycle_audit WHERE 1=1";
  const params: Array<string | number> = [];
  if (filter?.targetKind) {
    query += " AND target_kind = ?";
    params.push(filter.targetKind);
  }
  if (filter?.targetId) {
    query += " AND target_id = ?";
    params.push(filter.targetId);
  }
  query += " ORDER BY created_at DESC";
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : 100;
  query += " LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as unknown as AuditRow[];
  return rows.map(rowToAudit);
}
