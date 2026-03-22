import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { MemoryLinkType } from "./types.js";

export function createLink(
  db: Database.Database,
  sourceFactId: string,
  targetFactId: string,
  linkType: MemoryLinkType,
  strength = 1.0,
): string {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceFactId, targetFactId, linkType, Math.max(0, Math.min(1, strength)), now);
  return id;
}

export function createOrStrengthenRelatedLink(
  db: Database.Database,
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
    db.prepare(`UPDATE memory_links SET strength = ? WHERE id = ?`).run(newStrength, existing.id);
  } else {
    createLink(db, source, target, "RELATED_TO", newStrength);
  }
}

export function strengthenRelatedLinksBatch(
  db: Database.Database,
  pairs: [string, string][],
  deltaStrength = 0.1,
): void {
  if (pairs.length === 0) return;
  const selectStmt = db.prepare(
    `SELECT id, strength FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
  );
  const updateStmt = db.prepare(`UPDATE memory_links SET strength = ? WHERE id = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'RELATED_TO', ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
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
  db: Database.Database,
  factId: string,
): Array<{ id: string; targetFactId: string; linkType: string; strength: number }> {
  const rows = db
    .prepare(`SELECT id, target_fact_id, link_type, strength FROM memory_links WHERE source_fact_id = ?`)
    .all(factId) as Array<{ id: string; target_fact_id: string; link_type: string; strength: number }>;
  return rows.map((r) => ({
    id: r.id,
    targetFactId: r.target_fact_id,
    linkType: r.link_type,
    strength: r.strength,
  }));
}

export function getLinksTo(
  db: Database.Database,
  factId: string,
): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }> {
  const rows = db
    .prepare(`SELECT id, source_fact_id, link_type, strength FROM memory_links WHERE target_fact_id = ?`)
    .all(factId) as Array<{ id: string; source_fact_id: string; link_type: string; strength: number }>;
  return rows.map((r) => ({
    id: r.id,
    sourceFactId: r.source_fact_id,
    linkType: r.link_type,
    strength: r.strength,
  }));
}

export function getConnectedFactIds(db: Database.Database, factIds: string[], maxDepth: number): string[] {
  if (factIds.length === 0 || maxDepth < 1) return [...factIds];
  const seen = new Set<string>(factIds);
  let frontier = [...factIds];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const out = db
        .prepare(`SELECT target_fact_id FROM memory_links WHERE source_fact_id = ? AND link_type != 'CONTRADICTS'`)
        .all(id) as Array<{ target_fact_id: string }>;
      const in_ = db
        .prepare(`SELECT source_fact_id FROM memory_links WHERE target_fact_id = ? AND link_type != 'CONTRADICTS'`)
        .all(id) as Array<{ source_fact_id: string }>;
      for (const r of out) {
        if (!seen.has(r.target_fact_id)) {
          seen.add(r.target_fact_id);
          next.push(r.target_fact_id);
        }
      }
      for (const r of in_) {
        if (!seen.has(r.source_fact_id)) {
          seen.add(r.source_fact_id);
          next.push(r.source_fact_id);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}
