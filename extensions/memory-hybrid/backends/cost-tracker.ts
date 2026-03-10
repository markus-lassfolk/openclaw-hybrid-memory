/**
 * LLM Cost Tracker — persists per-call token usage into llm_cost_log table
 * and intelligent-automation savings into llm_savings_log, both in the
 * existing memory.db SQLite database (shared with FactsDB).
 *
 * ⚠️ Costs are estimates based on published model pricing, not billing-accurate.
 */

import type Database from "better-sqlite3";
import { estimateCost } from "../services/model-pricing.js";

/**
 * A savings entry records work performed automatically that would have
 * otherwise required manual LLM calls or human effort.
 * E.g. self-correction auto-fixing an incident, or auto-classify batching N facts.
 */
export interface SavingsEntry {
  /** Feature that generated the savings (e.g. 'self-correction', 'auto-classify'). */
  feature: string;
  /** Human-readable description of the action (e.g. 'auto-fixed incident'). */
  action: string;
  /** Number of individual operations that were avoided or batched. */
  countAvoided: number;
  /** Estimated USD value of the savings (may be 0 if unknown). */
  estimatedSavingUsd: number;
  /** Optional free-text note for debugging. */
  note?: string;
}

export interface SavingsFeatureRow {
  feature: string;
  /** Number of recordSavings() calls contributing to this feature. */
  entries: number;
  countAvoided: number;
  estimatedSavingUsd: number;
}

export interface SavingsReport {
  features: SavingsFeatureRow[];
  total: {
    entries: number;
    countAvoided: number;
    estimatedSavingUsd: number;
  };
  days: number;
}

export interface CostEntry {
  feature: string;         // e.g. 'auto-classify', 'query-expansion'
  model: string;           // e.g. 'openai/gpt-4.1-nano'
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  success?: boolean;       // default true
}

export interface FeatureCostRow {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelBreakdown {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface CostReport {
  features: FeatureCostRow[];
  total: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  days: number;
  /** Number of calls whose model was not in the pricing table (estimated_cost_usd IS NULL). */
  unknownModelCalls: number;
  /** Distinct unrecognized model names (for the warning message). */
  unknownModels: string[];
}

export class CostTracker {
  private readonly db: Database.Database;
  /** Rate-limit: log at most one DB error per session to avoid spamming the console. */
  private _errorLogged = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_cost_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL,
        duration_ms INTEGER,
        success INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_cost_log_feature ON llm_cost_log(feature);
      CREATE INDEX IF NOT EXISTS idx_cost_log_timestamp ON llm_cost_log(timestamp);

      CREATE TABLE IF NOT EXISTS llm_savings_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        feature TEXT NOT NULL,
        action TEXT NOT NULL,
        count_avoided INTEGER NOT NULL DEFAULT 0,
        estimated_saving_usd REAL NOT NULL DEFAULT 0,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_savings_log_feature ON llm_savings_log(feature);
      CREATE INDEX IF NOT EXISTS idx_savings_log_timestamp ON llm_savings_log(timestamp);
    `);
    // Correct mis-prefixed model names (e.g. gateway sent openai/gemini-* → store as google/gemini-*)
    try {
      this.db.exec(`
        UPDATE llm_cost_log SET model = 'google/' || substr(model, 8) WHERE model LIKE 'openai/gemini-%';
        UPDATE llm_cost_log SET model = 'anthropic/' || substr(model, 8) WHERE model LIKE 'openai/claude-%';
      `);
    } catch {
      // ignore
    }
  }

  record(entry: CostEntry): void {
    try {
      const cost = estimateCost(entry.model, entry.inputTokens, entry.outputTokens);
      this.db
        .prepare(
          `INSERT INTO llm_cost_log (feature, model, input_tokens, output_tokens, estimated_cost_usd, duration_ms, success)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.feature,
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          cost,
          entry.durationMs ?? null,
          (entry.success ?? true) ? 1 : 0,
        );
    } catch (err) {
      // Never let cost tracking break LLM calls — but log the first failure per session for debuggability
      if (!this._errorLogged) {
        this._errorLogged = true;
        console.warn(`[cost-tracker] Failed to record cost entry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getReport(options: { days?: number; feature?: string } = {}): CostReport {
    const days = options.days ?? 7;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    let query =
      `SELECT feature,
              COUNT(*) AS calls,
              SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens,
              COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
       FROM llm_cost_log
       WHERE timestamp >= ?`;
    const params: (number | string)[] = [cutoff];

    if (options.feature) {
      query += ` AND feature = ?`;
      params.push(options.feature);
    }
    query += ` GROUP BY feature ORDER BY estimatedCostUsd DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      feature: string;
      calls: number | bigint;
      inputTokens: number | bigint;
      outputTokens: number | bigint;
      estimatedCostUsd: number;
    }>;

    const features: FeatureCostRow[] = rows.map((r) => ({
      feature: r.feature,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      estimatedCostUsd: r.estimatedCostUsd ?? 0,
    }));

    const total = features.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );

    // Unknown-model query: calls where estimated_cost_usd IS NULL
    let unknownModelCalls = 0;
    let unknownModels: string[] = [];
    try {
      let unknownQuery = `SELECT COUNT(*) AS cnt, GROUP_CONCAT(DISTINCT model) AS models
         FROM llm_cost_log WHERE timestamp >= ? AND estimated_cost_usd IS NULL`;
      const unknownParams: (number | string)[] = [cutoff];
      if (options.feature) {
        unknownQuery += ` AND feature = ?`;
        unknownParams.push(options.feature);
      }
      const unknownRow = this.db.prepare(unknownQuery).get(...unknownParams) as {
        cnt: number | bigint;
        models: string | null;
      } | undefined;
      unknownModelCalls = Number(unknownRow?.cnt ?? 0);
      unknownModels = unknownRow?.models ? unknownRow.models.split(",").filter(Boolean) : [];
    } catch { /* best-effort */ }

    return { features, total, days, unknownModelCalls, unknownModels };
  }

