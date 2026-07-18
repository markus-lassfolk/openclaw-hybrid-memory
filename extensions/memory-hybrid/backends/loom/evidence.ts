import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RedactedEvidenceContent } from "../../services/evidence-redaction.js";
import type {
  EvidenceArtifact,
  EvidenceCapsule,
  EvidenceCapsuleFilter,
  EvidenceItem,
  EvidenceRedactionStatus,
} from "../../types/evidence-types.js";
import { nowIso } from "../../utils/dates.js";
import { parseJsonColumn } from "./json-helpers.js";

interface EvidenceRow {
  id: string;
  title: string;
  claim: string;
  actor: string | null;
  session_id: string | null;
  evidence: string;
  commands_run: string;
  artifacts: string;
  unverified_items: string;
  risk_flags: string;
  limits: string | null;
  redaction_status: string;
  redaction_count: number;
  verified_at: string | null;
  linked_claim_ids: string;
  linked_task_label: string | null;
  linked_goal_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToCapsule(row: EvidenceRow): EvidenceCapsule {
  return {
    id: row.id,
    title: row.title,
    claim: row.claim,
    actor: row.actor,
    sessionId: row.session_id,
    evidence: parseJsonColumn<EvidenceItem[]>(row.evidence, [], "loom-evidence"),
    commandsRun: parseJsonColumn<string[]>(row.commands_run, [], "loom-evidence"),
    artifacts: parseJsonColumn<EvidenceArtifact[]>(row.artifacts, [], "loom-evidence"),
    unverifiedItems: parseJsonColumn<string[]>(row.unverified_items, [], "loom-evidence"),
    riskFlags: parseJsonColumn<string[]>(row.risk_flags, [], "loom-evidence"),
    limits: row.limits,
    redactionStatus: row.redaction_status as EvidenceRedactionStatus,
    redactionCount: row.redaction_count,
    verifiedAt: row.verified_at,
    linkedClaimIds: parseJsonColumn<string[]>(row.linked_claim_ids, [], "loom-evidence"),
    linkedTaskLabel: row.linked_task_label,
    linkedGoalId: row.linked_goal_id,
    metadata: parseJsonColumn<Record<string, unknown>>(row.metadata, {}, "loom-evidence"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateEvidenceCapsuleParams {
  content: RedactedEvidenceContent;
  actor?: string;
  sessionId?: string;
  linkedClaimIds?: string[];
  linkedTaskLabel?: string;
  linkedGoalId?: string;
  metadata?: Record<string, unknown>;
}

export function createEvidenceCapsule(db: DatabaseSync, params: CreateEvidenceCapsuleParams): EvidenceCapsule {
  const id = randomUUID();
  const now = nowIso();
  const { content } = params;
  db.prepare(
    `INSERT INTO loom_evidence_capsules (
       id, title, claim, actor, session_id, evidence, commands_run, artifacts,
       unverified_items, risk_flags, limits, redaction_status, redaction_count,
       verified_at, linked_claim_ids, linked_task_label, linked_goal_id, metadata,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    content.title,
    content.claim,
    params.actor ?? null,
    params.sessionId ?? null,
    JSON.stringify(content.evidence),
    JSON.stringify(content.commandsRun),
    JSON.stringify(content.artifacts),
    JSON.stringify(content.unverifiedItems),
    JSON.stringify(content.riskFlags),
    content.limits ?? null,
    content.redacted ? "redacted" : "clean",
    content.redactionCount,
    JSON.stringify(params.linkedClaimIds ?? []),
    params.linkedTaskLabel ?? null,
    params.linkedGoalId ?? null,
    JSON.stringify(params.metadata ?? {}),
    now,
    now,
  );
  return getEvidenceCapsule(db, id) as EvidenceCapsule;
}

export function getEvidenceCapsule(db: DatabaseSync, id: string): EvidenceCapsule | null {
  const row = db.prepare("SELECT * FROM loom_evidence_capsules WHERE id = ?").get(id) as unknown as
    | EvidenceRow
    | undefined;
  return row ? rowToCapsule(row) : null;
}

/** Resolve an exact id or short id-prefix; throws on an ambiguous prefix. */
export function resolveEvidenceCapsule(db: DatabaseSync, idOrPrefix: string): EvidenceCapsule | null {
  const exact = getEvidenceCapsule(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT * FROM loom_evidence_capsules WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2")
    .all(`${idOrPrefix}%`) as unknown as EvidenceRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1)
    throw new Error(`Ambiguous evidence capsule id prefix "${idOrPrefix}" — provide more characters.`);
  return rowToCapsule(rows[0] as EvidenceRow);
}

export function listEvidenceCapsules(db: DatabaseSync, filter?: EvidenceCapsuleFilter): EvidenceCapsule[] {
  let query = "SELECT * FROM loom_evidence_capsules WHERE 1=1";
  const params: SQLInputValue[] = [];
  if (filter?.linkedClaimId) {
    query += " AND linked_claim_ids LIKE ?";
    params.push(`%"${filter.linkedClaimId}"%`);
  }
  if (filter?.linkedTaskLabel) {
    query += " AND linked_task_label = ?";
    params.push(filter.linkedTaskLabel);
  }
  if (filter?.linkedGoalId) {
    query += " AND linked_goal_id = ?";
    params.push(filter.linkedGoalId);
  }
  if (filter?.since) {
    query += " AND created_at >= ?";
    params.push(filter.since);
  }
  query += " ORDER BY created_at DESC";
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : 50;
  query += " LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as unknown as EvidenceRow[];
  return rows.map(rowToCapsule);
}

export function markEvidenceCapsuleVerified(db: DatabaseSync, id: string, at: string = nowIso()): EvidenceCapsule {
  const existing = getEvidenceCapsule(db, id);
  if (!existing) throw new Error(`Evidence capsule not found: ${id}`);
  db.prepare("UPDATE loom_evidence_capsules SET verified_at = ?, updated_at = ? WHERE id = ?").run(at, nowIso(), id);
  return getEvidenceCapsule(db, id) as EvidenceCapsule;
}

/** Link a capsule to a claim (bidirectional bookkeeping lives in the beliefs module). */
export function linkEvidenceCapsuleToClaim(db: DatabaseSync, id: string, claimId: string): EvidenceCapsule {
  const existing = getEvidenceCapsule(db, id);
  if (!existing) throw new Error(`Evidence capsule not found: ${id}`);
  if (existing.linkedClaimIds.includes(claimId)) return existing;
  const updated = [...existing.linkedClaimIds, claimId];
  db.prepare("UPDATE loom_evidence_capsules SET linked_claim_ids = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(updated),
    nowIso(),
    id,
  );
  return getEvidenceCapsule(db, id) as EvidenceCapsule;
}

export function attachEvidenceCapsule(
  db: DatabaseSync,
  id: string,
  patch: { linkedTaskLabel?: string; linkedGoalId?: string },
): EvidenceCapsule {
  const existing = getEvidenceCapsule(db, id);
  if (!existing) throw new Error(`Evidence capsule not found: ${id}`);
  const sets: string[] = ["updated_at = ?"];
  const params: SQLInputValue[] = [nowIso()];
  if (patch.linkedTaskLabel !== undefined) {
    sets.push("linked_task_label = ?");
    params.push(patch.linkedTaskLabel);
  }
  if (patch.linkedGoalId !== undefined) {
    sets.push("linked_goal_id = ?");
    params.push(patch.linkedGoalId);
  }
  params.push(id);
  db.prepare(`UPDATE loom_evidence_capsules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getEvidenceCapsule(db, id) as EvidenceCapsule;
}
