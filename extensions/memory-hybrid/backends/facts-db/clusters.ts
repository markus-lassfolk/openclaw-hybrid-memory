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
  link_type: string;
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
    link_type: r.link_type || "RELATED_TO",
    strength: r.strength ?? 0.8,
  }));
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