  getModelBreakdown(days = 7): ModelBreakdown[] {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db
      .prepare(
        `SELECT model,
                COUNT(*) AS calls,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
         FROM llm_cost_log
         WHERE timestamp >= ?
         GROUP BY model
         ORDER BY estimatedCostUsd DESC`,
      )
      .all(cutoff) as Array<{
      model: string;
      calls: number | bigint;
      inputTokens: number | bigint;
      outputTokens: number | bigint;
      estimatedCostUsd: number;
    }>;

    return rows.map((r) => ({
      model: r.model,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      estimatedCostUsd: r.estimatedCostUsd ?? 0,
    }));
  }

  getTotalCost(days = 7): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  } {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
         FROM llm_cost_log
         WHERE timestamp >= ?`,
      )
      .get(cutoff) as {
      calls: number | bigint;
      inputTokens: number | bigint;
      outputTokens: number | bigint;
      estimatedCostUsd: number;
    };

    return {
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      estimatedCostUsd: row.estimatedCostUsd ?? 0,
    };
  }

  /**
   * Record an intelligent-automation saving event.
   * Call this whenever a lifecycle feature does work that avoids manual LLM calls.
   */
  recordSavings(entry: SavingsEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO llm_savings_log (feature, action, count_avoided, estimated_saving_usd, note)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          entry.feature,
          entry.action,
          entry.countAvoided,
          entry.estimatedSavingUsd,
          entry.note ?? null,
        );
    } catch (err) {
      if (!this._errorLogged) {
        this._errorLogged = true;
        console.warn(`[cost-tracker] Failed to record savings entry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Return a savings report grouped by feature for the last `days` days.
   */
  getSavingsReport(days = 7): SavingsReport {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = this.db
      .prepare(
        `SELECT feature,
                COUNT(*) AS entries,
                SUM(count_avoided) AS countAvoided,
                SUM(estimated_saving_usd) AS estimatedSavingUsd
         FROM llm_savings_log
         WHERE timestamp >= ?
         GROUP BY feature
         ORDER BY estimatedSavingUsd DESC`,
      )
      .all(cutoff) as Array<{
        feature: string;
        entries: number | bigint;
        countAvoided: number | bigint;
        estimatedSavingUsd: number;
      }>;

    const features: SavingsFeatureRow[] = rows.map((r) => ({
      feature: r.feature,
      entries: Number(r.entries),
      countAvoided: Number(r.countAvoided),
      estimatedSavingUsd: r.estimatedSavingUsd ?? 0,
    }));

    const total = features.reduce(
      (acc, r) => ({
        entries: acc.entries + r.entries,
        countAvoided: acc.countAvoided + r.countAvoided,
        estimatedSavingUsd: acc.estimatedSavingUsd + r.estimatedSavingUsd,
      }),
      { entries: 0, countAvoided: 0, estimatedSavingUsd: 0 },
    );

    return { features, total, days };
  }

  /**
   * Delete entries older than retainDays (default 90). Returns number deleted.
   * Prunes both llm_cost_log and llm_savings_log.
   */
  pruneOldEntries(retainDays = 90): number {
    const cutoff = Math.floor(Date.now() / 1000) - retainDays * 86400;
    const costResult = this.db
      .prepare(`DELETE FROM llm_cost_log WHERE timestamp < ?`)
      .run(cutoff);
    const savingsResult = this.db
      .prepare(`DELETE FROM llm_savings_log WHERE timestamp < ?`)
      .run(cutoff);
    return costResult.changes + savingsResult.changes;
  }
}
