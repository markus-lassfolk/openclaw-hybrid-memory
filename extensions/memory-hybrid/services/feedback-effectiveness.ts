/**
 * Closed-loop measurement: track whether generated rules/proposals actually
 * improve outcomes by comparing feedback signals before and after rule creation.
 * Issue #262 — Phase 3.
 */

import { capturePluginError } from "./error-reporter.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ClosedLoopConfig } from "../config/types/features.js";

export interface FeedbackEffectiveness {
  ruleId: string;
  ruleText: string;
  createdAt: number;
  windowStart: number;
  windowEnd: number;
  correctionsBeforeRule: number;
  correctionsAfterRule: number;
  praiseBeforeRule: number;
  praiseAfterRule: number;
  implicitPositiveBefore: number;
  implicitPositiveAfter: number;
  implicitNegativeBefore: number;
  implicitNegativeAfter: number;
  effectScore: number; // -1 to +1
  confidence: number;
  sampleSize: number;
}

export interface ClosedLoopReport {
  measuredAt: number;
  rulesAnalyzed: number;
  deprecated: number;
  boosted: number;
  measurements: FeedbackEffectiveness[];
}

/**
 * Count feedback events (corrections/praise/implicit) in a time window.
 * Uses the reinforcement_log for praise, self_correction_log equivalent for corrections,
 * and implicit_signals table for implicit feedback.
 */
function countFeedbackInWindow(
  factsDb: FactsDB,
  windowStart: number,
  windowEnd: number,
  topic?: string,
): {
  corrections: number;
  praise: number;
  implicitPositive: number;
  implicitNegative: number;
} {
  // Use the raw DB via a type-cast to access the db instance for direct SQL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
  if (!db) return { corrections: 0, praise: 0, implicitPositive: 0, implicitNegative: 0 };

  let corrections = 0;
  let praise = 0;
  let implicitPositive = 0;
  let implicitNegative = 0;

  try {
    // Corrections from facts table (source = 'self-correction-analysis')
    const correctionsQ = topic
      ? `SELECT COUNT(*) as cnt FROM facts WHERE source = 'self-correction-analysis' AND created_at >= ? AND created_at <= ? AND (text LIKE ? OR summary LIKE ?)`
      : `SELECT COUNT(*) as cnt FROM facts WHERE source = 'self-correction-analysis' AND created_at >= ? AND created_at <= ?`;
    const correctionsRow = topic
      ? (db.prepare(correctionsQ).get(windowStart, windowEnd, `%${topic}%`, `%${topic}%`) as { cnt: number })
      : (db.prepare(correctionsQ).get(windowStart, windowEnd) as { cnt: number });
    corrections = correctionsRow?.cnt ?? 0;
  } catch {
    // table may not exist
  }

  try {
    // Praise from reinforcement_log (positive signal = reinforcement)
    const praiseQ = topic
      ? `SELECT COUNT(*) as cnt FROM reinforcement_log WHERE occurred_at >= ? AND occurred_at <= ? AND (topic LIKE ?)`
      : `SELECT COUNT(*) as cnt FROM reinforcement_log WHERE occurred_at >= ? AND occurred_at <= ?`;
    const praiseRow = topic
      ? (db.prepare(praiseQ).get(windowStart, windowEnd, `%${topic}%`) as { cnt: number })
      : (db.prepare(praiseQ).get(windowStart, windowEnd) as { cnt: number });
    praise = praiseRow?.cnt ?? 0;
  } catch {
    // table may not exist
  }

  try {
    // Implicit signals
    const implQ = topic
      ? `SELECT polarity, COUNT(*) as cnt FROM implicit_signals WHERE created_at >= ? AND created_at <= ? AND (user_message LIKE ? OR agent_message LIKE ?) GROUP BY polarity`
      : `SELECT polarity, COUNT(*) as cnt FROM implicit_signals WHERE created_at >= ? AND created_at <= ? GROUP BY polarity`;
    const implRows = topic
      ? (db.prepare(implQ).all(windowStart, windowEnd, `%${topic}%`, `%${topic}%`) as Array<{
          polarity: string;
          cnt: number;
        }>)
      : (db.prepare(implQ).all(windowStart, windowEnd) as Array<{ polarity: string; cnt: number }>);
    for (const row of implRows) {
      if (row.polarity === "positive") implicitPositive = row.cnt;
      if (row.polarity === "negative") implicitNegative = row.cnt;
    }
  } catch {
    // table may not exist
  }

  return { corrections, praise, implicitPositive, implicitNegative };
}

