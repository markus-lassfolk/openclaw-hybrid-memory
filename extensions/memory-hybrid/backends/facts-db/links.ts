import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { emitMemoryEvent, type MemoryLinkEventPayload } from "../../services/memory-events.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";

import type { MemoryLinkType } from "./types.js";

/** Insert a link row WITHOUT emitting an event. Callers emit after their transaction commits. */
function insertLinkRow(
  db: DatabaseSync,
  id: string,
  sourceFactId: string,
  targetFactId: string,
  linkType: MemoryLinkType,
  clampedStrength: number,
  createdAt: number,
): void {
  db.prepare(
    "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at, strength_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, sourceFactId, targetFactId, linkType, clampedStrength, createdAt, createdAt);
}

export function createLink(
  db: DatabaseSync,
  sourceFactId: string,
  targetFactId: string,
  linkType: MemoryLinkType,
  strength = 1.0,
): string {
  if ((linkType as string) === "DERIVED_FROM") {
    throw new Error("DERIVED_FROM provenance is stored on facts.provenance_json, not memory_links");
  }
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const clampedStrength = Math.max(0, Math.min(1, strength));
  insertLinkRow(db, id, sourceFactId, targetFactId, linkType, clampedStrength, now);
  // Live Memory Graph overlay: a new edge appeared (deferred + isolated, never breaks the write).
  emitMemoryEvent("linkCreated", {
    link: { id, sourceId: sourceFactId, targetId: targetFactId, linkType, strength: clampedStrength, createdAt: now },
  });
  return id;
}

export function createOrStrengthenRelatedLink(
  db: DatabaseSync,
  factIdA: string,
  factIdB: string,
  deltaStrength = 0.1,
): void {
  if (factIdA === factIdB) return;
  const [source, target] = factIdA < factIdB ? [factIdA, factIdB] : [factIdB, factIdA];

  // Captured inside the transaction, emitted only AFTER it commits — so a rolled-back INSERT/UPDATE
  // never broadcasts a phantom edge to the overlay. Both branches now defer (the create branch used
  // to call createLink() which emitted mid-transaction; that was rollback-unsafe). Held on an object
  // (not a bare `let`) so the `tx()` call resets narrowing and TS keeps the declared type.
  const box: { value: { event: MemoryLinkEventPayload; kind: "linkCreated" | "linkUpdated" } | null } = { value: null };

  // memory_links has no UNIQUE constraint on (source_fact_id, target_fact_id, link_type), so the
  // read-then-write below must be atomic — otherwise two concurrent writers (e.g. an interactive
  // store racing a background consolidation/enrichment pass) can both see "no existing row" and
  // both INSERT, creating duplicate parallel edges that corrupt strength/degree accounting.
  const tx = createTransaction(
    db,
    () => {
      const existing = db
        .prepare(
          `SELECT id, strength, created_at FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
        )
        .get(source, target) as { id: string; strength: number; created_at: number } | undefined;

      const newStrength = Math.min(1, (existing?.strength ?? 0) + deltaStrength);
      if (existing) {
        db.prepare("UPDATE memory_links SET strength = ?, strength_updated_at = ? WHERE id = ?").run(
          newStrength,
          Math.floor(Date.now() / 1000),
          existing.id,
        );
        box.value = {
          kind: "linkUpdated",
          event: {
            id: existing.id,
            sourceId: source,
            targetId: target,
            linkType: "RELATED_TO",
            strength: newStrength,
            createdAt: existing.created_at,
          },
        };
      } else {
        const id = randomUUID();
        const now = Math.floor(Date.now() / 1000);
        insertLinkRow(db, id, source, target, "RELATED_TO", newStrength, now);
        box.value = {
          kind: "linkCreated",
          event: {
            id,
            sourceId: source,
            targetId: target,
            linkType: "RELATED_TO",
            strength: newStrength,
            createdAt: now,
          },
        };
      }
    },
    "IMMEDIATE",
  );
  tx();
  if (box.value) {
    emitMemoryEvent(box.value.kind, { link: box.value.event });
  }
}

/**
 * Update a link's type and/or strength by id (curation). Emits `linkUpdated` for the live overlay.
 * Returns true when a row changed.
 */
export function updateLink(
  db: DatabaseSync,
  id: string,
  changes: { linkType?: MemoryLinkType; strength?: number },
): boolean {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (changes.linkType !== undefined) {
    if ((changes.linkType as string) === "DERIVED_FROM") {
      throw new Error("DERIVED_FROM provenance is stored on facts.provenance_json, not memory_links");
    }
    sets.push("link_type = ?");
    params.push(changes.linkType);
  }
  if (changes.strength !== undefined) {
    sets.push("strength = ?");
    params.push(Math.max(0, Math.min(1, changes.strength)));
    sets.push("strength_updated_at = ?");
    params.push(Math.floor(Date.now() / 1000));
  }
  if (sets.length === 0) return false;
  params.push(id);
  const result = db.prepare(`UPDATE memory_links SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (result.changes > 0) {
    const row = db
      .prepare(
        "SELECT id, source_fact_id, target_fact_id, link_type, strength, created_at FROM memory_links WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          source_fact_id: string;
          target_fact_id: string;
          link_type: string;
          strength: number;
          created_at: number;
        }
      | undefined;
    if (row) {
      emitMemoryEvent("linkUpdated", {
        link: {
          id: row.id,
          sourceId: row.source_fact_id,
          targetId: row.target_fact_id,
          linkType: row.link_type,
          strength: row.strength,
          createdAt: row.created_at,
        },
      });
    }
  }
  return result.changes > 0;
}

export function strengthenRelatedLinksBatch(db: DatabaseSync, pairs: [string, string][], deltaStrength = 0.1): void {
  if (pairs.length === 0) return;
  const selectStmt = db.prepare(
    `SELECT id, strength FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
  );
  const updateStmt = db.prepare("UPDATE memory_links SET strength = ?, strength_updated_at = ? WHERE id = ?");
  const insertStmt = db.prepare(
    `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at, strength_updated_at) VALUES (?, ?, ?, 'RELATED_TO', ?, ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  const tx = createTransaction(db, () => {
    for (const [factIdA, factIdB] of pairs) {
      if (factIdA === factIdB) continue;
      const [source, target] = factIdA < factIdB ? [factIdA, factIdB] : [factIdB, factIdA];
      const existing = selectStmt.get(source, target) as { id: string; strength: number } | undefined;
      const newStrength = Math.max(0, Math.min(1, (existing?.strength ?? 0) + deltaStrength));
      if (existing) {
        updateStmt.run(newStrength, now, existing.id);
      } else {
        insertStmt.run(randomUUID(), source, target, newStrength, now, now);
      }
    }
  });
  tx();
}

/**
 * "Use it or lose it" for Hebbian edges: exponentially decay RELATED_TO link strength by the time
 * since its last strength write, then hard-prune links that fell below the floor. Typed/curated
 * links (SUPERSEDES, CONTRADICTS, PART_OF, ...) never decay — they encode structure, not usage.
 *
 * Each decayed row re-anchors strength_updated_at = now, so repeated runs compose to exactly
 * 0.5^(totalDays/halfLifeDays) regardless of run cadence.
 */
export function decayLinkStrengths(
  db: DatabaseSync,
  opts: { halfLifeDays: number; floor: number; nowSec?: number },
): { decayed: number; pruned: number } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const halfLifeSec = Math.max(1, opts.halfLifeDays) * 86_400;
  // Skip sub-hour deltas: repeated cycle runs shouldn't churn rows for negligible decay.
  const minDeltaSec = 3_600;
  const rows = db
    .prepare(
      `SELECT id, strength, COALESCE(strength_updated_at, created_at) AS anchored_at
         FROM memory_links WHERE link_type = 'RELATED_TO'`,
    )
    .all() as Array<{ id: string; strength: number; anchored_at: number }>;

  const updateStmt = db.prepare("UPDATE memory_links SET strength = ?, strength_updated_at = ? WHERE id = ?");
  const toPrune: string[] = [];
  let decayed = 0;
  const tx = createTransaction(db, () => {
    for (const row of rows) {
      const deltaSec = nowSec - (row.anchored_at ?? nowSec);
      if (deltaSec < minDeltaSec) continue;
      const next = row.strength * 0.5 ** (deltaSec / halfLifeSec);
      if (next < opts.floor) {
        toPrune.push(row.id);
      } else {
        updateStmt.run(next, nowSec, row.id);
        decayed++;
      }
    }
    if (toPrune.length > 0) {
      const placeholders = toPrune.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_links WHERE id IN (${placeholders})`).run(...toPrune);
    }
  });
  tx();
  return { decayed, pruned: toPrune.length };
}

export function getLinksFrom(
  db: DatabaseSync,
  factId: string,
): Array<{ id: string; targetFactId: string; linkType: string; strength: number }> {
  const rows = db
    .prepare("SELECT id, target_fact_id, link_type, strength FROM memory_links WHERE source_fact_id = ?")
    .all(factId) as Array<{ id: string; target_fact_id: string; link_type: string; strength: number }>;
  return rows.map((r) => ({
    id: r.id,
    targetFactId: r.target_fact_id,
    linkType: r.link_type,
    strength: r.strength,
  }));
}

export function getLinksTo(
  db: DatabaseSync,
  factId: string,
): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }> {
  const rows = db
    .prepare("SELECT id, source_fact_id, link_type, strength FROM memory_links WHERE target_fact_id = ?")
    .all(factId) as Array<{ id: string; source_fact_id: string; link_type: string; strength: number }>;
  return rows.map((r) => ({
    id: r.id,
    sourceFactId: r.source_fact_id,
    linkType: r.link_type,
    strength: r.strength,
  }));
}

/** Optional out-params for hub-guard observability (Issue #1192). */
export type GraphConnectedStats = {
  nodesConsidered: number;
  nodesSkipped: number;
  hubsSkipped: number;
};

/**
 * Refresh denormalized `out_degree` / `in_degree` columns on `facts` (#1192). Counts only
 * traversable links — `CONTRADICTS` and `DERIVED_FROM` are excluded so the values match
 * what the BFS hub guard uses. Called from the dream-cycle so the per-traversal `COUNT(*)`
 * fallback path is rarely hit on warm stores.
 *
 * Returns the number of facts whose degree was updated (rows in `facts`).
 */
export function refreshFactDegrees(db: DatabaseSync): { updated: number } {
  const tx = createTransaction(db, () => {
    db.exec(`
      UPDATE facts SET
        out_degree = COALESCE(
          (SELECT COUNT(*) FROM memory_links ml
           WHERE ml.source_fact_id = facts.id
             AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')),
          0
        ),
        in_degree = COALESCE(
          (SELECT COUNT(*) FROM memory_links ml
           WHERE ml.target_fact_id = facts.id
             AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')),
          0
        )
    `);
  });
  tx();
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM facts").get() as { cnt: number } | undefined;
  return { updated: Number(row?.cnt ?? 0) };
}

export function getConnectedFactIds(
  db: DatabaseSync,
  factIds: string[],
  maxDepth: number,
  options?: { hubDegreeCap?: number | null; stats?: GraphConnectedStats },
): string[] {
  if (factIds.length === 0 || maxDepth < 1) return [...factIds];

  // `null` means no cap; only fall back to 500 when the option is omitted (`undefined`).
  const hubDegreeCap = options?.hubDegreeCap === undefined ? 500 : options.hubDegreeCap;
  const stats = options?.stats;
  const seen = new Set(factIds);
  let frontier = [...factIds];

  let outStmt = db.prepare(
    `SELECT target_fact_id AS id FROM memory_links WHERE source_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') ORDER BY strength DESC, created_at DESC LIMIT ?`,
  );
  let inStmt = db.prepare(
    `SELECT source_fact_id AS id FROM memory_links WHERE target_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') ORDER BY strength DESC, created_at DESC LIMIT ?`,
  );
  // Exclude superseded (corrected/replaced) facts from traversal — mirrors
  // expandGraphWithCTE's `f.superseded_at IS NULL` join, for the same reason: a superseded fact
  // must not serve as an intermediate hop or be returned as a connected result, or a correction
  // can be silently undone by having the stale fact resurface via its surviving graph link.
  // Falls back to the unfiltered statements above when `facts` doesn't exist (e.g. minimal
  // in-memory tests), matching the `denormDegreeStmt` fallback pattern below.
  try {
    outStmt = db.prepare(
      `SELECT ml.target_fact_id AS id FROM memory_links ml JOIN facts f ON f.id = ml.target_fact_id WHERE ml.source_fact_id = ? AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') AND f.superseded_at IS NULL ORDER BY ml.strength DESC, ml.created_at DESC LIMIT ?`,
    );
    inStmt = db.prepare(
      `SELECT ml.source_fact_id AS id FROM memory_links ml JOIN facts f ON f.id = ml.source_fact_id WHERE ml.target_fact_id = ? AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') AND f.superseded_at IS NULL ORDER BY ml.strength DESC, ml.created_at DESC LIMIT ?`,
    );
  } catch {
    // facts table absent; keep the unfiltered statements above.
  }
  // #1192: prefer the denormalized columns when present (refreshed by the dream-cycle).
  // Falls back to the legacy COUNT(*) path when columns are missing or zero (which can
  // happen on a brand-new store before the first dream-cycle has run).
  // `prepare` fails if `facts` does not exist (e.g. minimal in-memory tests); skip denorm then.
  let denormDegreeStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
  try {
    denormDegreeStmt = db.prepare(
      "SELECT COALESCE(out_degree, 0) + COALESCE(in_degree, 0) AS degree FROM facts WHERE id = ? LIMIT 1",
    );
  } catch {
    denormDegreeStmt = null;
  }
  const fallbackDegreeStmt = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_links WHERE source_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
       (SELECT COUNT(*) FROM memory_links WHERE target_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) AS degree`,
  );
  const degreeCache = new Map<string, number>();
  const liveDegreeCache = new Map<string, number>();
  const degreeOf = (id: string): number => {
    const cached = degreeCache.get(id);
    if (cached != null) return cached;
    let degree = 0;
    try {
      if (denormDegreeStmt) {
        const row = denormDegreeStmt.get(id) as { degree: number } | undefined;
        degree = Number(row?.degree ?? 0);
      }
    } catch {
      degree = 0;
    }
    if (degree === 0) {
      const row = fallbackDegreeStmt.get(id, id) as { degree: number } | undefined;
      degree = Number(row?.degree ?? 0);
    }
    degreeCache.set(id, degree);
    return degree;
  };
  /** Live in+out traversable edge count — safe for sizing SQL LIMIT when hub cap is off (see #1192). */
  const liveCombinedDegree = (id: string): number => {
    const cached = liveDegreeCache.get(id);
    if (cached != null) return cached;
    const row = fallbackDegreeStmt.get(id, id) as { degree: number } | undefined;
    const degree = Number(row?.degree ?? 0);
    liveDegreeCache.set(id, degree);
    return degree;
  };

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const degree = degreeOf(id);
      if (hubDegreeCap != null && degree > hubDegreeCap) {
        if (stats) {
          stats.hubsSkipped += 1;
          stats.nodesSkipped += degree;
        }
        continue;
      }
      // No hub cap: size LIMIT from live edge counts. Denormalized totals can lag dream-cycle
      // refreshes; using them here could truncate neighbours even though `out+in` is a valid upper
      // bound per direction when fresh. With hub cap, +1 avoids edge truncation vs the skip threshold.
      const limit = hubDegreeCap == null ? Math.max(liveCombinedDegree(id), 1) : Math.max(hubDegreeCap + 1, 1);
      const neighbours = [
        ...(outStmt.all(id, limit) as Array<{ id: string }>),
        ...(inStmt.all(id, limit) as Array<{ id: string }>),
      ];
      if (stats) stats.nodesConsidered += neighbours.length;
      for (const row of neighbours) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        nextFrontier.push(row.id);
      }
    }
    frontier = nextFrontier;
  }

  return [...seen];
}

/**
 * Perform graph expansion using a recursive CTE, returning expanded nodes with hop count and path info.
 * This replaces the iterative N+1 BFS pattern with a single optimized SQL query.
 *
 * @param db - The database connection
 * @param seedFactIds - Array of seed fact IDs to start expansion from
 * @param maxDepth - Maximum traversal depth
 * @returns Array of expanded nodes with factId, seedId, hopCount, and path (JSON array of link steps)
 */
export function expandGraphWithCTE(
  db: DatabaseSync,
  seedFactIds: string[],
  maxDepth: number,
  options?: {
    asOf?: number;
    scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
    hubDegreeCap?: number | null;
  },
): Array<{
  factId: string;
  seedId: string;
  hopCount: number;
  path: string; // JSON array of link steps
}> {
  if (seedFactIds.length === 0 || maxDepth < 1) {
    return seedFactIds.map((id) => ({
      factId: id,
      seedId: id,
      hopCount: 0,
      path: "[]",
    }));
  }

  const asOf = options?.asOf ?? null;
  const scopeFilter = options?.scopeFilter;
  const hubDegreeCap = options?.hubDegreeCap === undefined ? 500 : options.hubDegreeCap;
  // The facts join (and superseded_at check) must always apply, not just when asOf/scopeFilter
  // are supplied — otherwise the recursive CTE traverses raw memory_links with zero regard for
  // fact validity, letting a superseded (corrected/replaced) fact serve as an intermediate hop
  // or be returned as an expansion result even though direct search correctly excludes it.
  const factJoinOut = "JOIN facts f ON f.id = ml.target_fact_id";
  const factJoinIn = "JOIN facts f ON f.id = ml.source_fact_id";
  const filterParamsOut: SQLInputValue[] = [];
  const filterParamsIn: SQLInputValue[] = [];

  let baseWhere = " AND f.superseded_at IS NULL";
  if (asOf != null) {
    baseWhere += " AND COALESCE(f.valid_from, f.created_at) <= ? AND (f.valid_until IS NULL OR f.valid_until > ?)";
    filterParamsOut.push(asOf, asOf);
    filterParamsIn.push(asOf, asOf);
  }
  if (scopeFilter && (scopeFilter.userId || scopeFilter.agentId || scopeFilter.sessionId)) {
    baseWhere += ` AND (f.scope = 'global' OR (f.scope = 'user' AND f.scope_target = ?) OR (f.scope = 'agent' AND f.scope_target = ?) OR (f.scope = 'session' AND f.scope_target = ?))`;
    filterParamsOut.push(scopeFilter.userId ?? null, scopeFilter.agentId ?? null, scopeFilter.sessionId ?? null);
    filterParamsIn.push(scopeFilter.userId ?? null, scopeFilter.agentId ?? null, scopeFilter.sessionId ?? null);
  }
  const factWhereOut = baseWhere;
  const factWhereIn = baseWhere;

  // Use recursive CTE to traverse the graph in a single query.
  // We track: current node, seed that originated this path, hop count, and JSON path.
  // #1192: prefer the denormalized `out_degree`/`in_degree` columns on `facts` (refreshed by the
  // dream-cycle) so the per-traversal `COUNT(*)` (O(edges) per hop) is avoided. The COALESCE
  // fallback ensures correctness on stores whose dream-cycle has not yet refreshed the columns
  // (or for legacy data with NULL/zero degrees) by checking `> 0` and only then short-circuiting.
  // Hub degree cap applies to the neighbor being entered (outgoing → `ml.target_fact_id`, incoming →
  // `ml.source_fact_id`), matching `getConnectedFactIds` which skips expanding from overloaded nodes.
  const degreeCheckOut =
    hubDegreeCap == null
      ? ""
      : `AND (
        SELECT
          CASE WHEN facts.out_degree IS NOT NULL AND facts.in_degree IS NOT NULL
            THEN (COALESCE(facts.out_degree, 0) + COALESCE(facts.in_degree, 0))
            ELSE (
              (SELECT COUNT(*) FROM memory_links sub WHERE sub.source_fact_id = ml.target_fact_id AND sub.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
              (SELECT COUNT(*) FROM memory_links sub WHERE sub.target_fact_id = ml.target_fact_id AND sub.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM'))
            )
          END
        FROM facts WHERE id = ml.target_fact_id
      ) <= ?`;
  const degreeCheckIn =
    hubDegreeCap == null
      ? ""
      : `AND (
        SELECT
          CASE WHEN facts.out_degree IS NOT NULL AND facts.in_degree IS NOT NULL
            THEN (COALESCE(facts.out_degree, 0) + COALESCE(facts.in_degree, 0))
            ELSE (
              (SELECT COUNT(*) FROM memory_links sub WHERE sub.source_fact_id = ml.source_fact_id AND sub.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
              (SELECT COUNT(*) FROM memory_links sub WHERE sub.target_fact_id = ml.source_fact_id AND sub.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM'))
            )
          END
        FROM facts WHERE id = ml.source_fact_id
      ) <= ?`;
  const query = `
    WITH RECURSIVE graph_expansion(
      fact_id,
      seed_id,
      hop_count,
      path_json,
      visited_ids
    ) AS (
      -- Base case: seed facts at hop 0
      SELECT
        value AS fact_id,
        value AS seed_id,
        0 AS hop_count,
        '[]' AS path_json,
        ',' || value || ',' AS visited_ids
      FROM json_each(?)

      UNION ALL

      -- Recursive case: expand from frontier (outgoing links)
      SELECT
        ml.target_fact_id AS fact_id,
        ge.seed_id,
        ge.hop_count + 1 AS hop_count,
        json_insert(
          ge.path_json,
          '$[#]',
          json_object(
            'fromFactId', ge.fact_id,
            'toFactId', ml.target_fact_id,
            'linkType', ml.link_type,
            'strength', ml.strength
          )
        ) AS path_json,
        ge.visited_ids || ml.target_fact_id || ',' AS visited_ids
      FROM graph_expansion ge
      JOIN memory_links ml ON ml.source_fact_id = ge.fact_id
      ${factJoinOut}
      WHERE
        ge.hop_count < ?
        AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')
        -- Avoid cycles: only visit each node once per path
        AND ge.visited_ids NOT LIKE '%,' || ml.target_fact_id || ',%'
        ${degreeCheckOut}
        ${factWhereOut}

      UNION ALL

      -- Recursive case: expand from frontier (incoming links)
      SELECT
        ml.source_fact_id AS fact_id,
        ge.seed_id,
        ge.hop_count + 1 AS hop_count,
        json_insert(
          ge.path_json,
          '$[#]',
          json_object(
            'fromFactId', ge.fact_id,
            'toFactId', ml.source_fact_id,
            'linkType', ml.link_type,
            'strength', ml.strength
          )
        ) AS path_json,
        ge.visited_ids || ml.source_fact_id || ',' AS visited_ids
      FROM graph_expansion ge
      JOIN memory_links ml ON ml.target_fact_id = ge.fact_id
      ${factJoinIn}
      WHERE
        ge.hop_count < ?
        AND ml.link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')
        -- Avoid cycles: only visit each node once per path
        AND ge.visited_ids NOT LIKE '%,' || ml.source_fact_id || ',%'
        ${degreeCheckIn}
        ${factWhereIn}
    ),
    -- Aggregate to find shortest path to each node
    shortest_paths AS (
      SELECT
        fact_id,
        seed_id,
        hop_count,
        path_json,
        ROW_NUMBER() OVER (PARTITION BY fact_id ORDER BY hop_count ASC) AS rn
      FROM graph_expansion
    )
    SELECT
      fact_id,
      seed_id,
      hop_count,
      path_json AS path
    FROM shortest_paths
    WHERE rn = 1
    ORDER BY hop_count ASC, fact_id ASC
  `;

  const hubParams = hubDegreeCap == null ? [] : [hubDegreeCap, hubDegreeCap];
  const rows = db
    .prepare(query)
    .all(
      JSON.stringify(seedFactIds),
      maxDepth,
      ...hubParams.slice(0, 1),
      ...filterParamsOut,
      maxDepth,
      ...hubParams.slice(1, 2),
      ...filterParamsIn,
    ) as Array<{
    fact_id: string;
    seed_id: string;
    hop_count: number;
    path: string;
  }>;

  return rows.map((r) => ({
    factId: r.fact_id,
    seedId: r.seed_id,
    hopCount: r.hop_count,
    path: r.path,
  }));
}
