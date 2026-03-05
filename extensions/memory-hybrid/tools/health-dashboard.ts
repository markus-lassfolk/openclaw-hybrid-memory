/**
 * Memory Health Dashboard Tool
 *
 * Registers `memory_health` tool that returns diagnostics:
 * total facts, category distribution, staleness, orphan count,
 * avg confidence, link density, storage size, and timestamps.
 */

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface HealthPluginContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
}

export interface HealthReport {
  totalFacts: number;
  activeFacts: number;
  supersededFacts: number;
  categoryDistribution: Record<string, number>;
  decayClassDistribution: Record<string, number>;
  tierDistribution: Record<string, number>;
  avgConfidence: number;
  orphanFacts: number;
  staleFacts: number;
  avgLinksPerFact: number;
  totalLinks: number;
  lastReflectionAt: string | null;
  lastPruneAt: string | null;
  storageSizeBytes: {
    sqlite: number;
    lance: number;
    total: number;
  };
  generatedAt: string;
}

function getDirSize(dirPath: string): number {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch {
          // skip unreadable files
        }
      } else if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function buildHealthReport(
  factsDb: FactsDB,
  resolvedSqlitePath: string,
  resolvedLancePath: string,
): HealthReport {
  const db = factsDb.getRawDb();
  const nowSec = Math.floor(Date.now() / 1000);

  // Total facts (all rows)
  const totalRow = db.prepare(`SELECT COUNT(*) AS cnt FROM facts`).get() as { cnt: number };
  const totalFacts = totalRow.cnt;

  // Active facts (not superseded, not expired)
  const activeRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM facts
     WHERE (valid_until IS NULL OR valid_until > ?)
       AND (expires_at IS NULL OR expires_at > ?)`,
  ).get(nowSec, nowSec) as { cnt: number };
  const activeFacts = activeRow.cnt;

  // Superseded facts (valid_until <= now or has a superseder)
  const supersededRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM facts
     WHERE valid_until IS NOT NULL AND valid_until <= ?`,
  ).get(nowSec) as { cnt: number };
  const supersededFacts = supersededRow.cnt;

  // Category distribution (active facts only)
  const catRows = db
    .prepare(
      `SELECT category, COUNT(*) AS cnt FROM facts
       WHERE (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY category ORDER BY cnt DESC`,
    )
    .all(nowSec, nowSec) as Array<{ category: string; cnt: number }>;
  const categoryDistribution: Record<string, number> = {};
  for (const row of catRows) {
    categoryDistribution[row.category] = row.cnt;
  }

  // Decay class distribution (all facts)
  const decayRows = db
    .prepare(`SELECT decay_class, COUNT(*) AS cnt FROM facts GROUP BY decay_class ORDER BY cnt DESC`)
    .all() as Array<{ decay_class: string; cnt: number }>;
  const decayClassDistribution: Record<string, number> = {};
  for (const row of decayRows) {
    decayClassDistribution[row.decay_class] = row.cnt;
  }

  // Tier distribution
  const tierRows = db
    .prepare(`SELECT COALESCE(tier, 'warm') AS tier, COUNT(*) AS cnt FROM facts GROUP BY COALESCE(tier, 'warm') ORDER BY cnt DESC`)
    .all() as Array<{ tier: string; cnt: number }>;
  const tierDistribution: Record<string, number> = {};
  for (const row of tierRows) {
    tierDistribution[row.tier] = row.cnt;
  }

  // Average confidence (active facts)
  const confRow = db
    .prepare(
      `SELECT AVG(confidence) AS avg_conf FROM facts
       WHERE (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec, nowSec) as { avg_conf: number | null };
  const avgConfidence = confRow.avg_conf != null ? Math.round(confRow.avg_conf * 1000) / 1000 : 0;

  // Orphan facts: facts with no links (neither source nor target) — active facts only
  const orphanRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
       WHERE (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)
         AND id NOT IN (
           SELECT source_fact_id FROM memory_links
           UNION
           SELECT target_fact_id FROM memory_links
         )`,
    )
    .get(nowSec, nowSec) as { cnt: number };
  const orphanFacts = orphanRow.cnt;

  // Stale facts: confidence < 0.3, not permanent decay class, active
  const staleRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
       WHERE confidence < 0.3
         AND decay_class != 'permanent'
         AND (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec, nowSec) as { cnt: number };
  const staleFacts = staleRow.cnt;

  // Total links (only count links where at least one endpoint is an active fact)
  const linksRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM memory_links
     WHERE source_fact_id IN (
       SELECT id FROM facts
       WHERE (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)
     )
     OR target_fact_id IN (
       SELECT id FROM facts
       WHERE (valid_until IS NULL OR valid_until > ?)
         AND (expires_at IS NULL OR expires_at > ?)
     )`,
  ).get(nowSec, nowSec, nowSec, nowSec) as { cnt: number };
  const totalLinks = linksRow.cnt;

  // Avg links per active fact
  const avgLinksPerFact =
    activeFacts > 0 ? Math.round((totalLinks * 2 * 1000) / activeFacts) / 1000 : 0;

  // Last reflection timestamp
  const reflRow = db
    .prepare(
      `SELECT MAX(created_at) AS last_at FROM facts WHERE source = 'reflection'`,
    )
    .get() as { last_at: number | null };
  const lastReflectionAt =
    reflRow.last_at != null
      ? new Date(reflRow.last_at * 1000).toISOString()
      : null;

  // Last prune: derived from MAX(valid_until) of superseded facts (best approximation)
  const pruneRow = db
    .prepare(
      `SELECT MAX(valid_until) AS last_at FROM facts WHERE valid_until IS NOT NULL AND valid_until <= ?`,
    )
    .get(nowSec) as { last_at: number | null };
  const lastPruneAt =
    pruneRow.last_at != null
      ? new Date(pruneRow.last_at * 1000).toISOString()
      : null;

  // Storage sizes
  const sqliteSize = getFileSize(resolvedSqlitePath);
  // Also count WAL / SHM sidecars
  const sqliteWalSize = getFileSize(resolvedSqlitePath + "-wal");
  const sqliteShmSize = getFileSize(resolvedSqlitePath + "-shm");
  const totalSqliteSize = sqliteSize + sqliteWalSize + sqliteShmSize;
  const lanceSize = getDirSize(resolvedLancePath);

  return {
    totalFacts,
    activeFacts,
    supersededFacts,
    categoryDistribution,
    decayClassDistribution,
    tierDistribution,
    avgConfidence,
    orphanFacts,
    staleFacts,
    avgLinksPerFact,
    totalLinks,
    lastReflectionAt,
    lastPruneAt,
    storageSizeBytes: {
      sqlite: totalSqliteSize,
      lance: lanceSize,
      total: totalSqliteSize + lanceSize,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Register the memory_health tool with the plugin API.
 */
export function registerHealthTools(ctx: HealthPluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, cfg, resolvedSqlitePath, resolvedLancePath } = ctx;

  if (!cfg.health.enabled) return;

  api.registerTool(
    {
      name: "memory_health",
      label: "Memory Health",
      description:
        "Return a health dashboard for the memory system: total facts, category distribution, " +
        "staleness indicators, orphan count, average confidence, link density, and storage sizes.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: Record<string, unknown>) {
        try {
          const report = buildHealthReport(factsDb, resolvedSqlitePath, resolvedLancePath);

          const lines: string[] = [
            `Memory Health Dashboard (${report.generatedAt})`,
            ``,
            `Facts: ${report.activeFacts} active / ${report.totalFacts} total (${report.supersededFacts} superseded)`,
            `Stale facts (confidence < 0.3, non-permanent): ${report.staleFacts}`,
            `Orphan facts (no links): ${report.orphanFacts}`,
            `Avg confidence: ${report.avgConfidence.toFixed(3)}`,
            ``,
            `Links: ${report.totalLinks} total, ${report.avgLinksPerFact.toFixed(2)} avg per active fact`,
            ``,
            `Categories: ${Object.entries(report.categoryDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            `Decay classes: ${Object.entries(report.decayClassDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            `Tiers: ${Object.entries(report.tierDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            ``,
            `Last reflection: ${report.lastReflectionAt ?? "never"}`,
            `Last prune: ${report.lastPruneAt ?? "none recorded"}`,
            ``,
            `Storage: SQLite ${(report.storageSizeBytes.sqlite / 1024).toFixed(1)} KB, ` +
              `LanceDB ${(report.storageSizeBytes.lance / 1024).toFixed(1)} KB, ` +
              `Total ${(report.storageSizeBytes.total / 1024).toFixed(1)} KB`,
          ];

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: report,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-health",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_health" },
  );
}
