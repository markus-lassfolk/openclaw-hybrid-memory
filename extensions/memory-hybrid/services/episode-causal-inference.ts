/**
 * Episode causal link inference at write time (Issue #1903).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { rowToEpisode } from "../backends/facts-db/episodes.js";
import { episodeCandidateScopeClause, scopedRowMatchesFilter } from "../backends/facts-db/scope-sql.js";
import type { Episode, EpisodeOutcome, ScopeFilter } from "../types/memory.js";

export type CausalLinkCandidate = {
  episodeId: string;
  eventPreview: string;
  outcome: EpisodeOutcome;
  score: number;
  confidence: number;
  scoreBreakdown: {
    entityOverlap: number;
    tagOverlap: number;
    recency: number;
    outcomeAsymmetry: number;
  };
};

export type InferCausalLinksResult = {
  advisory: CausalLinkCandidate[];
  persisted: CausalLinkCandidate[];
};

const ADVISORY_THRESHOLD = 0.3;
const PERSIST_THRESHOLD = 0.5;
const LOOKBACK_DAYS = 30;
const MAX_CANDIDATES = 100;
const ENTITY_FREQUENCY_CAP = 0.3;
const OUTCOME_ASYMMETRY_MAX_HOURS = 48;

function preview(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function daysBetween(fromSec: number, toSec: number): number {
  return Math.max(0, (toSec - fromSec) / 86400);
}

function sharedElements(a: string[], b: string[]): string[] {
  const setB = new Set(b.map((x) => x.toLowerCase()));
  return a.filter((x) => setB.has(x.toLowerCase()));
}

function extractEpisodeSignals(
  db: DatabaseSync,
  episode: Episode,
): { entities: string[]; tags: string[]; relatedFactIds: string[] } {
  const tags = episode.tags ?? [];
  const relatedFactIds = episode.relatedFactIds ?? [];
  const entities: string[] = [];
  if (episode.procedureId) entities.push(`procedure:${episode.procedureId}`);

  for (const factId of relatedFactIds.slice(0, 20)) {
    const row = db.prepare("SELECT entity FROM facts WHERE id = ?").get(factId) as
      | { entity: string | null }
      | undefined;
    if (row?.entity?.trim()) entities.push(row.entity.trim().toLowerCase());
  }

  return { entities: [...new Set(entities)], tags, relatedFactIds };
}

function computeEntityIdfWeight(entity: string, frequency: number, total: number): number {
  if (total === 0) return 0;
  const freq = frequency / total;
  if (freq > ENTITY_FREQUENCY_CAP) return 0.1;
  return Math.min(0.4, 0.4 * (1 - freq / ENTITY_FREQUENCY_CAP));
}

function scoreCandidate(
  newEpisode: Episode,
  candidate: Episode,
  newSignals: ReturnType<typeof extractEpisodeSignals>,
  candSignals: ReturnType<typeof extractEpisodeSignals>,
  entityFreq: Map<string, number>,
  totalEpisodes: number,
): { score: number; breakdown: CausalLinkCandidate["scoreBreakdown"] } {
  const sharedEntities = sharedElements(newSignals.entities, candSignals.entities);
  let entityOverlap = 0;
  for (const e of sharedEntities) {
    entityOverlap += computeEntityIdfWeight(e, entityFreq.get(e) ?? 0, totalEpisodes);
  }
  entityOverlap = Math.min(0.4, entityOverlap);

  const sharedTags = sharedElements(newSignals.tags, candSignals.tags);
  const tagOverlap = Math.min(0.3, sharedTags.length * 0.1);

  const days = daysBetween(candidate.timestamp, newEpisode.timestamp);
  const recency = Math.max(0, 0.3 - days * 0.05);

  let outcomeAsymmetry = 0;
  const outcomesDiverge =
    (candidate.outcome === "success" && newEpisode.outcome === "failure") ||
    (candidate.outcome === "failure" && newEpisode.outcome === "success");
  if (outcomesDiverge) {
    const hoursApart = (newEpisode.timestamp - candidate.timestamp) / 3600;
    const sharedFacts = sharedElements(newSignals.relatedFactIds, candSignals.relatedFactIds);
    if (hoursApart <= OUTCOME_ASYMMETRY_MAX_HOURS && sharedFacts.length > 0) {
      outcomeAsymmetry = 0.2;
    }
  }

  const score = entityOverlap + tagOverlap + recency + outcomeAsymmetry;
  return {
    score,
    breakdown: { entityOverlap, tagOverlap, recency, outcomeAsymmetry },
  };
}

function loadEntityFrequencies(db: DatabaseSync, sinceSec: number): { freq: Map<string, number>; total: number } {
  const rows = db
    .prepare("SELECT related_fact_ids, procedure_id, tags FROM episodes WHERE created_at >= ?")
    .all(sinceSec) as Array<{ related_fact_ids: string | null; procedure_id: string | null; tags: string | null }>;

  const freq = new Map<string, number>();
  for (const row of rows) {
    const entities: string[] = [];
    if (row.procedure_id) entities.push(`procedure:${row.procedure_id}`);
    const factIds = row.related_fact_ids ? (JSON.parse(row.related_fact_ids) as string[]) : [];
    for (const factId of factIds.slice(0, 10)) {
      const f = db.prepare("SELECT entity FROM facts WHERE id = ?").get(factId) as
        | { entity: string | null }
        | undefined;
      if (f?.entity?.trim()) entities.push(f.entity.trim().toLowerCase());
    }
    for (const e of new Set(entities)) {
      freq.set(e, (freq.get(e) ?? 0) + 1);
    }
  }
  return { freq, total: rows.length };
}

function reinforceExistingLink(db: DatabaseSync, sourceId: string, targetId: string, nowSec: number): void {
  const row = db
    .prepare(
      "SELECT id, confidence FROM episode_causal_links WHERE source_episode_id = ? AND target_episode_id = ?",
    )
    .get(sourceId, targetId) as { id: string; confidence: number } | undefined;
  if (!row) return;
  const bumped = Math.min(1, row.confidence * 1.1);
  db.prepare(
    "UPDATE episode_causal_links SET confidence = ?, last_reinforced_at = ? WHERE id = ?",
  ).run(bumped, nowSec, row.id);
}

function persistLink(
  db: DatabaseSync,
  sourceEpisodeId: string,
  targetEpisodeId: string,
  confidence: number,
  breakdown: CausalLinkCandidate["scoreBreakdown"],
  nowSec: number,
): void {
  const existing = db
    .prepare(
      "SELECT id FROM episode_causal_links WHERE source_episode_id = ? AND target_episode_id = ?",
    )
    .get(sourceEpisodeId, targetEpisodeId) as { id: string } | undefined;
  if (existing) {
    reinforceExistingLink(db, sourceEpisodeId, targetEpisodeId, nowSec);
    return;
  }
  db.prepare(
    `INSERT INTO episode_causal_links (id, source_episode_id, target_episode_id, confidence, score_breakdown, last_reinforced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    sourceEpisodeId,
    targetEpisodeId,
    confidence,
    JSON.stringify(breakdown),
    nowSec,
    nowSec,
  );
}

export function inferCausalLinks(db: DatabaseSync, newEpisode: Episode): InferCausalLinksResult {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - LOOKBACK_DAYS * 86400;
  const { freq, total } = loadEntityFrequencies(db, sinceSec);
  const newSignals = extractEpisodeSignals(db, newEpisode);
  const { clause: scopeClause, params: scopeParams } = episodeCandidateScopeClause(newEpisode);

  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE created_at >= ? AND id != ?${scopeClause} ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(sinceSec, newEpisode.id, ...scopeParams, MAX_CANDIDATES * 2) as Array<Record<string, unknown>>;

  const advisory: CausalLinkCandidate[] = [];
  const persisted: CausalLinkCandidate[] = [];

  let evaluated = 0;
  for (const row of rows) {
    if (evaluated >= MAX_CANDIDATES) break;
    const candidate = rowToEpisode(row);
    const candSignals = extractEpisodeSignals(db, candidate);

    const hasOverlap =
      sharedElements(newSignals.entities, candSignals.entities).length > 0 ||
      sharedElements(newSignals.tags, candSignals.tags).length > 0 ||
      (newEpisode.procedureId && newEpisode.procedureId === candidate.procedureId);

    if (!hasOverlap) continue;
    evaluated++;

    const { score, breakdown } = scoreCandidate(
      newEpisode,
      candidate,
      newSignals,
      candSignals,
      freq,
      Math.max(total, 1),
    );
    if (score < ADVISORY_THRESHOLD) continue;

    const item: CausalLinkCandidate = {
      episodeId: candidate.id,
      eventPreview: preview(candidate.event),
      outcome: candidate.outcome,
      score,
      confidence: score,
      scoreBreakdown: breakdown,
    };

    if (score >= ADVISORY_THRESHOLD) advisory.push(item);
    if (score >= PERSIST_THRESHOLD) {
      persistLink(db, candidate.id, newEpisode.id, score, breakdown, nowSec);
      persisted.push(item);
    }
  }

  advisory.sort((a, b) => b.score - a.score);
  persisted.sort((a, b) => b.score - a.score);
  return { advisory, persisted };
}

/** Multiplicative confidence decay for nightly maintenance (Issue #1903). */
export function decayEpisodeCausalLinks(db: DatabaseSync): { updated: number; deleted: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare("SELECT id, confidence, last_reinforced_at, created_at FROM episode_causal_links")
    .all() as Array<{
    id: string;
    confidence: number;
    last_reinforced_at: number | null;
    created_at: number;
  }>;

  let updated = 0;
  let deleted = 0;
  for (const row of rows) {
    const anchor = row.last_reinforced_at ?? row.created_at;
    const days = daysBetween(anchor, nowSec);
    const factor = 0.5 ** (days / 30);
    const newConf = row.confidence * factor;
    if (newConf < 0.2) {
      db.prepare("DELETE FROM episode_causal_links WHERE id = ?").run(row.id);
      deleted++;
    } else if (Math.abs(newConf - row.confidence) > 0.001) {
      db.prepare("UPDATE episode_causal_links SET confidence = ? WHERE id = ?").run(newConf, row.id);
      updated++;
    }
  }
  return { updated, deleted };
}

