/**
 * Memory Health Dashboard Tool
 *
 * Registers `memory_health` tool that returns diagnostics:
 * total facts, category distribution, staleness, orphan count,
 * avg confidence, link density, storage size, and timestamps.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { detectClusters } from "../services/topic-clusters.js";
import { formatTimestampUtc, nowIso } from "../utils/dates.js";
import { getDirSize, getFileSizeAsync } from "../utils/fs.js";

interface HealthPluginContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  initialized?: Promise<void>;
}

interface HealthReport {
  totalFacts: number;
  activeFacts: number;
  supersededFacts: number;
  categoryDistribution: Record<string, number>;
  decayClassDistribution: Record<string, number>;
  tierDistribution: Record<string, number>;
  avgConfidence: number;
  orphanFacts: number;
  /** Fraction of active facts with no explicit graph link, 0-1 (#2127). */
  orphanRate: number;
  /**
   * Set when orphanRate exceeds a high-orphan threshold, so a dashboard/agent surfaces it instead
   * of only exposing the raw counts. Points at `maintenance graph-link-enrichment` as one lever;
   * a high orphan rate does not necessarily indicate a problem (recall can work fine via
   * FTS/vector search without explicit links), just that graph-native navigation is limited.
   */
  orphanRateWarning: string | null;
  staleFacts: number;
  avgLinksPerFact: number;
  totalLinks: number;
  /**
   * #1195: link-type histogram split between graph edges (`memory_links`) and JSON-backed
   * provenance (`facts.provenance_json`). The legacy histogram only counted `memory_links`,
   * which under-reported the real edge count after DERIVED_FROM was migrated into JSON.
   */
  linkTypeHistogram: {
    graph: Record<string, number>;
    provenance: { sourceEvents: number; factsWithProvenance: number };
  };
  retrievalHitRate7d: number;
  topClusters: Array<{ id: string; label: string; factCount: number }>;
  unresolvedContradictions: number;
  lastReflectionAt: string | null;
  lastPruneAt: string | null;
  /** Raw stored value for lastPruneAt when it failed the future-skew sanity check (#2129). */
  lastPruneInvalidRaw: number | null;
  storageSizeBytes: {
    sqlite: number;
    lance: number;
    total: number;
  };
  generatedAt: string;
}

/** Maintenance timestamps more than this far in the future than "now" are treated as corrupt (#2129). */
const MAINTENANCE_TIMESTAMP_FUTURE_SKEW_SEC = 2 * 24 * 60 * 60;

/**
 * Format a maintenance-metadata epoch-seconds value, guarding against corrupt/out-of-range
 * values (e.g. a stray milliseconds value) rendering as an implausible far-future date.
 * `formatTimestampUtc` already self-corrects the common ms-vs-seconds mismatch; this catches
 * whatever is still nonsensical afterward instead of silently displaying it as real.
 */
function formatMaintenanceTimestampOrNull(
  raw: number | null,
  nowSec: number,
): { display: string | null; invalidRaw: number | null } {
  if (raw == null) return { display: null, invalidRaw: null };
  let formatted: string;
  try {
    formatted = formatTimestampUtc(raw);
  } catch {
    return { display: null, invalidRaw: raw };
  }
  const ms = Date.parse(formatted);
  if (!Number.isFinite(ms) || ms / 1000 > nowSec + MAINTENANCE_TIMESTAMP_FUTURE_SKEW_SEC) {
    return { display: null, invalidRaw: raw };
  }
  return { display: formatted, invalidRaw: null };
}

