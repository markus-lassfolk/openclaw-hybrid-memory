import type { DatabaseSync } from "node:sqlite";
import type { AttentionOverride, AttentionOverrideAction, AttentionTargetKind } from "../../types/attention-types.js";
import { nowIso } from "../../utils/dates.js";

interface OverrideRow {
  target_kind: string;
  target_id: string;
  action: string;
  reason: string | null;
  snoozed_until: string | null;
  created_at: string;
}

function rowToOverride(row: OverrideRow): AttentionOverride {
  return {
    targetKind: row.target_kind as AttentionTargetKind,
    targetId: row.target_id,
    action: row.action as AttentionOverrideAction,
    reason: row.reason,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
  };
}

export function setAttentionOverride(
  db: DatabaseSync,
  input: {
    targetKind: AttentionTargetKind;
    targetId: string;
    action: AttentionOverrideAction;
    reason?: string;
    snoozedUntil?: string;
  },
): AttentionOverride {
  const now = nowIso();
  db.prepare(
    `INSERT INTO loom_attention_overrides (target_kind, target_id, action, reason, snoozed_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_kind, target_id) DO UPDATE SET
       action = excluded.action, reason = excluded.reason, snoozed_until = excluded.snoozed_until, created_at = excluded.created_at`,
  ).run(input.targetKind, input.targetId, input.action, input.reason ?? null, input.snoozedUntil ?? null, now);
  const row = db
    .prepare("SELECT * FROM loom_attention_overrides WHERE target_kind = ? AND target_id = ?")
    .get(input.targetKind, input.targetId) as unknown as OverrideRow;
  return rowToOverride(row);
}

export function listAttentionOverrides(db: DatabaseSync): AttentionOverride[] {
  const rows = db.prepare("SELECT * FROM loom_attention_overrides").all() as unknown as OverrideRow[];
  return rows.map(rowToOverride);
}

export function getAttentionOverride(
  db: DatabaseSync,
  targetKind: AttentionTargetKind,
  targetId: string,
): AttentionOverride | null {
  const row = db
    .prepare("SELECT * FROM loom_attention_overrides WHERE target_kind = ? AND target_id = ?")
    .get(targetKind, targetId) as unknown as OverrideRow | undefined;
  return row ? rowToOverride(row) : null;
}
