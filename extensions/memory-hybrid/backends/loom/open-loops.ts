import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CloseOpenLoopInput,
  CreateOpenLoopInput,
  LoopOwner,
  LoopStatus,
  LoopType,
  OpenLoop,
  OpenLoopFilter,
} from "../../types/open-loop-types.js";
import { addDaysUtcIso, nowIso } from "../../utils/dates.js";
import { clamp01, parseJsonColumn } from "./json-helpers.js";

interface LoopRow {
  id: string;
  title: string;
  description: string;
  loop_type: string;
  scope: string | null;
  entity: string | null;
  repo: string | null;
  owner: string;
  status: string;
  next_action: string | null;
  closure_criteria: string | null;
  evidence_required: number;
  linked_goal_ids: string;
  linked_task_labels: string;
  linked_claim_ids: string;
  linked_evidence_capsule_ids: string;
  resurface_at: string | null;
  urgency: number;
  importance: number;
  operator_load_risk: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
  close_evidence_capsule_id: string | null;
  superseded_by_loop_id: string | null;
  last_resurfaced_at: string | null;
}

function rowToLoop(row: LoopRow): OpenLoop {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    loopType: row.loop_type as LoopType,
    scope: row.scope,
    entity: row.entity,
    repo: row.repo,
    owner: row.owner as LoopOwner,
    status: row.status as LoopStatus,
    nextAction: row.next_action,
    closureCriteria: row.closure_criteria,
    evidenceRequired: row.evidence_required !== 0,
    linkedGoalIds: parseJsonColumn<string[]>(row.linked_goal_ids, [], "loom-open-loops"),
    linkedTaskLabels: parseJsonColumn<string[]>(row.linked_task_labels, [], "loom-open-loops"),
    linkedClaimIds: parseJsonColumn<string[]>(row.linked_claim_ids, [], "loom-open-loops"),
    linkedEvidenceCapsuleIds: parseJsonColumn<string[]>(row.linked_evidence_capsule_ids, [], "loom-open-loops"),
    resurfaceAt: row.resurface_at,
    urgency: row.urgency,
    importance: row.importance,
    operatorLoadRisk: row.operator_load_risk,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    closeEvidenceCapsuleId: row.close_evidence_capsule_id,
    supersededByLoopId: row.superseded_by_loop_id,
    lastResurfacedAt: row.last_resurfaced_at,
  };
}

