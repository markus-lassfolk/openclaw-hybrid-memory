import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AssertClaimInput,
  Claim,
  ClaimFilter,
  ClaimStatus,
  LiveCheckEvent,
  LiveCheckState,
  LiveCheckStatus,
  SuggestedLiveCheck,
} from "../../types/belief-types.js";
import { nowIso } from "../../utils/dates.js";
import { clamp01, parseJsonColumn } from "./json-helpers.js";

interface ClaimRow {
  id: string;
  entity: string;
  predicate: string;
  value: string;
  scope: string | null;
  status: string;
  confidence: number;
  why: string | null;
  source_fact_ids: string;
  evidence_capsule_ids: string;
  contradicts_claim_ids: string;
  supersedes_claim_ids: string;
  superseded_by_claim_id: string | null;
  invalidation_conditions: string;
  live_check_required: number;
  live_check_reason: string | null;
  suggested_checks: string;
  operational_impact: string | null;
  created_at: string;
  last_verified_at: string | null;
  updated_at: string;
}

function rowToClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    entity: row.entity,
    predicate: row.predicate,
    value: row.value,
    scope: row.scope,
    status: row.status as ClaimStatus,
    confidence: row.confidence,
    why: row.why,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    sourceFactIds: parseJsonColumn<string[]>(row.source_fact_ids, [], "loom-beliefs"),
    evidenceCapsuleIds: parseJsonColumn<string[]>(row.evidence_capsule_ids, [], "loom-beliefs"),
    contradictsClaimIds: parseJsonColumn<string[]>(row.contradicts_claim_ids, [], "loom-beliefs"),
    supersedesClaimIds: parseJsonColumn<string[]>(row.supersedes_claim_ids, [], "loom-beliefs"),
    supersededByClaimId: row.superseded_by_claim_id,
    invalidationConditions: parseJsonColumn<string[]>(row.invalidation_conditions, [], "loom-beliefs"),
    liveCheckRequired: row.live_check_required !== 0,
    liveCheckReason: row.live_check_reason,
    suggestedChecks: parseJsonColumn<SuggestedLiveCheck[]>(row.suggested_checks, [], "loom-beliefs"),
    operationalImpact: row.operational_impact,
    updatedAt: row.updated_at,
  };
}