export type CausalChainItem = {
  episodeId: string;
  eventPreview: string;
  outcome: EpisodeOutcome;
  linkType: "inferred" | "explicit";
  confidence: number;
  depth: number;
};

export function buildEpisodeCausalChain(
  db: DatabaseSync,
  episodeId: string,
  depth = 5,
  includeExplicitOnly = false,
  scopeFilter?: ScopeFilter | null,
): CausalChainItem[] {
  const startRow = db.prepare("SELECT scope, scope_target FROM episodes WHERE id = ?").get(episodeId) as
    | { scope: string; scope_target: string | null }
    | undefined;
  if (!startRow) return [];
  if (
    !scopedRowMatchesFilter(
      startRow.scope as Episode["scope"],
      startRow.scope_target,
      scopeFilter,
    )
  ) {
    return [];
  }

  const visited = new Set<string>();
  const bestByEpisode = new Map<string, CausalChainItem>();
  const queue: Array<{ id: string; depth: number }> = [{ id: episodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth: d } = queue.shift()!;
    if (d >= depth) continue;

    if (!includeExplicitOnly) {
      const inferred = db
        .prepare(
          `SELECT ecl.*, e.event, e.outcome, e.scope, e.scope_target FROM episode_causal_links ecl
           JOIN episodes e ON e.id = ecl.source_episode_id
           WHERE ecl.target_episode_id = ? AND ecl.confidence >= 0.2`,
        )
        .all(id) as Array<Record<string, unknown>>;

      for (const row of inferred) {
        const sourceId = row.source_episode_id as string;
        if (visited.has(sourceId)) continue;
        const epScope = row.scope as Episode["scope"] | undefined;
        const epTarget = row.scope_target as string | null | undefined;
        if (!scopedRowMatchesFilter(epScope ?? "global", epTarget, scopeFilter)) continue;
        const conf = row.confidence as number;
        const item: CausalChainItem = {
          episodeId: sourceId,
          eventPreview: preview(String(row.event ?? "")),
          outcome: String(row.outcome ?? "unknown") as EpisodeOutcome,
          linkType: "inferred",
          confidence: conf,
          depth: d + 1,
        };
        const prev = bestByEpisode.get(sourceId);
        if (!prev || item.confidence > prev.confidence) bestByEpisode.set(sourceId, item);
        queue.push({ id: sourceId, depth: d + 1 });
      }
    }

    const explicit = db
      .prepare(
        `SELECT er.*, e.event, e.outcome, e.scope, e.scope_target FROM episode_relations er
         JOIN episodes e ON e.id = er.episode_id
         WHERE er.target_id = ? AND er.relation_type IN ('CAUSED_BY', 'PART_OF')`,
      )
      .all(id) as Array<Record<string, unknown>>;

    for (const row of explicit) {
      const sourceId = row.episode_id as string;
      if (visited.has(sourceId)) continue;
      const epScope = row.scope as Episode["scope"] | undefined;
      const epTarget = row.scope_target as string | null | undefined;
      if (!scopedRowMatchesFilter(epScope ?? "global", epTarget, scopeFilter)) continue;
      const strength = (row.strength as number) ?? 0.8;
      const item: CausalChainItem = {
        episodeId: sourceId,
        eventPreview: preview(String(row.event ?? "")),
        outcome: String(row.outcome ?? "unknown") as EpisodeOutcome,
        linkType: "explicit",
        confidence: strength,
        depth: d + 1,
      };
      const prev = bestByEpisode.get(sourceId);
      if (!prev || item.confidence > prev.confidence) bestByEpisode.set(sourceId, item);
      queue.push({ id: sourceId, depth: d + 1 });
    }

    visited.add(id);
  }

  return [...bestByEpisode.values()].sort((a, b) => b.depth - a.depth || b.confidence - a.confidence);
}