export function createOpenLoop(
  db: DatabaseSync,
  input: CreateOpenLoopInput,
  opts?: { defaultResurfaceDays?: number },
): OpenLoop {
  const id = randomUUID();
  const now = nowIso();
  const resurfaceAt =
    input.resurfaceAt ?? (opts?.defaultResurfaceDays ? addDaysUtcIso(opts.defaultResurfaceDays) : null);
  db.prepare(
    `INSERT INTO loom_open_loops (
       id, title, description, loop_type, scope, entity, repo, owner, status,
       next_action, closure_criteria, evidence_required, linked_goal_ids, linked_task_labels,
       linked_claim_ids, linked_evidence_capsule_ids, resurface_at, urgency, importance,
       operator_load_risk, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    input.description ?? "",
    input.loopType,
    input.scope ?? null,
    input.entity ?? null,
    input.repo ?? null,
    input.owner ?? "unknown",
    input.nextAction ?? null,
    input.closureCriteria ?? null,
    input.evidenceRequired ? 1 : 0,
    JSON.stringify(input.linkedGoalIds ?? []),
    JSON.stringify(input.linkedTaskLabels ?? []),
    JSON.stringify(input.linkedClaimIds ?? []),
    JSON.stringify(input.linkedEvidenceCapsuleIds ?? []),
    resurfaceAt,
    clamp01(input.urgency),
    clamp01(input.importance),
    clamp01(input.operatorLoadRisk, 0.3),
    now,
    now,
  );
  return getOpenLoop(db, id) as OpenLoop;
}

export function getOpenLoop(db: DatabaseSync, id: string): OpenLoop | null {
  const row = db.prepare("SELECT * FROM loom_open_loops WHERE id = ?").get(id) as unknown as LoopRow | undefined;
  return row ? rowToLoop(row) : null;
}

export function resolveOpenLoop(db: DatabaseSync, idOrPrefix: string): OpenLoop | null {
  const exact = getOpenLoop(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT * FROM loom_open_loops WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2")
    .all(`${idOrPrefix}%`) as unknown as LoopRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`Ambiguous open loop id prefix "${idOrPrefix}" — provide more characters.`);
  return rowToLoop(rows[0] as LoopRow);
}

export function listOpenLoops(db: DatabaseSync, filter?: OpenLoopFilter): OpenLoop[] {
  let query = "SELECT * FROM loom_open_loops WHERE 1=1";
  const params: SQLInputValue[] = [];
  if (filter?.status && filter.status.length > 0) {
    query += ` AND status IN (${filter.status.map(() => "?").join(", ")})`;
    params.push(...filter.status);
  }
  if (filter?.loopType && filter.loopType.length > 0) {
    query += ` AND loop_type IN (${filter.loopType.map(() => "?").join(", ")})`;
    params.push(...filter.loopType);
  }
  if (filter?.scope) {
    query += " AND scope = ?";
    params.push(filter.scope);
  }
  if (filter?.entity) {
    query += " AND entity = ?";
    params.push(filter.entity);
  }
  if (filter?.repo) {
    query += " AND repo = ?";
    params.push(filter.repo);
  }
  if (filter?.owner) {
    query += " AND owner = ?";
    params.push(filter.owner);
  }
  query += " ORDER BY created_at DESC";
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : 100;
  query += " LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as unknown as LoopRow[];
  return rows.map(rowToLoop);
}

export function updateOpenLoop(
  db: DatabaseSync,
  id: string,
  patch: Partial<CreateOpenLoopInput & { status: LoopStatus }>,
): OpenLoop {
  const existing = getOpenLoop(db, id);
  if (!existing) throw new Error(`Open loop not found: ${id}`);
  const sets: string[] = ["updated_at = ?"];
  const params: SQLInputValue[] = [nowIso()];
  const setCol = (col: string, val: SQLInputValue) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.title !== undefined) setCol("title", patch.title);
  if (patch.description !== undefined) setCol("description", patch.description);
  if (patch.status !== undefined) setCol("status", patch.status);
  if (patch.nextAction !== undefined) setCol("next_action", patch.nextAction);
  if (patch.closureCriteria !== undefined) setCol("closure_criteria", patch.closureCriteria);
  if (patch.resurfaceAt !== undefined) setCol("resurface_at", patch.resurfaceAt);
  if (patch.urgency !== undefined) setCol("urgency", clamp01(patch.urgency));
  if (patch.importance !== undefined) setCol("importance", clamp01(patch.importance));
  if (patch.operatorLoadRisk !== undefined) setCol("operator_load_risk", clamp01(patch.operatorLoadRisk));
  if (patch.linkedGoalIds !== undefined) setCol("linked_goal_ids", JSON.stringify(patch.linkedGoalIds));
  if (patch.linkedTaskLabels !== undefined) setCol("linked_task_labels", JSON.stringify(patch.linkedTaskLabels));
  if (patch.linkedClaimIds !== undefined) setCol("linked_claim_ids", JSON.stringify(patch.linkedClaimIds));
  if (patch.linkedEvidenceCapsuleIds !== undefined)
    setCol("linked_evidence_capsule_ids", JSON.stringify(patch.linkedEvidenceCapsuleIds));
  params.push(id);
  db.prepare(`UPDATE loom_open_loops SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getOpenLoop(db, id) as OpenLoop;
}

export class OpenLoopEvidenceRequiredError extends Error {
  constructor(id: string) {
    super(`Open loop ${id} requires evidence to close (evidenceRequired: true) — pass an evidenceCapsuleId.`);
    this.name = "OpenLoopEvidenceRequiredError";
  }
}

export function closeOpenLoop(db: DatabaseSync, id: string, input: CloseOpenLoopInput = {}): OpenLoop {
  const existing = getOpenLoop(db, id);
  if (!existing) throw new Error(`Open loop not found: ${id}`);
  if (existing.evidenceRequired && !input.evidenceCapsuleId) {
    throw new OpenLoopEvidenceRequiredError(id);
  }
  const now = nowIso();
  const status = input.status ?? "closed";
  db.prepare(
    `UPDATE loom_open_loops SET status = ?, closed_at = ?, close_reason = ?, close_evidence_capsule_id = ?,
       superseded_by_loop_id = ?, updated_at = ? WHERE id = ?`,
  ).run(status, now, input.reason ?? null, input.evidenceCapsuleId ?? null, input.supersededByLoopId ?? null, now, id);
  return getOpenLoop(db, id) as OpenLoop;
}

/**
 * Loops due for resurfacing (resurfaceAt <= now, still open-ish), ranked by urgency+importance.
 * Excludes loops already resurfaced for the current due-cycle (last_resurfaced_at >= resurface_at)
 * so `markResurfaced` actually suppresses re-notifying until the loop is re-armed (resurfaceAt bumped).
 */
export function listDueForResurface(db: DatabaseSync, now: string = nowIso(), limit = 50): OpenLoop[] {
  const rows = db
    .prepare(
      `SELECT * FROM loom_open_loops
       WHERE status IN ('open', 'waiting', 'blocked', 'ready')
         AND resurface_at IS NOT NULL AND resurface_at <= ?
         AND (last_resurfaced_at IS NULL OR last_resurfaced_at < resurface_at)
       ORDER BY (urgency + importance) DESC, resurface_at ASC
       LIMIT ?`,
    )
    .all(now, limit) as unknown as LoopRow[];
  return rows.map(rowToLoop);
}

export function markResurfaced(db: DatabaseSync, id: string, at: string = nowIso()): void {
  db.prepare("UPDATE loom_open_loops SET last_resurfaced_at = ? WHERE id = ?").run(at, id);
}
