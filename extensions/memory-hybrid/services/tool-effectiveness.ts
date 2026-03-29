/**
 * Tool Effectiveness Scoring — Aggregate workflow traces into per-tool score profiles.
 * Issue #263 — Phase 3.
 *
 * Algorithm for each tool:
 *   successRate  = successCount / totalCalls
 *   avgDuration  = Σ(durationMs) / count
 *   redundancyScore = avgTimesUsedPerSession (how often tool repeats in one session)
 *   compositeScore  = (successRate × 0.5) + ((1 - avgDuration/maxDuration) × 0.3) + ((1 - redundancyScore) × 0.2)
 *
 * Scores are persisted in the `tool_effectiveness` SQLite table.
 * A persistent score decay (factor 0.95) is applied each run so stale data fades out.
 * Low scorers can be flagged in CLI output.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseSqliteStore } from "../backends/base-sqlite-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ToolEffectivenessConfig } from "../config/types/features.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "./error-reporter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolMetrics {
  tool: string;
  /** Context label for this score row (default "general"). */
  context: string;
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  unknownCalls: number;
  successRate: number;
  avgDurationMs: number;
  avgCallsPerSession: number;
  redundancyScore: number; // 0-1: 1 = maximally redundant (same tool called many times)
  compositeScore: number; // 0-1: higher is better
  lastUpdated: number; // epoch seconds
}

