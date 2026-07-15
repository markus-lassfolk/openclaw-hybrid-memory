/**
 * Topic cluster storage (Issue #146) (Issue #954 split).
 */
import type { DatabaseSync } from "node:sqlite";

import { createTransaction } from "../../utils/sqlite-transaction.js";

export function getAllLinkedFactIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT id FROM (
          SELECT source_fact_id AS id FROM memory_links
          UNION
          SELECT target_fact_id AS id FROM memory_links
        )`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getAllLinks(db: DatabaseSync): Array<{ sourceFactId: string; targetFactId: string }> {
  const rows = db.prepare("SELECT source_fact_id, target_fact_id FROM memory_links").all() as Array<{
    source_fact_id: string;
    target_fact_id: string;
  }>;
  return rows.map((r) => ({
    sourceFactId: r.source_fact_id,
    targetFactId: r.target_fact_id,
  }));
}

export function getAllEdges(
  db: DatabaseSync,
  limit = 5000,
): Array<{
  source: string;
  target: string;
  linkType: string;
  strength: number;
}> {
  const rows = db
    .prepare("SELECT source_fact_id, target_fact_id, link_type, strength FROM memory_links LIMIT ?")
    .all(limit) as Array<{
    source_fact_id: string;
    target_fact_id: string;
    link_type: string;
    strength: number;
  }>;
  return rows.map((r) => ({
    source: r.source_fact_id,
    target: r.target_fact_id,
    linkType: r.link_type || "RELATED_TO",
    strength: r.strength ?? 0.8,
  }));
}

/**
 * Explicit graph links whose source AND target are both within `ids` — scoped directly in SQL
 * rather than fetching an arbitrary global sample and filtering client-side (#2126). The prior
 * approach (`getAllEdges` + both-endpoints-in-sample filter) combined an unordered/LIMIT-truncated
 * global edge sample with a recency-biased node sample and routinely produced zero edges at scale,
 * even when the store held thousands of explicit links.
 */
export function getEdgesForFactIds(
  db: DatabaseSync,
  ids: string[],
  limit = 5000,
): Array<{
  source: string;
  target: string;
  linkType: string;
  strength: number;
}> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const uniqueIds = [...idSet];
  const CHUNK_SIZE = 500;
  // Defensive cap on rows read per chunk, deliberately decoupled from `limit`/`out.length`: the
  // idSet both-endpoints filter below runs client-side, so a SQL-level LIMIT tied to the remaining
  // output budget can be fully consumed by a hub fact's links to ids OUTSIDE the full `ids` set
  // before a single genuinely in-scope edge is read, reproducing #2126's "zero edges" symptom at
  // chunk scale (#2134 QA follow-up). This cap only guards against a pathological single-node
  // fan-out; it is not the intended result size.
  const SQL_ROW_SAFETY_CAP = 50_000;
  const seenEdges = new Set<string>();
  const out: Array<{ source: string; target: string; linkType: string; strength: number }> = [];

  for (let i = 0; i < uniqueIds.length && out.length < limit; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT source_fact_id, target_fact_id, link_type, strength FROM memory_links
         WHERE source_fact_id IN (${placeholders}) OR target_fact_id IN (${placeholders})
         LIMIT ?`,
      )
      .all(...chunk, ...chunk, SQL_ROW_SAFETY_CAP) as Array<{
      source_fact_id: string;
      target_fact_id: string;
      link_type: string;
      strength: number;
    }>;
    for (const r of rows) {
      if (!idSet.has(r.source_fact_id) || !idSet.has(r.target_fact_id)) continue;
      const key = `${r.source_fact_id}\0${r.target_fact_id}\0${r.link_type}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      out.push({
        source: r.source_fact_id,
        target: r.target_fact_id,
        linkType: r.link_type || "RELATED_TO",
        strength: r.strength ?? 0.8,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function saveClusters(
  db: DatabaseSync,
  clusters: Array<{
    id: string;
    label: string;
    factIds: string[];
    factCount: number;
    createdAt: number;
    updatedAt: number;
  }>,
): void {
  const insertCluster = db.prepare(
    "INSERT OR REPLACE INTO clusters (id, label, fact_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertMember = db.prepare("INSERT OR IGNORE INTO cluster_members (cluster_id, fact_id) VALUES (?, ?)");

  createTransaction(db, () => {
    db.exec("DELETE FROM cluster_members");
    db.exec("DELETE FROM clusters");
    for (const cluster of clusters) {
      insertCluster.run(cluster.id, cluster.label, cluster.factCount, cluster.createdAt, cluster.updatedAt);
      for (const factId of cluster.factIds) {
        insertMember.run(cluster.id, factId);
      }
    }
  })();
}

export function getClusters(db: DatabaseSync): Array<{
  id: string;
  label: string;
  factCount: number;
  createdAt: number;
  updatedAt: number;
}> {
  const rows = db
    .prepare("SELECT id, label, fact_count, created_at, updated_at FROM clusters ORDER BY fact_count DESC")
    .all() as Array<{
    id: string;
    label: string;
    fact_count: number;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    factCount: r.fact_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getClusterMembers(db: DatabaseSync, clusterId: string): string[] {
  const rows = db.prepare("SELECT fact_id FROM cluster_members WHERE cluster_id = ?").all(clusterId) as Array<{
    fact_id: string;
  }>;
  return rows.map((r) => r.fact_id);
}

export function getFactClusterId(db: DatabaseSync, factId: string): string | null {
  const row = db.prepare("SELECT cluster_id FROM cluster_members WHERE fact_id = ?").get(factId) as
    | { cluster_id: string }
    | undefined;
  return row?.cluster_id ?? null;
}
