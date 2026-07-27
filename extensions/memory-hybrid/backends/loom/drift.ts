import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CreateDriftFindingInput,
  DriftAffectedRef,
  DriftFinding,
  DriftFindingFilter,
  DriftRepairability,
  DriftSeverity,
  DriftStatus,
  DriftType,
} from "../../types/drift-types.js";
import { toArrayFilter } from "../../utils/array-filter.js";
import { nowIso } from "../../utils/dates.js";
import { normalizedHash } from "../../utils/tags.js";
import { parseJsonColumn } from "./json-helpers.js";

interface DriftRow {
  id: string;
  drift_type: string;
  old_text: string;
  replacement_text: string | null;
  affected_ids: string;
  severity: string;
  repairability: string;
  suggested_repair: string | null;
  status: string;
  linked_claim_ids: string;
  linked_evidence_capsule_ids: string;
  snoozed_until: string | null;
  promoted_to: string | null;
  detected_at: string;
  updated_at: string;
  dedup_hash: string | null;
}

function rowToDrift(row: DriftRow): DriftFinding {
  return {
    id: row.id,
    driftType: row.drift_type as DriftType,
    oldText: row.old_text,
    replacementText: row.replacement_text,
    affectedIds: parseJsonColumn<DriftAffectedRef[]>(row.affected_ids, [], "loom-drift"),
    severity: row.severity as DriftSeverity,
    repairability: row.repairability as DriftRepairability,
    suggestedRepair: row.suggested_repair,
    status: row.status as DriftStatus,
    linkedClaimIds: parseJsonColumn<string[]>(row.linked_claim_ids, [], "loom-drift"),
    linkedEvidenceCapsuleIds: parseJsonColumn<string[]>(row.linked_evidence_capsule_ids, [], "loom-drift"),
    snoozedUntil: row.snoozed_until,
    promotedTo: row.promoted_to,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    dedupHash: row.dedup_hash ?? "",
  };
}

export function driftDedupHash(input: { driftType: string; oldText: string }): string {
  return normalizedHash([input.driftType, input.oldText].join(" "));
}

export function findDriftByDedupHash(db: DatabaseSync, dedupHash: string): DriftFinding | null {
  const row = db
    .prepare(
      "SELECT * FROM loom_drift_findings WHERE dedup_hash = ? AND status IN ('open','acknowledged') ORDER BY detected_at DESC LIMIT 1",
    )
    .get(dedupHash) as unknown as DriftRow | undefined;
  return row ? rowToDrift(row) : null;
}

export function createDriftFinding(db: DatabaseSync, input: CreateDriftFindingInput): DriftFinding {
  const id = randomUUID();
  const now = nowIso();
  const dedupHash = driftDedupHash({ driftType: input.driftType, oldText: input.oldText });
  db.prepare(
    `INSERT INTO loom_drift_findings (
       id, drift_type, old_text, replacement_text, affected_ids, severity, repairability,
       suggested_repair, status, linked_claim_ids, linked_evidence_capsule_ids, snoozed_until,
       promoted_to, detected_at, updated_at, dedup_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.driftType,
    input.oldText,
    input.replacementText ?? null,
    JSON.stringify(input.affectedIds ?? []),
    input.severity ?? "medium",
    input.repairability ?? "human_review",
    input.suggestedRepair ?? null,
    JSON.stringify(input.linkedClaimIds ?? []),
    JSON.stringify(input.linkedEvidenceCapsuleIds ?? []),
    now,
    now,
    dedupHash,
  );
  return getDriftFinding(db, id) as DriftFinding;
}

export function getDriftFinding(db: DatabaseSync, id: string): DriftFinding | null {
  const row = db.prepare("SELECT * FROM loom_drift_findings WHERE id = ?").get(id) as unknown as DriftRow | undefined;
  return row ? rowToDrift(row) : null;
}

export function resolveDriftFinding(db: DatabaseSync, idOrPrefix: string): DriftFinding | null {
  const exact = getDriftFinding(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT * FROM loom_drift_findings WHERE id LIKE ? ORDER BY detected_at DESC LIMIT 2")
    .all(`${idOrPrefix}%`) as unknown as DriftRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`Ambiguous drift finding id prefix "${idOrPrefix}" — provide more characters.`);
  return rowToDrift(rows[0] as DriftRow);
}

export function listDriftFindings(db: DatabaseSync, filter?: DriftFindingFilter): DriftFinding[] {
  let query = "SELECT * FROM loom_drift_findings WHERE 1=1";
  const params: SQLInputValue[] = [];
  // toArrayFilter guards against a bare scalar (e.g. a non-tool caller passing one of these
  // fields directly) the same way the tool layer does, so this store is safe on its own
  // (issue #2185).
  const status = toArrayFilter(filter?.status);
  if (status && status.length > 0) {
    query += ` AND status IN (${status.map(() => "?").join(", ")})`;
    params.push(...status);
  }
  const driftType = toArrayFilter(filter?.driftType);
  if (driftType && driftType.length > 0) {
    query += ` AND drift_type IN (${driftType.map(() => "?").join(", ")})`;
    params.push(...driftType);
  }
  const severity = toArrayFilter(filter?.severity);
  if (severity && severity.length > 0) {
    query += ` AND severity IN (${severity.map(() => "?").join(", ")})`;
    params.push(...severity);
  }
  query += " ORDER BY detected_at DESC";
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : 100;
  query += " LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as unknown as DriftRow[];
  return rows.map(rowToDrift);
}

export function updateDriftStatus(
  db: DatabaseSync,
  id: string,
  status: DriftStatus,
  opts?: { snoozedUntil?: string; promotedTo?: string },
): DriftFinding {
  const existing = getDriftFinding(db, id);
  if (!existing) throw new Error(`Drift finding not found: ${id}`);
  db.prepare(
    "UPDATE loom_drift_findings SET status = ?, snoozed_until = ?, promoted_to = ?, updated_at = ? WHERE id = ?",
  ).run(status, opts?.snoozedUntil ?? null, opts?.promotedTo ?? null, nowIso(), id);
  return getDriftFinding(db, id) as DriftFinding;
}