export interface ToolEffectivenessReport {
  computedAt: number;
  toolsScored: number;
  topTools: ToolMetrics[];
  lowScoreTools: ToolMetrics[];
  allScores: ToolMetrics[];
  recommendations: string[];
}
// ToolEffectivenessConfig is imported from ../config/types/features.js
// Re-export for consumers that import it from this module.

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_effectiveness (
  tool           TEXT NOT NULL,
  context        TEXT NOT NULL DEFAULT 'general',
  total_calls    INTEGER NOT NULL DEFAULT 0,
  success_calls  INTEGER NOT NULL DEFAULT 0,
  failure_calls  INTEGER NOT NULL DEFAULT 0,
  unknown_calls  INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms REAL NOT NULL DEFAULT 0,
  avg_calls_per_session REAL NOT NULL DEFAULT 0,
  composite_score REAL NOT NULL DEFAULT 0,
  last_updated   INTEGER NOT NULL,
  PRIMARY KEY (tool, context)
);
`;

// ---------------------------------------------------------------------------
// ToolEffectivenessStore
// ---------------------------------------------------------------------------

export class ToolEffectivenessStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db, { foreignKeys: true });
    this.liveDb.exec(SCHEMA);
  }

  protected getSubsystemName(): string {
    return "tool-effectiveness-store";
  }

  /** Upsert a tool score row. */
  upsert(metrics: ToolMetrics): void {
    const context = metrics.context ?? "general";
    this.liveDb
      .prepare(
        `INSERT INTO tool_effectiveness
         (tool, context, total_calls, success_calls, failure_calls, unknown_calls, avg_duration_ms, avg_calls_per_session, composite_score, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool, context) DO UPDATE SET
           total_calls = excluded.total_calls,
           success_calls = excluded.success_calls,
           failure_calls = excluded.failure_calls,
           unknown_calls = excluded.unknown_calls,
           avg_duration_ms = excluded.avg_duration_ms,
           avg_calls_per_session = excluded.avg_calls_per_session,
           composite_score = excluded.composite_score,
           last_updated = excluded.last_updated`,
      )
      .run(
        metrics.tool,
        context,
        metrics.totalCalls,
        metrics.successCalls,
        metrics.failureCalls,
        metrics.unknownCalls,
        metrics.avgDurationMs,
        metrics.avgCallsPerSession,
        metrics.compositeScore,
        metrics.lastUpdated,
      );
  }

  /**
   * Record a single tool outcome (incremental upsert for real-time tracking).
   *
   * @param tool      Tool name.
   * @param outcome   "success" | "failure" | "unknown".
   * @param context   Context label (default "general").
   * @param durationMs Duration of the call in milliseconds (default 0).
   *
   * Note: `avg_calls_per_session` is intentionally not updated here because individual
   * tool outcome events lack session boundary information. It is computed during the
   * nightly batch analysis via `computeToolEffectiveness` / `upsert`, which has access
   * to per-session call counts from workflow traces.
   */
  recordToolOutcome(
    tool: string,
    outcome: "success" | "failure" | "unknown",
    context = "general",
    durationMs = 0,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare(
        `INSERT INTO tool_effectiveness
         (tool, context, total_calls, success_calls, failure_calls, unknown_calls, avg_duration_ms, avg_calls_per_session, composite_score, last_updated)
         VALUES (?, ?, 1,
           CASE ? WHEN 'success' THEN 1 ELSE 0 END,
           CASE ? WHEN 'failure' THEN 1 ELSE 0 END,
           CASE ? WHEN 'unknown' THEN 1 ELSE 0 END,
           ?, 1.0, 0.5, ?)
         ON CONFLICT(tool, context) DO UPDATE SET
           total_calls    = total_calls + 1,
           success_calls  = success_calls  + CASE ? WHEN 'success' THEN 1 ELSE 0 END,
           failure_calls  = failure_calls  + CASE ? WHEN 'failure' THEN 1 ELSE 0 END,
           unknown_calls  = unknown_calls  + CASE ? WHEN 'unknown' THEN 1 ELSE 0 END,
           avg_duration_ms = (avg_duration_ms * total_calls + ?) / (total_calls + 1),
           composite_score = CAST(success_calls + CASE ? WHEN 'success' THEN 1 ELSE 0 END AS REAL) / MAX(total_calls + 1, 1) * 0.5 + 0.25,
           last_updated   = ?`,
      )
      .run(
        tool,
        context,
        outcome,
        outcome,
        outcome,
        durationMs,
        now,
        outcome,
        outcome,
        outcome,
        durationMs,
        outcome,
        now,
      );
  }

  /**
   * Get effectiveness for a specific tool, optionally filtered by context.
   *
   * @param tool     Tool name.
   * @param context  Optional context filter. If omitted, returns all context rows for the tool.
   * @returns        Array of ToolMetrics (one per context), or empty array if not found.
   */
  getToolEffectiveness(tool: string, context?: string): ToolMetrics[] {
    type Row = {
      tool: string;
      context: string;
      total_calls: number;
      success_calls: number;
      failure_calls: number;
      unknown_calls: number;
      avg_duration_ms: number;
      avg_calls_per_session: number;
      composite_score: number;
      last_updated: number;
    };

    let rows: Row[];
    if (context !== undefined) {
      rows = this.liveDb
        .prepare("SELECT * FROM tool_effectiveness WHERE tool = ? AND context = ?")
        .all(tool, context) as Row[];
    } else {
      rows = this.liveDb.prepare("SELECT * FROM tool_effectiveness WHERE tool = ? ORDER BY context").all(tool) as Row[];
    }

    return rows.map((r) => ({
      tool: r.tool,
      context: r.context,
      totalCalls: r.total_calls,
      successCalls: r.success_calls,
      failureCalls: r.failure_calls,
      unknownCalls: r.unknown_calls,
      successRate: r.total_calls > 0 ? r.success_calls / r.total_calls : 0,
      avgDurationMs: r.avg_duration_ms,
      avgCallsPerSession: r.avg_calls_per_session,
      redundancyScore: Math.min(1, Math.max(0, (r.avg_calls_per_session - 1) / 4)),
      compositeScore: r.composite_score,
      lastUpdated: r.last_updated,
    }));
  }

  /** Apply decay to all scores. */
  applyDecay(factor: number): void {
    this.liveDb.prepare("UPDATE tool_effectiveness SET composite_score = composite_score * ?").run(factor);
  }

  /** Get all scores ordered by composite_score DESC. */
  getAll(): ToolMetrics[] {
    const rows = this.liveDb.prepare("SELECT * FROM tool_effectiveness ORDER BY composite_score DESC").all() as Array<{
      tool: string;
      context: string;
      total_calls: number;
      success_calls: number;
      failure_calls: number;
      unknown_calls: number;
      avg_duration_ms: number;
      avg_calls_per_session: number;
      composite_score: number;
      last_updated: number;
    }>;

    return rows.map((r) => ({
      tool: r.tool,
      context: r.context ?? "general",
      totalCalls: r.total_calls,
      successCalls: r.success_calls,
      failureCalls: r.failure_calls,
      unknownCalls: r.unknown_calls,
      successRate: r.total_calls > 0 ? r.success_calls / r.total_calls : 0,
      avgDurationMs: r.avg_duration_ms,
      avgCallsPerSession: r.avg_calls_per_session,
      redundancyScore: Math.min(1, Math.max(0, (r.avg_calls_per_session - 1) / 4)),
      compositeScore: r.composite_score,
      lastUpdated: r.last_updated,
    }));
  }

  /** Get score for a specific tool (first context row, or "general"). */
  getByTool(tool: string): ToolMetrics | null {
    const row = this.liveDb
      .prepare("SELECT * FROM tool_effectiveness WHERE tool = ? ORDER BY context LIMIT 1")
      .get(tool) as
      | {
          tool: string;
          context: string;
          total_calls: number;
          success_calls: number;
          failure_calls: number;
          unknown_calls: number;
          avg_duration_ms: number;
          avg_calls_per_session: number;
          composite_score: number;
          last_updated: number;
        }
      | undefined;

    if (!row) return null;
    return {
      tool: row.tool,
      context: row.context ?? "general",
      totalCalls: row.total_calls,
      successCalls: row.success_calls,
      failureCalls: row.failure_calls,
      unknownCalls: row.unknown_calls,
      successRate: row.total_calls > 0 ? row.success_calls / row.total_calls : 0,
      avgDurationMs: row.avg_duration_ms,
      avgCallsPerSession: row.avg_calls_per_session,
      redundancyScore: Math.min(1, Math.max(0, (row.avg_calls_per_session - 1) / 4)),
      compositeScore: row.composite_score,
      lastUpdated: row.last_updated,
    };
  }

  /** Count of scored tools. */
  count(): number {
    const row = this.liveDb.prepare("SELECT COUNT(*) as n FROM tool_effectiveness").get() as { n: number };
    return row.n;
  }
}

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

interface TraceRow {
  tool_sequence: string;
  outcome: string;
  duration_ms: number;
  session_id: string;
}

/** Aggregate raw workflow trace rows into per-tool metrics. */
export function aggregateTraceRows(rows: TraceRow[], minCalls: number): ToolMetrics[] {
  if (rows.length === 0) return [];

  const toolStats = new Map<
    string,
    {
      total: number;
      success: number;
      failure: number;
      unknown: number;
      durations: number[];
      // sessionId → call count in that session
      sessionCalls: Map<string, number>;
    }
  >();

  const maxDuration = rows.reduce((max, r) => Math.max(max, r.duration_ms ?? 0), 0) || 1;

  for (const row of rows) {
    let seq: string[] = [];
    try {
      seq = JSON.parse(row.tool_sequence) as string[];
    } catch {
      continue;
    }
    const uniqueToolsInRow = new Set(seq);
    const sessionId = row.session_id ?? "unknown";

    for (const tool of uniqueToolsInRow) {
      if (!toolStats.has(tool)) {
        toolStats.set(tool, {
          total: 0,
          success: 0,
          failure: 0,
          unknown: 0,
          durations: [],
          sessionCalls: new Map(),
        });
      }
      const s = toolStats.get(tool)!;

      // Count occurrences of this tool in this trace
      const callsInTrace = seq.filter((t) => t === tool).length;
      s.total += callsInTrace;

      // Outcome attribution
      if (row.outcome === "success") s.success += callsInTrace;
      else if (row.outcome === "failure") s.failure += callsInTrace;
      else s.unknown += callsInTrace;

      // Duration: attribute the trace duration equally across unique tools
      s.durations.push((row.duration_ms ?? 0) / uniqueToolsInRow.size);

      // Session redundancy
      const prevCalls = s.sessionCalls.get(sessionId) ?? 0;
      s.sessionCalls.set(sessionId, prevCalls + callsInTrace);
    }
  }

  const results: ToolMetrics[] = [];

  for (const [tool, s] of toolStats) {
    if (s.total < minCalls) continue;

    const successRate = s.total > 0 ? s.success / s.total : 0;
    const avgDuration = s.durations.reduce((a, b) => a + b, 0) / Math.max(1, s.durations.length);
    const sessionCallCounts = [...s.sessionCalls.values()];
    const avgCallsPerSession = sessionCallCounts.reduce((a, b) => a + b, 0) / Math.max(1, sessionCallCounts.length);

    // Redundancy = (avg calls per session - 1) / 4 clamped to [0,1]
    // 1 call/session = 0 redundancy; 5+ calls/session = 1.0 redundancy
    const redundancyScore = Math.min(1, Math.max(0, (avgCallsPerSession - 1) / 4));

    // Duration score: 1 = very fast, 0 = slowest seen
    const durationScore = 1 - Math.min(1, avgDuration / maxDuration);

    // Composite: success 50%, speed 30%, low-redundancy 20%
    const compositeScore = successRate * 0.5 + durationScore * 0.3 + (1 - redundancyScore) * 0.2;

    results.push({
      tool,
      context: "general",
      totalCalls: s.total,
      successCalls: s.success,
      failureCalls: s.failure,
      unknownCalls: s.unknown,
      successRate,
      avgDurationMs: avgDuration,
      avgCallsPerSession,
      redundancyScore,
      compositeScore: Math.min(1, Math.max(0, compositeScore)),
      lastUpdated: Math.floor(Date.now() / 1000),
    });
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

/** Generate human-readable recommendations from tool metrics. */
export function generateRecommendations(metrics: ToolMetrics[], lowScoreThreshold: number): string[] {
  const recs: string[] = [];

  const lowScorers = metrics.filter((m) => m.compositeScore < lowScoreThreshold && m.totalCalls >= 5);
  if (lowScorers.length > 0) {
    const names = lowScorers
      .slice(0, 3)
      .map((m) => `${m.tool} (score: ${m.compositeScore.toFixed(2)})`)
      .join(", ");
    recs.push(`Low-scoring tools may need workflow review: ${names}`);
  }

  const highRedundancy = metrics.filter((m) => m.redundancyScore > 0.7 && m.totalCalls >= 5);
  if (highRedundancy.length > 0) {
    const names = highRedundancy
      .slice(0, 3)
      .map((m) => `${m.tool} (avg ${m.avgCallsPerSession.toFixed(1)}x/session)`)
      .join(", ");
    recs.push(`Highly redundant tools (called many times per session): ${names}`);
  }

  const lowSuccess = metrics.filter((m) => m.successRate < 0.5 && m.totalCalls >= 5);
  if (lowSuccess.length > 0) {
    const names = lowSuccess
      .slice(0, 3)
      .map((m) => `${m.tool} (${(m.successRate * 100).toFixed(0)}% success)`)
      .join(", ");
    recs.push(`Tools with low success rates: ${names}`);
  }

  if (recs.length === 0) {
    const topTool = metrics[0];
    if (topTool) {
      recs.push(`Best performing tool: ${topTool.tool} (score: ${topTool.compositeScore.toFixed(2)})`);
    }
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute tool effectiveness scores from a workflow store database.
 *
 * @param workflowDbPath  Path to the workflow_traces SQLite database.
 * @param effectivenessDb Pre-opened ToolEffectivenessStore (optional; created if omitted).
 * @param cfg             Configuration.
 * @param logger          Optional logger.
 * @returns               Effectiveness report.
 */
export async function computeToolEffectiveness(
  workflowDbPath: string,
  effectivenessDb: ToolEffectivenessStore | null,
  cfg: Partial<ToolEffectivenessConfig> = {},
  logger: { warn?: (msg: string) => void } = {},
): Promise<ToolEffectivenessReport> {
  const minCalls = cfg.minCalls ?? 3;
  const topN = cfg.topN ?? 10;
  const lowScoreThreshold = cfg.lowScoreThreshold ?? 0.3;
  const decayFactor = cfg.decayFactor ?? 0.95;

  const report: ToolEffectivenessReport = {
    computedAt: Math.floor(Date.now() / 1000),
    toolsScored: 0,
    topTools: [],
    lowScoreTools: [],
    allScores: [],
    recommendations: [],
  };

  // Open the workflow traces DB (read-only if possible)
  let traceDb: DatabaseSync | null = null;
  let ownedEffStore = false;
  let effStore = effectivenessDb;

  try {
    traceDb = new DatabaseSync(workflowDbPath, { readOnly: true });
    traceDb.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    // Check table exists
    const tableExists = traceDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_traces'`)
      .get() as { name: string } | undefined;

    if (!tableExists) {
      logger.warn?.("tool-effectiveness: workflow_traces table not found — no traces recorded yet");
      return report;
    }

    // Pull all traces
    const rows = traceDb
      .prepare("SELECT tool_sequence, outcome, duration_ms, session_id FROM workflow_traces")
      .all() as unknown as TraceRow[];

    if (rows.length === 0) {
      return report;
    }

    // Compute metrics
    const metrics = aggregateTraceRows(rows, minCalls);

    if (metrics.length === 0) {
      return report;
    }

    // Apply decay and upsert into effectivenessDb
    if (!effStore) {
      const effPath = workflowDbPath.replace(/(\.[^.]+)?$/, "-tool-effectiveness.db");
      effStore = new ToolEffectivenessStore(effPath);
      ownedEffStore = true;
    }

    effStore.applyDecay(decayFactor);

    for (const m of metrics) {
      effStore.upsert(m);
    }

    // Read back all scores (includes decayed history)
    const allScores = effStore.getAll();
    report.toolsScored = allScores.length;
    report.allScores = allScores;
    report.topTools = allScores.slice(0, topN);
    report.lowScoreTools = allScores.filter((m) => m.compositeScore < lowScoreThreshold && m.totalCalls >= minCalls);
    report.recommendations = generateRecommendations(allScores, lowScoreThreshold);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { operation: "tool-effectiveness" });
    logger.warn?.(`tool-effectiveness: error computing scores: ${err}`);
  } finally {
    try {
      traceDb?.close();
    } catch {
      // ignore
    }
    if (ownedEffStore && effStore) {
      try {
        effStore.close();
      } catch {
        // ignore
      }
    }
  }

  return report;
}