/**
 * Measure effectiveness of a single rule.
 */
export function measureRuleEffectiveness(
  ruleId: string,
  factsDb: FactsDB,
  config: Partial<ClosedLoopConfig>,
): FeedbackEffectiveness | null {
  try {
    const windowDays = config.measurementWindowDays ?? 7;
    const windowSec = windowDays * 24 * 60 * 60;

    // Get rule from facts DB
    const rule = factsDb.getById(ruleId);
    if (!rule) return null;

    const ruleCreatedAt = rule.createdAt; // epoch seconds
    const windowStart = ruleCreatedAt - windowSec;
    const windowEnd = ruleCreatedAt + windowSec;

    const topicTags = Array.isArray(rule.tags) ? rule.tags : [];
    const topic = topicTags.find((t) => !["reinforcement", "behavioral", "trajectory", "feedback"].includes(t));

    const before = countFeedbackInWindow(factsDb, windowStart, ruleCreatedAt, topic);
    const after = countFeedbackInWindow(factsDb, ruleCreatedAt + 1, windowEnd, topic);

    const beforeTotal = before.corrections + before.praise + before.implicitPositive + before.implicitNegative;
    const afterTotal = after.corrections + after.praise + after.implicitPositive + after.implicitNegative;
    const sampleSize = beforeTotal + afterTotal;

    const beforePositive = before.praise + before.implicitPositive;
    const beforeNegative = before.corrections + before.implicitNegative;
    const afterPositive = after.praise + after.implicitPositive;
    const afterNegative = after.corrections + after.implicitNegative;

    // Effect score: positive improvement minus negative deterioration, normalized by before total
    const denom = Math.max(beforeTotal, 1);
    const effectScore = (afterPositive - beforePositive) / denom - (afterNegative - beforeNegative) / denom;
    const clampedScore = Math.max(-1, Math.min(1, effectScore));

    // Confidence scales with sample size
    const confidence = Math.min(1.0, (sampleSize / Math.max(config.minSampleSize ?? 5, 1)) * 0.5);

    return {
      ruleId,
      ruleText: rule.text,
      createdAt: ruleCreatedAt,
      windowStart,
      windowEnd,
      correctionsBeforeRule: before.corrections,
      correctionsAfterRule: after.corrections,
      praiseBeforeRule: before.praise,
      praiseAfterRule: after.praise,
      implicitPositiveBefore: before.implicitPositive,
      implicitPositiveAfter: after.implicitPositive,
      implicitNegativeBefore: before.implicitNegative,
      implicitNegativeAfter: after.implicitNegative,
      effectScore: clampedScore,
      confidence,
      sampleSize,
    };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "measureRuleEffectiveness",
      severity: "warning",
      subsystem: "feedback-effectiveness",
    });
    return null;
  }
}

/**
 * Run closed-loop analysis across all relevant rules/patterns created in last 30 days.
 */