export async function buildHealthReport(
  factsDb: FactsDB,
  resolvedSqlitePath: string,
  resolvedLancePath: string,
  cfg?: Pick<HybridMemoryConfig, "clusters">,
): Promise<HealthReport> {
  const db = factsDb.getRawDb();
  const nowSec = Math.floor(Date.now() / 1000);

  // Total facts (all rows)
  const totalRow = db.prepare("SELECT COUNT(*) AS cnt FROM facts").get() as { cnt: number };
  const totalFacts = totalRow.cnt;

  // Active facts (not superseded, not expired). Uses the codebase's standard liveness marker,
  // superseded_at IS NULL — quota/token-budget eviction (backends/facts-db/crud.ts,
  // backends/facts-db/maintenance.ts) sets superseded_at without touching valid_until, so a
  // valid_until-based check here would undercount evicted facts as still "active".
  const activeRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
     WHERE superseded_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec) as { cnt: number };
  const activeFacts = activeRow.cnt;

  // Superseded facts
  const supersededRow = db.prepare("SELECT COUNT(*) AS cnt FROM facts WHERE superseded_at IS NOT NULL").get() as {
    cnt: number;
  };
  const supersededFacts = supersededRow.cnt;

  // Category distribution (active facts only)
  const catRows = db
    .prepare(
      `SELECT category, COUNT(*) AS cnt FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY category ORDER BY cnt DESC`,
    )
    .all(nowSec) as Array<{ category: string; cnt: number }>;
  const categoryDistribution: Record<string, number> = {};
  for (const row of catRows) {
    categoryDistribution[row.category] = row.cnt;
  }

  // Decay class distribution (all facts)
  const decayRows = db
    .prepare("SELECT decay_class, COUNT(*) AS cnt FROM facts GROUP BY decay_class ORDER BY cnt DESC")
    .all() as Array<{ decay_class: string; cnt: number }>;
  const decayClassDistribution: Record<string, number> = {};
  for (const row of decayRows) {
    decayClassDistribution[row.decay_class] = row.cnt;
  }

  // Tier distribution
  const tierRows = db
    .prepare(
      `SELECT COALESCE(tier, 'warm') AS tier, COUNT(*) AS cnt FROM facts GROUP BY COALESCE(tier, 'warm') ORDER BY cnt DESC`,
    )
    .all() as Array<{ tier: string; cnt: number }>;
  const tierDistribution: Record<string, number> = {};
  for (const row of tierRows) {
    tierDistribution[row.tier] = row.cnt;
  }

  // Average confidence (active facts)
  const confRow = db
    .prepare(
      `SELECT AVG(confidence) AS avg_conf FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec) as { avg_conf: number | null };
  const avgConfidence = confRow.avg_conf != null ? Math.round(confRow.avg_conf * 1000) / 1000 : 0;

  // Orphan facts: facts with no links (neither source nor target) — active facts only
  const orphanRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND id NOT IN (
           SELECT source_fact_id FROM memory_links
           UNION
           SELECT target_fact_id FROM memory_links
         )`,
    )
    .get(nowSec) as { cnt: number };
  const orphanFacts = orphanRow.cnt;
  const orphanRate = activeFacts > 0 ? orphanFacts / activeFacts : 0;
  const ORPHAN_RATE_WARNING_THRESHOLD = 0.7;
  const orphanRateWarning =
    activeFacts > 0 && orphanRate > ORPHAN_RATE_WARNING_THRESHOLD
      ? `${(orphanRate * 100).toFixed(1)}% of active facts have no explicit graph link. Recall via FTS/vector ` +
        "search is unaffected, but graph navigation is limited. Consider `maintenance graph-link-enrichment`."
      : null;

  // Stale facts: confidence < 0.3, not permanent decay class, active
  const staleRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facts
       WHERE confidence < 0.3
         AND decay_class != 'permanent'
         AND superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(nowSec) as { cnt: number };
  const staleFacts = staleRow.cnt;

  // Total links (only count links where at least one endpoint is an active fact)
  const linksRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memory_links
     WHERE source_fact_id IN (
       SELECT id FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
     )
     OR target_fact_id IN (
       SELECT id FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
     )`,
    )
    .get(nowSec, nowSec) as { cnt: number };
  const totalLinks = linksRow.cnt;

  // #1195: per-link-type breakdown (graph table) + provenance count (JSON column).
  const linkTypeRows = db
    .prepare("SELECT link_type AS linkType, COUNT(*) AS cnt FROM memory_links GROUP BY link_type")
    .all() as Array<{ linkType: string; cnt: number }>;
  const graphLinkHistogram: Record<string, number> = {};
  for (const row of linkTypeRows) {
    graphLinkHistogram[row.linkType] = Number(row.cnt ?? 0);
  }
  const provenanceFactsRow = db.prepare("SELECT COUNT(*) AS cnt FROM facts WHERE provenance_json IS NOT NULL").get() as
    | { cnt: number }
    | undefined;
  // Best-effort: count `sourceEventIds` lengths via JSON helpers; falls back to fact count when
  // json_each is unavailable (older sqlite builds).
  let provenanceSourceEvents = 0;
  try {
    const jsonRow = db
      .prepare(
        `SELECT COALESCE(SUM(json_array_length(json_extract(provenance_json, '$.sourceEventIds'))), 0) AS cnt
         FROM facts
         WHERE provenance_json IS NOT NULL
           AND json_extract(provenance_json, '$.sourceEventIds') IS NOT NULL`,
      )
      .get() as { cnt: number } | undefined;
    provenanceSourceEvents = Number(jsonRow?.cnt ?? 0);
  } catch {
    provenanceSourceEvents = Number(provenanceFactsRow?.cnt ?? 0);
  }
  const linkTypeHistogram = {
    graph: graphLinkHistogram,
    provenance: {
      sourceEvents: provenanceSourceEvents,
      factsWithProvenance: Number(provenanceFactsRow?.cnt ?? 0),
    },
  };

  // Avg links per active fact
  const avgLinksPerFact = activeFacts > 0 ? Math.round((totalLinks * 2 * 1000) / activeFacts) / 1000 : 0;

  // Retrieval hit rate in the last 7 days
  const sevenDaysAgo = nowSec - 7 * 24 * 60 * 60;
  const recallRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(hit) AS hits
       FROM recall_log
       WHERE occurred_at >= ?`,
    )
    .get(sevenDaysAgo) as { total: number; hits: number | null };
  const recallTotal = recallRow.total ?? 0;
  const recallHits = recallRow.hits ?? 0;
  const retrievalHitRate7d = recallTotal > 0 ? Math.round((recallHits / recallTotal) * 1000) / 1000 : 0;

  // Unresolved contradictions
  const contradictionRow = db.prepare("SELECT COUNT(*) AS cnt FROM contradictions WHERE resolved = 0").get() as {
    cnt: number;
  };
  const unresolvedContradictions = contradictionRow.cnt;

  // Top clusters (detect live)
  let topClusters: Array<{ id: string; label: string; factCount: number }> = [];
  if (cfg?.clusters?.enabled) {
    const clusters = detectClusters(factsDb, {
      minClusterSize: cfg.clusters.minClusterSize,
    }).clusters;
    topClusters = clusters.slice(0, 5).map((c) => ({
      id: c.id,
      label: c.label,
      factCount: c.factCount,
    }));
  }

  // Last reflection timestamp
  const reflRow = db.prepare(`SELECT MAX(created_at) AS last_at FROM facts WHERE source = 'reflection'`).get() as {
    last_at: number | null;
  };
  const lastReflectionAt = formatMaintenanceTimestampOrNull(reflRow.last_at, nowSec).display;

  // Last prune: derived from MAX(superseded_at) of superseded facts (best approximation)
  const pruneRow = db
    .prepare("SELECT MAX(superseded_at) AS last_at FROM facts WHERE superseded_at IS NOT NULL")
    .get() as { last_at: number | null };
  const lastPruneResult = formatMaintenanceTimestampOrNull(pruneRow.last_at, nowSec);
  const lastPruneAt = lastPruneResult.display;
  const lastPruneInvalidRaw = lastPruneResult.invalidRaw;

  // Storage sizes (async I/O — avoids sync stat hot-path blocking; Issue #880)
  const [sqliteSize, sqliteWalSize, sqliteShmSize, lanceSize] = await Promise.all([
    getFileSizeAsync(resolvedSqlitePath),
    getFileSizeAsync(`${resolvedSqlitePath}-wal`),
    getFileSizeAsync(`${resolvedSqlitePath}-shm`),
    getDirSize(resolvedLancePath),
  ]);
  const totalSqliteSize = sqliteSize + sqliteWalSize + sqliteShmSize;

  return {
    totalFacts,
    activeFacts,
    supersededFacts,
    categoryDistribution,
    decayClassDistribution,
    tierDistribution,
    avgConfidence,
    orphanFacts,
    orphanRate,
    orphanRateWarning,
    staleFacts,
    avgLinksPerFact,
    totalLinks,
    linkTypeHistogram,
    retrievalHitRate7d,
    topClusters,
    unresolvedContradictions,
    lastReflectionAt,
    lastPruneAt,
    lastPruneInvalidRaw,
    storageSizeBytes: {
      sqlite: totalSqliteSize,
      lance: lanceSize,
      total: totalSqliteSize + lanceSize,
    },
    generatedAt: nowIso(),
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
          if (ctx.initialized) {
            await ctx.initialized;
          }
          const report = await buildHealthReport(factsDb, resolvedSqlitePath, resolvedLancePath, cfg);

          const lines: string[] = [
            `Memory Health Dashboard (${report.generatedAt})`,
            "",
            `Facts: ${report.activeFacts} active / ${report.totalFacts} total (${report.supersededFacts} superseded)`,
            `Stale facts (confidence < 0.3, non-permanent): ${report.staleFacts}`,
            `Orphan facts (no links): ${report.orphanFacts} (${(report.orphanRate * 100).toFixed(1)}%)`,
            ...(report.orphanRateWarning ? [`⚠ ${report.orphanRateWarning}`] : []),
            `Avg confidence: ${report.avgConfidence.toFixed(3)}`,
            `Retrieval hit rate (7d): ${(report.retrievalHitRate7d * 100).toFixed(1)}%`,
            `Unresolved contradictions: ${report.unresolvedContradictions}`,
            "",
            `Links: ${report.totalLinks} total, ${report.avgLinksPerFact.toFixed(2)} avg per active fact`,
            `Link types (graph): ${
              Object.keys(report.linkTypeHistogram.graph).length === 0
                ? "none"
                : Object.entries(report.linkTypeHistogram.graph)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ")
            }`,
            `Provenance (JSON): ${report.linkTypeHistogram.provenance.factsWithProvenance} facts cover ${report.linkTypeHistogram.provenance.sourceEvents} source events (#1195)`,
            "",
            `Categories: ${Object.entries(report.categoryDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            `Decay classes: ${Object.entries(report.decayClassDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            `Tiers: ${Object.entries(report.tierDistribution)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
            `Top clusters: ${
              report.topClusters.length > 0
                ? report.topClusters.map((c) => `${c.label}(${c.factCount})`).join(", ")
                : "none"
            }`,
            "",
            `Last reflection: ${report.lastReflectionAt ?? "never"}`,
            `Last prune: ${
              report.lastPruneAt ??
              (report.lastPruneInvalidRaw != null
                ? `invalid (corrupt stored value: ${report.lastPruneInvalidRaw})`
                : "none recorded")
            }`,
            "",
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