export function assertClaim(db: DatabaseSync, input: AssertClaimInput): Claim {
  const id = randomUUID();
  const now = nowIso();
  const status: ClaimStatus = input.liveCheckRequired ? "must_live_check" : "unverified";
  db.prepare(
    `INSERT INTO loom_claims (
       id, entity, predicate, value, scope, status, confidence, why,
       source_fact_ids, evidence_capsule_ids, contradicts_claim_ids, supersedes_claim_ids,
       superseded_by_claim_id, invalidation_conditions, live_check_required, live_check_reason,
       suggested_checks, operational_impact, created_at, last_verified_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.entity,
    input.predicate,
    input.value,
    input.scope ?? null,
    status,
    clamp01(input.confidence),
    input.why ?? null,
    JSON.stringify(input.sourceFactIds ?? []),
    JSON.stringify(input.evidenceCapsuleIds ?? []),
    JSON.stringify(input.invalidationConditions ?? []),
    input.liveCheckRequired ? 1 : 0,
    input.liveCheckReason ?? null,
    JSON.stringify(input.suggestedChecks ?? []),
    input.operationalImpact ?? null,
    now,
    now,
  );
  return getClaim(db, id) as Claim;
}

export function getClaim(db: DatabaseSync, id: string): Claim | null {
  const row = db.prepare("SELECT * FROM loom_claims WHERE id = ?").get(id) as unknown as ClaimRow | undefined;
  return row ? rowToClaim(row) : null;
}

export function resolveClaim(db: DatabaseSync, idOrPrefix: string): Claim | null {
  const exact = getClaim(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .prepare("SELECT * FROM loom_claims WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2")
    .all(`${idOrPrefix}%`) as unknown as ClaimRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`Ambiguous claim id prefix "${idOrPrefix}" — provide more characters.`);
  return rowToClaim(rows[0] as ClaimRow);
}

export function listClaims(db: DatabaseSync, filter?: ClaimFilter): Claim[] {
  let query = "SELECT * FROM loom_claims WHERE 1=1";
  const params: SQLInputValue[] = [];
  if (filter?.entity) {
    query += " AND entity = ?";
    params.push(filter.entity);
  }
  if (filter?.predicate) {
    query += " AND predicate = ?";
    params.push(filter.predicate);
  }
  if (filter?.scope) {
    query += " AND scope = ?";
    params.push(filter.scope);
  }
  if (filter?.status && filter.status.length > 0) {
    query += ` AND status IN (${filter.status.map(() => "?").join(", ")})`;
    params.push(...filter.status);
  }
  if (filter?.liveCheckRequired !== undefined) {
    query += " AND live_check_required = ?";
    params.push(filter.liveCheckRequired ? 1 : 0);
  }
  query += " ORDER BY created_at DESC";
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : 100;
  query += " LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as unknown as ClaimRow[];
  return rows.map(rowToClaim);
}

/** Claims "for" an entity that are primary truth: excludes contradicted/superseded unless requested. */
export function getBeliefsForEntity(db: DatabaseSync, entity: string, includeNonPrimary = false): Claim[] {
  const all = listClaims(db, { entity, limit: 500 });
  if (includeNonPrimary) return all;
  return all.filter((c) => c.status !== "contradicted" && c.status !== "superseded");
}

function updateClaimRow(db: DatabaseSync, id: string, sets: string[], params: SQLInputValue[]): Claim {
  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE loom_claims SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getClaim(db, id) as Claim;
}

export function verifyClaim(
  db: DatabaseSync,
  id: string,
  opts: { evidenceCapsuleId?: string; confidence?: number; at?: string } = {},
): Claim {
  const existing = getClaim(db, id);
  if (!existing) throw new Error(`Claim not found: ${id}`);
  const evidenceIds = opts.evidenceCapsuleId
    ? Array.from(new Set([...existing.evidenceCapsuleIds, opts.evidenceCapsuleId]))
    : existing.evidenceCapsuleIds;
  const at = opts.at ?? nowIso();
  return updateClaimRow(
    db,
    id,
    ["status = ?", "confidence = ?", "evidence_capsule_ids = ?", "last_verified_at = ?"],
    [
      existing.liveCheckRequired ? "must_live_check" : "verified",
      clamp01(opts.confidence ?? Math.max(existing.confidence, 0.9)),
      JSON.stringify(evidenceIds),
      at,
    ],
  );
}

export function contradictClaim(db: DatabaseSync, id: string, withClaimId: string, _reason?: string): Claim {
  const existing = getClaim(db, id);
  if (!existing) throw new Error(`Claim not found: ${id}`);
  const other = getClaim(db, withClaimId);
  if (!other) throw new Error(`Claim not found: ${withClaimId}`);
  const mine = Array.from(new Set([...existing.contradictsClaimIds, withClaimId]));
  updateClaimRow(
    db,
    withClaimId,
    ["status = ?", "contradicts_claim_ids = ?"],
    ["contradicted", JSON.stringify(Array.from(new Set([...other.contradictsClaimIds, id])))],
  );
  return updateClaimRow(db, id, ["status = ?", "contradicts_claim_ids = ?"], ["contradicted", JSON.stringify(mine)]);
}

export function supersedeClaim(db: DatabaseSync, id: string, byClaimId: string): Claim {
  const existing = getClaim(db, id);
  if (!existing) throw new Error(`Claim not found: ${id}`);
  const successor = getClaim(db, byClaimId);
  if (!successor) throw new Error(`Claim not found: ${byClaimId}`);
  updateClaimRow(
    db,
    byClaimId,
    ["supersedes_claim_ids = ?"],
    [JSON.stringify(Array.from(new Set([...successor.supersedesClaimIds, id])))],
  );
  return updateClaimRow(db, id, ["status = ?", "superseded_by_claim_id = ?"], ["superseded", byClaimId]);
}

/** Degrade `verified`/`believed` claims whose lastVerifiedAt (or, absent that, createdAt) is older than staleAfterDays to `stale`. */
export function sweepStaleClaims(db: DatabaseSync, staleAfterDays: number, now: string = nowIso()): number {
  const cutoffMs = new Date(now).getTime() - staleAfterDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const result = db
    .prepare(
      `UPDATE loom_claims SET status = 'stale', updated_at = ?
       WHERE status IN ('verified', 'believed')
         AND COALESCE(last_verified_at, created_at) < ?`,
    )
    .run(now, cutoffIso);
  return Number(result.changes);
}

export function requireLiveCheck(
  db: DatabaseSync,
  id: string,
  opts: { reason: string; suggestedChecks?: SuggestedLiveCheck[] },
): Claim {
  return updateClaimRow(
    db,
    id,
    ["live_check_required = 1", "live_check_reason = ?", "suggested_checks = ?", "status = ?"],
    [opts.reason, JSON.stringify(opts.suggestedChecks ?? []), "must_live_check"],
  );
}

// --- Live checks (#2156) ----------------------------------------------------

interface LiveCheckRow {
  id: string;
  claim_id: string;
  satisfied_at: string;
  expires_at: string | null;
  evidence_capsule_id: string | null;
  note: string | null;
  satisfied_by: string | null;
}

function rowToLiveCheckEvent(row: LiveCheckRow): LiveCheckEvent {
  return {
    id: row.id,
    claimId: row.claim_id,
    satisfiedAt: row.satisfied_at,
    expiresAt: row.expires_at,
    evidenceCapsuleId: row.evidence_capsule_id,
    note: row.note,
    satisfiedBy: row.satisfied_by,
  };
}

export function satisfyLiveCheck(
  db: DatabaseSync,
  params: { claimId: string; evidenceCapsuleId?: string; note?: string; satisfiedBy?: string; ttlHours: number },
): LiveCheckEvent {
  const claim = getClaim(db, params.claimId);
  if (!claim) throw new Error(`Claim not found: ${params.claimId}`);
  const id = randomUUID();
  const satisfiedAt = nowIso();
  const expiresAt =
    params.ttlHours > 0 ? new Date(Date.parse(satisfiedAt) + params.ttlHours * 3_600_000).toISOString() : null;
  db.prepare(
    `INSERT INTO loom_live_check_events (id, claim_id, satisfied_at, expires_at, evidence_capsule_id, note, satisfied_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.claimId,
    satisfiedAt,
    expiresAt,
    params.evidenceCapsuleId ?? null,
    params.note ?? null,
    params.satisfiedBy ?? null,
  );

  if (params.evidenceCapsuleId && !claim.evidenceCapsuleIds.includes(params.evidenceCapsuleId)) {
    updateClaimRow(
      db,
      claim.id,
      ["evidence_capsule_ids = ?"],
      [JSON.stringify([...claim.evidenceCapsuleIds, params.evidenceCapsuleId])],
    );
  }
  // A freshly satisfied live check clears must_live_check back to verified.
  if (claim.status === "must_live_check") {
    updateClaimRow(db, claim.id, ["status = ?", "last_verified_at = ?"], ["verified", satisfiedAt]);
  }
  const row = db.prepare("SELECT * FROM loom_live_check_events WHERE id = ?").get(id) as unknown as LiveCheckRow;
  return rowToLiveCheckEvent(row);
}

export function listLiveCheckEvents(db: DatabaseSync, claimId: string): LiveCheckEvent[] {
  const rows = db
    .prepare("SELECT * FROM loom_live_check_events WHERE claim_id = ? ORDER BY satisfied_at DESC")
    .all(claimId) as unknown as LiveCheckRow[];
  return rows.map(rowToLiveCheckEvent);
}

/** Current live-check state of a claim: not_required | required_unsatisfied | satisfied | expired. */
export function getLiveCheckStatus(db: DatabaseSync, claimId: string, now: string = nowIso()): LiveCheckStatus {
  const claim = getClaim(db, claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  const events = listLiveCheckEvents(db, claimId);
  const latest = events[0];
  let state: LiveCheckState = "not_required";
  if (claim.liveCheckRequired) {
    if (!latest) state = "required_unsatisfied";
    else if (latest.expiresAt && latest.expiresAt <= now) state = "expired";
    else state = "satisfied";
  }
  return {
    claimId,
    state,
    reason: claim.liveCheckReason,
    suggestedChecks: claim.suggestedChecks,
    lastSatisfiedAt: latest?.satisfiedAt ?? null,
    expiresAt: latest?.expiresAt ?? null,
  };
}

/** All claims currently requiring a live check that is unsatisfied or expired. */
export function listUnsatisfiedLiveChecks(db: DatabaseSync, now: string = nowIso()): Claim[] {
  const required = listClaims(db, { liveCheckRequired: true, limit: 500 });
  return required.filter((c) => {
    const status = getLiveCheckStatus(db, c.id, now);
    return status.state === "required_unsatisfied" || status.state === "expired";
  });
}
