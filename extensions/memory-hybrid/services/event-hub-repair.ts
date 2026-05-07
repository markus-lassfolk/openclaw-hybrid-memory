import type { DatabaseSync } from "node:sqlite";

import { createTransaction } from "../utils/sqlite-transaction.js";

export type EventHubRepairCandidate = {
  factId: string;
  textPreview: string;
  source: string | null;
  entity: string | null;
  tags: string | null;
  provenanceJson: string | null;
  outboundDerivedFrom: number;
  eligibleLinks: number;
  reason: string;
  targetExamples: string[];
};

export type LinkTypeCount = { linkType: string; count: number };

export type EventHubRepairReport = {
  apply: boolean;
  threshold: number;
  before: {
    linkTypes: LinkTypeCount[];
    maxOutboundDerivedFrom: number;
    overThresholdFacts: number;
  };
  candidates: EventHubRepairCandidate[];
  migratedFacts: number;
  deletedLinks: number;
  after?: {
    linkTypes: LinkTypeCount[];
    maxOutboundDerivedFrom: number;
    overThresholdFacts: number;
  };
};

type HubRow = {
  id: string;
  text: string;
  source: string | null;
  entity: string | null;
  tags: string | null;
  provenance_json: string | null;
  cnt: number;
};

type LinkTargetRow = {
  link_id: string;
  target_fact_id: string;
  target_text: string | null;
  target_source: string | null;
  target_key: string | null;
  target_tags: string | null;
  created_at: number;
};

const HEARTBEAT_RE = /\b(session_start|session_end)\b/i;

function linkTypeDistribution(db: DatabaseSync): LinkTypeCount[] {
  return db
    .prepare("SELECT link_type AS linkType, COUNT(*) AS count FROM memory_links GROUP BY link_type ORDER BY count DESC")
    .all() as LinkTypeCount[];
}

function maxOutboundDerivedFrom(db: DatabaseSync): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(cnt), 0) AS max FROM (SELECT COUNT(*) AS cnt FROM memory_links WHERE link_type = 'DERIVED_FROM' GROUP BY source_fact_id)",
    )
    .get() as { max: number } | undefined;
  return Number(row?.max ?? 0);
}

function overThresholdFacts(db: DatabaseSync, threshold: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM (SELECT source_fact_id FROM memory_links WHERE link_type = 'DERIVED_FROM' GROUP BY source_fact_id HAVING COUNT(*) > ?)",
    )
    .get(threshold) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function parseObjectJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function mergeProvenance(
  existingRaw: string | null,
  candidate: EventHubRepairCandidate,
  targets: LinkTargetRow[],
): string {
  const existing = parseObjectJson(existingRaw);
  const existingIds = Array.isArray(existing.sourceFactIds) ? existing.sourceFactIds : [];
  const existingLegacyIds = Array.isArray(existing.legacyDerivedFromFactIds) ? existing.legacyDerivedFromFactIds : [];
  const targetIds = targets.map((target) => target.target_fact_id);
  const legacyDerivedFromFactIds = uniqueStrings([...existingLegacyIds, ...existingIds, ...targetIds]);

  const existingRepairs = Array.isArray(existing.repairs) ? existing.repairs : [];
  const repairRecord = {
    method: "collapse-event-hubs",
    issue: 1185,
    repairedAt: Math.floor(Date.now() / 1000),
    outboundDerivedFromBeforeRepair: candidate.outboundDerivedFrom,
    removedDerivedFromLinks: targets.length,
    reason: candidate.reason,
    targetExamples: targets.slice(0, 10).map((target) => ({
      factId: target.target_fact_id,
      text: (target.target_text ?? "").slice(0, 160),
    })),
  };

  return JSON.stringify({
    ...existing,
    method: typeof existing.method === "string" ? existing.method : "legacy-derived-from-repair",
    legacyDerivedFromFactIds,
    repairs: [...existingRepairs, repairRecord],
  });
}

function candidateReason(row: HubRow, targets: LinkTargetRow[]): string | null {
  const text = row.text ?? "";
  const tags = row.tags ?? "";
  const source = row.source ?? "";
  const targetHeartbeatCount = targets.filter((target) => HEARTBEAT_RE.test(target.target_text ?? "")).length;
  const heartbeatDominant = targets.length > 0 && targetHeartbeatCount / targets.length >= 0.5;

  if (source === "dream-cycle" && HEARTBEAT_RE.test(text)) return "dream-cycle heartbeat consolidated fact";
  if (source === "dream-cycle" && row.entity == null && /^\[consolidated from \d+ events\]/i.test(text)) {
    return "dream-cycle unattributed consolidated event hub";
  }
  if (HEARTBEAT_RE.test(text) && heartbeatDominant) return "heartbeat text with heartbeat DERIVED_FROM targets";
  if (tags.includes("dream-cycle") && heartbeatDominant) return "dream-cycle tagged heartbeat provenance hub";
  return null;
}