export function runClosedLoopAnalysis(factsDb: FactsDB, config: Partial<ClosedLoopConfig>): ClosedLoopReport {
  const report: ClosedLoopReport = {
    measuredAt: Math.floor(Date.now() / 1000),
    rulesAnalyzed: 0,
    deprecated: 0,
    boosted: 0,
    measurements: [],
  };

  if (config.enabled === false) return report;

  const minSampleSize = config.minSampleSize ?? 5;
  const deprecateThreshold = config.autoDeprecateThreshold ?? -0.3;
  const boostThreshold = config.autoBoostThreshold ?? 0.5;
  const windowDays = config.measurementWindowDays ?? 7;
  const lookbackSec = 30 * 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - lookbackSec;

  try {
    // Find rules/patterns created in last 30 days
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
    if (!db) return report;

    const rows = db
      .prepare(
        `SELECT id FROM facts WHERE created_at >= ? AND (category = 'technical' OR category = 'pattern') AND source IN ('reinforcement-analysis', 'self-correction-analysis', 'implicit-feedback')`,
      )
      .all(cutoff) as Array<{ id: string }>;

    for (const row of rows) {
      const m = measureRuleEffectiveness(row.id, factsDb, config);
      if (!m) continue;

      // Only act on rules with enough age (at least windowDays old)
      const ageSec = report.measuredAt - m.createdAt;
      const minAgeSec = windowDays * 24 * 60 * 60;
      if (ageSec < minAgeSec) continue;
      if (m.sampleSize < minSampleSize) continue;

      report.rulesAnalyzed++;
      report.measurements.push(m);

      // Auto-deprecate harmful rules
      if (m.effectScore < deprecateThreshold) {
        try {
          // Lower confidence to 0.1 to effectively deprecate the rule
          db.prepare(`UPDATE facts SET importance = 0.1 WHERE id = ?`).run(row.id);
          report.deprecated++;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runClosedLoopAnalysis:deprecate",
            severity: "warning",
            subsystem: "feedback-effectiveness",
          });
        }
      }

      // Auto-boost proven rules
      if (m.effectScore > boostThreshold) {
        try {
          db.prepare(`UPDATE facts SET importance = MIN(1.0, importance + 0.2) WHERE id = ?`).run(row.id);
          report.boosted++;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runClosedLoopAnalysis:boost",
            severity: "warning",
            subsystem: "feedback-effectiveness",
          });
        }
      }

      // Persist measurement
      try {
        db.prepare(
          `
          INSERT OR REPLACE INTO feedback_effectiveness (
            rule_id, rule_text, created_at, window_start, window_end,
            corrections_before, corrections_after, praise_before, praise_after,
            implicit_positive_before, implicit_positive_after,
            implicit_negative_before, implicit_negative_after,
            effect_score, confidence, sample_size, measured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          m.ruleId,
          m.ruleText,
          m.createdAt,
          m.windowStart,
          m.windowEnd,
          m.correctionsBeforeRule,
          m.correctionsAfterRule,
          m.praiseBeforeRule,
          m.praiseAfterRule,
          m.implicitPositiveBefore,
          m.implicitPositiveAfter,
          m.implicitNegativeBefore,
          m.implicitNegativeAfter,
          m.effectScore,
          m.confidence,
          m.sampleSize,
          report.measuredAt,
        );
      } catch {
        // table may not exist yet, skip silently
      }
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "runClosedLoopAnalysis",
      severity: "warning",
      subsystem: "feedback-effectiveness",
    });
  }

  return report;
}

/**
 * Generate a human-readable effectiveness report.
 */
export function getEffectivenessReport(factsDb: FactsDB): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (factsDb as any).liveDb as import("better-sqlite3").Database | undefined;
    if (!db) return "No database available.";

    const rows = db
      .prepare(
        `SELECT rule_id, rule_text, effect_score, confidence, sample_size, measured_at
         FROM feedback_effectiveness
         ORDER BY measured_at DESC
         LIMIT 20`,
      )
      .all() as Array<{
      rule_id: string;
      rule_text: string;
      effect_score: number;
      confidence: number;
      sample_size: number;
      measured_at: number;
    }>;

    if (rows.length === 0) return "No feedback effectiveness data available yet.";

    const lines: string[] = ["# Feedback Effectiveness Report", ""];
    for (const row of rows) {
      const scoreStr = row.effect_score.toFixed(2);
      const icon = row.effect_score > 0.3 ? "✓" : row.effect_score < -0.2 ? "✗" : "~";
      const rulePreview = row.rule_text.slice(0, 80);
      lines.push(`${icon} [${scoreStr}] "${rulePreview}" (n=${row.sample_size}, conf=${row.confidence.toFixed(2)})`);
    }

    return lines.join("\n");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "getEffectivenessReport",
      severity: "info",
      subsystem: "feedback-effectiveness",
    });
    return "Error generating report.";
  }
}