/**
 * Format a ToolEffectivenessReport as a human-readable string.
 */
export function formatToolEffectivenessReport(report: ToolEffectivenessReport): string {
  if (report.toolsScored === 0) {
    return "No tool effectiveness data available. Enable workflowTracking and run more sessions.";
  }

  const lines: string[] = [
    `Tool Effectiveness Report (${new Date(report.computedAt * 1000).toISOString()})`,
    `Tools scored: ${report.toolsScored}`,
    "",
    "Top Tools:",
  ];

  for (const t of report.topTools.slice(0, 10)) {
    lines.push(
      `  ${t.tool}: score=${t.compositeScore.toFixed(3)} ` +
        `success=${(t.successRate * 100).toFixed(0)}% ` +
        `calls=${t.totalCalls} ` +
        `redundancy=${(t.redundancyScore * 100).toFixed(0)}%`,
    );
  }

  if (report.lowScoreTools.length > 0) {
    lines.push("", "⚠ Low-Score Tools:");
    for (const t of report.lowScoreTools) {
      lines.push(`  ${t.tool}: score=${t.compositeScore.toFixed(3)} ` + `success=${(t.successRate * 100).toFixed(0)}%`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const r of report.recommendations) {
      lines.push(`  • ${r}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gap 5: Tool preference hints
// ---------------------------------------------------------------------------

/**
 * Generate a tool-preference hint string for the given context.
 *
 * Only includes tools that have >= minUses calls in the given context and where
 * the score difference between the best and worst tool exceeds hintThreshold.
 *
 * @param store          ToolEffectivenessStore with scored data.
 * @param context        Context label to filter scores by.
 * @param minUses        Minimum total calls required (default 5).
 * @param hintThreshold  Minimum score spread required to emit a hint (default 0.3).
 * @returns              Hint string, or empty string if no meaningful data.
 */
export function generateToolHint(
  store: ToolEffectivenessStore,
  context: string,
  minUses = 5,
  hintThreshold = 0.3,
): string {
  // Get all rows for this context
  const all = store.getAll().filter((m) => m.context === context && m.totalCalls >= minUses);

  if (all.length < 2) return "";

  // Sort by compositeScore DESC
  const sorted = [...all].sort((a, b) => b.compositeScore - a.compositeScore);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;

  if (best.compositeScore - worst.compositeScore < hintThreshold) return "";

  // Build the hint
  const toolList = sorted
    .map((m) => `${m.tool} scores ${m.compositeScore.toFixed(1)} (${m.totalCalls} uses)`)
    .join(", ");

  return `[tool-hint: For "${context}" tasks, ${toolList}. Prefer ${best.tool}.]`;
}

// ---------------------------------------------------------------------------
// Gap 6: Monthly PATTERN_FACT report
// ---------------------------------------------------------------------------

/**
 * Generate a monthly tool effectiveness summary and store it as a pattern fact.
 *
 * @param store    ToolEffectivenessStore with scored data.
 * @param factsDb  Facts database to store the pattern fact.
 */
export async function generateMonthlyReport(store: ToolEffectivenessStore, factsDb: FactsDB): Promise<void> {
  try {
    const allScores = store.getAll();

    if (allScores.length === 0) {
      return;
    }

    const top5 = allScores
      .slice(0, 5)
      .map((m) => `${m.tool}(${m.compositeScore.toFixed(2)})`)
      .join(", ");

    const lowScorers = allScores
      .filter((m) => m.compositeScore < 0.3 && m.totalCalls >= 5)
      .slice(0, 3)
      .map((m) => `${m.tool}(${m.compositeScore.toFixed(2)})`)
      .join(", ");

    const totalTools = allScores.length;
    const avgScore = allScores.reduce((sum, m) => sum + m.compositeScore, 0) / totalTools;

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    const summaryLines = [
      `Monthly tool effectiveness report (${month}):`,
      `${totalTools} tools scored, avg composite score: ${avgScore.toFixed(3)}.`,
      `Top tools: ${top5}.`,
    ];
    if (lowScorers) {
      summaryLines.push(`Low-scoring tools (score < 0.3): ${lowScorers}.`);
    }

    const summary = summaryLines.join(" ");

    factsDb.store({
      text: summary,
      category: "pattern",
      entity: null,
      key: `tool-effectiveness-monthly-${month}`,
      value: null,
      importance: 0.7,
      confidence: 0.9,
      scope: "global",
      source: "tool-effectiveness",
      tags: ["tool-effectiveness", "monthly-report"],
      summary: `Tool effectiveness summary for ${month}`,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "tool-effectiveness-monthly-report",
    });
  }
}