export function findEventHubRepairCandidates(db: DatabaseSync, threshold = 500): EventHubRepairCandidate[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.text, f.source, f.entity, f.tags, f.provenance_json, COUNT(ml.id) AS cnt
       FROM facts f
       JOIN memory_links ml ON ml.source_fact_id = f.id AND ml.link_type = 'DERIVED_FROM'
       WHERE f.superseded_at IS NULL
       GROUP BY f.id
       HAVING COUNT(ml.id) > ?
       ORDER BY cnt DESC, f.created_at DESC`,
    )
    .all(threshold) as HubRow[];

  const targetsStmt = db.prepare(
    `SELECT ml.id AS link_id, ml.target_fact_id, tf.text AS target_text, tf.source AS target_source, tf.key AS target_key, tf.tags AS target_tags, ml.created_at
     FROM memory_links ml
     LEFT JOIN facts tf ON tf.id = ml.target_fact_id
     WHERE ml.source_fact_id = ? AND ml.link_type = 'DERIVED_FROM'
     ORDER BY ml.created_at ASC, ml.id ASC`,
  );

  const candidates: EventHubRepairCandidate[] = [];
  for (const row of rows) {
    const targets = targetsStmt.all(row.id) as LinkTargetRow[];
    const reason = candidateReason(row, targets);
    if (!reason) continue;
    candidates.push({
      factId: row.id,
      textPreview: row.text.slice(0, 180),
      source: row.source,
      entity: row.entity,
      tags: row.tags,
      provenanceJson: row.provenance_json,
      outboundDerivedFrom: Number(row.cnt),
      eligibleLinks: targets.length,
      reason,
      targetExamples: targets.slice(0, 5).map((target) => (target.target_text ?? target.target_fact_id).slice(0, 120)),
    });
  }
  return candidates;
}

export function repairEventHubs(
  db: DatabaseSync,
  opts: { threshold?: number; apply?: boolean } = {},
): EventHubRepairReport {
  const threshold = opts.threshold ?? 500;
  const apply = opts.apply ?? false;
  const before = {
    linkTypes: linkTypeDistribution(db),
    maxOutboundDerivedFrom: maxOutboundDerivedFrom(db),
    overThresholdFacts: overThresholdFacts(db, threshold),
  };
  const candidates = findEventHubRepairCandidates(db, threshold);
  let migratedFacts = 0;
  let deletedLinks = 0;

  if (apply && candidates.length > 0) {
    const targetsStmt = db.prepare(
      `SELECT ml.id AS link_id, ml.target_fact_id, tf.text AS target_text, tf.source AS target_source, tf.key AS target_key, tf.tags AS target_tags, ml.created_at
       FROM memory_links ml
       LEFT JOIN facts tf ON tf.id = ml.target_fact_id
       WHERE ml.source_fact_id = ? AND ml.link_type = 'DERIVED_FROM'
       ORDER BY ml.created_at ASC, ml.id ASC`,
    );
    const updateFact = db.prepare("UPDATE facts SET provenance_json = ? WHERE id = ?");
    const deleteLinks = db.prepare("DELETE FROM memory_links WHERE source_fact_id = ? AND link_type = 'DERIVED_FROM'");

    const tx = createTransaction(db, () => {
      for (const candidate of candidates) {
        const targets = targetsStmt.all(candidate.factId) as LinkTargetRow[];
        if (targets.length === 0) continue;
        updateFact.run(mergeProvenance(candidate.provenanceJson, candidate, targets), candidate.factId);
        migratedFacts += 1;
        const result = deleteLinks.run(candidate.factId);
        deletedLinks += Number(result.changes ?? 0);
      }
    });
    tx();
  }

  return {
    apply,
    threshold,
    before,
    candidates,
    migratedFacts,
    deletedLinks,
    after: apply
      ? {
          linkTypes: linkTypeDistribution(db),
          maxOutboundDerivedFrom: maxOutboundDerivedFrom(db),
          overThresholdFacts: overThresholdFacts(db, threshold),
        }
      : undefined,
  };
}
