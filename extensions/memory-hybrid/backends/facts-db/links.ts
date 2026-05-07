import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { createTransaction } from "../../utils/sqlite-transaction.js";

import type { MemoryLinkType } from "./types.js";

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
  db.prepare(
    "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, sourceFactId, targetFactId, linkType, Math.max(0, Math.min(1, strength)), now);
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

  const existing = db
    .prepare(
      `SELECT id, strength FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
    )
    .get(source, target) as { id: string; strength: number } | undefined;

  const newStrength = Math.min(1, (existing?.strength ?? 0) + deltaStrength);
  if (existing) {
    db.prepare("UPDATE memory_links SET strength = ? WHERE id = ?").run(newStrength, existing.id);
  } else {
    createLink(db, source, target, "RELATED_TO", newStrength);
  }
}

export function strengthenRelatedLinksBatch(db: DatabaseSync, pairs: [string, string][], deltaStrength = 0.1): void {
  if (pairs.length === 0) return;
  const selectStmt = db.prepare(
    `SELECT id, strength FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
  );
  const updateStmt = db.prepare("UPDATE memory_links SET strength = ? WHERE id = ?");
  const insertStmt = db.prepare(
    `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'RELATED_TO', ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  const tx = createTransaction(db, () => {
    for (const [factIdA, factIdB] of pairs) {
      if (factIdA === factIdB) continue;
      const [source, target] = factIdA < factIdB ? [factIdA, factIdB] : [factIdB, factIdA];
      const existing = selectStmt.get(source, target) as { id: string; strength: number } | undefined;
      const newStrength = Math.max(0, Math.min(1, (existing?.strength ?? 0) + deltaStrength));
      if (existing) {
        updateStmt.run(newStrength, existing.id);
      } else {
        insertStmt.run(randomUUID(), source, target, newStrength, now);
      }
    }
  });
  tx();
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

  const outStmt = db.prepare(
    `SELECT target_fact_id AS id FROM memory_links WHERE source_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') ORDER BY strength DESC, created_at DESC LIMIT ?`,
  );
  const inStmt = db.prepare(
    `SELECT source_fact_id AS id FROM memory_links WHERE target_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM') ORDER BY strength DESC, created_at DESC LIMIT ?`,
  );
  const degreeStmt = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_links WHERE source_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
       (SELECT COUNT(*) FROM memory_links WHERE target_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) AS degree`,
  );
  const degreeCache = new Map<string, number>();
  const degreeOf = (id: string): number => {
    const cached = degreeCache.get(id);
    if (cached != null) return cached;
    const row = degreeStmt.get(id, id) as { degree: number } | undefined;
    const degree = Number(row?.degree ?? 0);
    degreeCache.set(id, degree);
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
      // No hub cap: `degree` is in+out combined; each directional query uses that as LIMIT so every
      // neighbour in that direction is eligible (never truncates). With hub cap, +1 avoids edge truncation.
      const limit = hubDegreeCap == null ? Math.max(degree, 1) : Math.max(hubDegreeCap + 1, 1);
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
  let factJoinOut = "";
  let factWhereOut = "";
  let factJoinIn = "";
  let factWhereIn = "";
  const filterParamsOut: SQLInputValue[] = [];
  const filterParamsIn: SQLInputValue[] = [];

  if (asOf != null || scopeFilter) {
    factJoinOut = "JOIN facts f ON f.id = ml.target_fact_id";
    factJoinIn = "JOIN facts f ON f.id = ml.source_fact_id";

    let baseWhere = "";
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
    factWhereOut = baseWhere;
    factWhereIn = baseWhere;
  }

  // Use recursive CTE to traverse the graph in a single query
  // We track: current node, seed that originated this path, hop count, and JSON path
  const degreeCheckOut =
    hubDegreeCap == null
      ? ""
      : `AND (
        (SELECT COUNT(*) FROM memory_links WHERE source_fact_id = ml.target_fact_id AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
        (SELECT COUNT(*) FROM memory_links WHERE target_fact_id = ml.target_fact_id AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM'))
      ) <= ?`;
  const degreeCheckIn =
    hubDegreeCap == null
      ? ""
      : `AND (
        (SELECT COUNT(*) FROM memory_links WHERE source_fact_id = ml.source_fact_id AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')) +
        (SELECT COUNT(*) FROM memory_links WHERE target_fact_id = ml.source_fact_id AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM'))
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
