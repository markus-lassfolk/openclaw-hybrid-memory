/**
 * Feedback & Learning CLI Handlers
 *
 * Implements feedback-related CLI commands:
 *   - extract-implicit-feedback — scan sessions for implicit positive/negative signals
 *   - cross-agent-learning      — generalise lessons across agent memory databases
 *   - tool-effectiveness        — compute and report tool usage effectiveness scores
 *   - cost-report               — show LLM cost breakdown by feature or model
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import { getCronModelConfig, getDefaultCronModel, getLLMModelPreference, isCompactVerbosity } from "../config.js";
import type { ReinforcementContext } from "../backends/facts-db.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractImplicitSignals, parseSessionTurns } from "../services/implicit-feedback-extract.js";
import { buildTrajectories, serializeTrajectory, analyzeTrajectoriesWithLLM } from "../services/trajectory-tracker.js";
import { runClosedLoopAnalysis, getEffectivenessReport } from "../services/feedback-effectiveness.js";
import { runCrossAgentLearning } from "../services/cross-agent-learning.js";
import {
  computeToolEffectiveness,
  formatToolEffectivenessReport,
  ToolEffectivenessStore,
  generateMonthlyReport,
} from "../services/tool-effectiveness.js";
import { getModeCostEstimates } from "../services/model-pricing.js";
import { chatCompleteWithRetry } from "../services/chat.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import type { HandlerContext } from "./handlers.js";
import { getSessionFilePathsSince } from "./cmd-extract.js";

// ---------------------------------------------------------------------------
// extract-implicit-feedback
// ---------------------------------------------------------------------------

/**
 * Extract implicit feedback signals from recent sessions.
 * Signals are routed to the reinforcement pipeline (positive) or stored as
 * pattern facts for self-correction (negative). Trajectories and closed-loop
 * analysis are run as subsequent phases when not disabled.
 */
export async function runExtractImplicitFeedbackForCli(
  ctx: HandlerContext,
  opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
  },
): Promise<{
  signalsExtracted: number;
  positiveCount: number;
  negativeCount: number;
  trajectoriesBuilt: number;
  sessionsScanned: number;
  closedLoopReport?: string;
}> {
  const { factsDb, cfg, logger, openai } = ctx;
  const days = opts.days ?? 3;
  const sessionDir = cfg.procedures.sessionsDir;
  const filePaths = getSessionFilePathsSince(sessionDir, days);

  const implicitCfg = cfg.implicitFeedback ?? {
    enabled: true,
    minConfidence: 0.5,
    signalTypes: undefined,
    rephraseThreshold: 0.8,
    topicChangeThreshold: 0.3,
    terseResponseRatio: 0.4,
    feedToReinforcement: true,
    feedToSelfCorrection: true,
  };

  if (implicitCfg.enabled === false) {
    return { signalsExtracted: 0, positiveCount: 0, negativeCount: 0, trajectoriesBuilt: 0, sessionsScanned: 0 };
  }

  let totalSignals = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let trajectoriesBuilt = 0;

  const rawDb = factsDb.getRawDb();

  for (const filePath of filePaths) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n");
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:read-file",
        severity: "info",
        subsystem: "implicit-feedback",
      });
      continue;
    }

    const sessionFile = basename(filePath);
    const turns = parseSessionTurns(lines);
    if (turns.length < 3) continue;

    // Phase 1: Extract implicit signals
    const signals = extractImplicitSignals(turns, implicitCfg, sessionFile);

    if (opts.verbose) {
      for (const sig of signals) {
        logger?.info?.(
          `[${sessionFile}] ${sig.type} (${sig.polarity}, conf ${sig.confidence.toFixed(2)}): ${sig.context.userMessage.slice(0, 60)}`,
        );
      }
    }

    totalSignals += signals.length;
    for (const sig of signals) {
      if (sig.polarity === "positive") positiveCount++;
      else if (sig.polarity === "negative") negativeCount++;
    }

    if (!opts.dryRun && rawDb) {
      // Store raw signals in implicit_signals table
      try {
        const insert = rawDb.prepare(`
          INSERT OR IGNORE INTO implicit_signals (session_file, signal_type, confidence, polarity, user_message, agent_message, preceding_turns, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'implicit')
        `);
        for (const sig of signals) {
          try {
            insert.run(
              sig.context.sessionFile,
              sig.type,
              sig.confidence,
              sig.polarity,
              sig.context.userMessage.slice(0, 500),
              sig.context.agentMessage.slice(0, 500),
              sig.context.precedingTurns,
            );
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-signal",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:store-signals",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }

    // Route positive signals to reinforcement pipeline
    if (!opts.dryRun && implicitCfg.feedToReinforcement !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const positiveSignals = signals.filter((s) => s.polarity === "positive" && s.confidence >= minConf);
      const trackContext = cfg.reinforcement?.trackContext !== false;
      const maxEventsPerFact = cfg.reinforcement?.maxEventsPerFact ?? 50;
      for (const sig of positiveSignals) {
        try {
          const searchQuery = sig.context.agentMessage || sig.context.userMessage;
          const matches = factsDb.search(searchQuery, 3);
          const context: ReinforcementContext = {
            querySnippet: sig.context.userMessage.slice(0, 200),
            topic: sig.type,
            sessionFile: sig.context.sessionFile,
          };
          for (const match of matches) {
            factsDb.reinforceFact(match.entry.id, sig.context.userMessage, context, {
              trackContext,
              maxEventsPerFact,
              boostAmount: 0.5 * sig.confidence, // weaker than explicit praise
            });
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:feed-reinforcement",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
    }

    // Route negative signals to self-correction pipeline as pattern facts
    if (!opts.dryRun && implicitCfg.feedToSelfCorrection !== false && signals.length > 0) {
      const minConf = implicitCfg.minConfidence ?? 0.5;
      const negativeSignals = signals.filter((s) => s.polarity === "negative" && s.confidence >= minConf);
      for (const sig of negativeSignals) {
        try {
          const text = `[Implicit ${sig.type}] "${sig.context.userMessage.slice(0, 200)}"`;
          if (!factsDb.hasDuplicate(text)) {
            factsDb.store({
              text,
              category: "pattern",
              importance: Math.max(0.3, sig.confidence * 0.6),
              entity: null,
              key: null,
              value: text.slice(0, 200),
              source: "implicit-feedback",
              tags: ["implicit-feedback", "negative", sig.type],
            });
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "runExtractImplicitFeedbackForCli:feed-self-correction",
            severity: "info",
            subsystem: "implicit-feedback",
          });
        }
      }
    }

    // Phase 2: Build trajectories
    if (opts.includeTrajectories !== false && !opts.dryRun && rawDb) {
      try {
        const trajectories = buildTrajectories(turns, sessionFile);
        trajectoriesBuilt += trajectories.length;

        const insertTraj = rawDb.prepare(`
          INSERT OR REPLACE INTO feedback_trajectories
            (id, session_file, turns_json, outcome, outcome_signal, key_pivot, lessons_json, topic, tools_used, turn_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const traj of trajectories) {
          try {
            // If LLM analysis is enabled, use it to enhance lessons
            if (implicitCfg.trajectoryLLMAnalysis) {
              try {
                const prompt = loadPrompt("trajectory-analyze");
                const nanoPref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
                const model = nanoPref[0] ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
                const fallbackModels = nanoPref.length > 1 ? nanoPref.slice(1) : (cfg.distill?.fallbackModels ?? []);
                const chatFn = async (opts: { model?: string; messages: Array<{ role: string; content: string }> }) => {
                  const userMessage = opts.messages.find((m) => m.role === "user");
                  if (!userMessage) throw new Error("No user message found");
                  return await chatCompleteWithRetry({
                    model: opts.model ?? model,
                    content: userMessage.content,
                    temperature: 0.2,
                    maxTokens: 4000,
                    openai,
                    fallbackModels,
                    label: "memory-hybrid: trajectory-analyze",
                  });
                };
                const llmAnalysis = await analyzeTrajectoriesWithLLM(traj, prompt, chatFn);
                if (llmAnalysis) {
                  // Replace heuristic lessons with LLM-produced lesson and patterns
                  traj.lessonsExtracted = [llmAnalysis.keyLesson, ...llmAnalysis.patterns];
                  if (llmAnalysis.pivotTurn !== null) {
                    traj.keyPivot = llmAnalysis.pivotTurn;
                  }
                  if (llmAnalysis.outcome) {
                    traj.outcome = llmAnalysis.outcome;
                  }
                }
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "runExtractImplicitFeedbackForCli:llm-trajectory-analysis",
                  severity: "info",
                  subsystem: "implicit-feedback",
                });
              }
            }

            const row = serializeTrajectory(traj);
            insertTraj.run(
              row.id,
              row.session_file,
              row.turns_json,
              row.outcome,
              row.outcome_signal,
              row.key_pivot,
              row.lessons_json,
              row.topic,
              row.tools_used,
              row.turn_count,
            );
            // Store lessons as PATTERN_FACT entries in factsDb
            for (const lesson of traj.lessonsExtracted) {
              if (!lesson.trim() || factsDb.hasDuplicate(lesson)) continue;
              try {
                factsDb.store({
                  text: lesson,
                  category: "pattern",
                  importance: 0.6,
                  entity: null,
                  key: null,
                  value: lesson.slice(0, 200),
                  source: "implicit-feedback",
                  tags: ["trajectory", "feedback"],
                });
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "runExtractImplicitFeedbackForCli:store-lesson",
                  severity: "info",
                  subsystem: "implicit-feedback",
                });
              }
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "runExtractImplicitFeedbackForCli:insert-trajectory",
              severity: "info",
              subsystem: "implicit-feedback",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "runExtractImplicitFeedbackForCli:build-trajectories",
          severity: "warning",
          subsystem: "implicit-feedback",
        });
      }
    }
  }

  // Phase 3: Closed-loop analysis
  let closedLoopReport: string | undefined;
  if (opts.includeClosedLoop !== false && !opts.dryRun) {
    try {
      const clCfg = cfg.closedLoop ?? { enabled: true };
      if (clCfg.enabled !== false) {
        const report = runClosedLoopAnalysis(factsDb, clCfg);
        if (report.rulesAnalyzed > 0) {
          if (opts.verbose) {
            closedLoopReport = getEffectivenessReport(factsDb);
          }
          logger?.info?.(
            `Closed-loop: analyzed ${report.rulesAnalyzed} rules, deprecated ${report.deprecated}, boosted ${report.boosted}`,
          );
        }
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "runExtractImplicitFeedbackForCli:closed-loop",
        severity: "warning",
        subsystem: "implicit-feedback",
      });
    }
  }

  return {
    signalsExtracted: totalSignals,
    positiveCount,
    negativeCount,
    trajectoriesBuilt,
    sessionsScanned: filePaths.length,
    closedLoopReport,
  };
}

// ---------------------------------------------------------------------------
// cross-agent-learning
// ---------------------------------------------------------------------------

export interface CrossAgentLearningCliResult {
  agentsScanned: number;
  lessonsConsidered: number;
  generalisedStored: number;
  linksCreated: number;
  skippedDuplicates: number;
  errors: number;
}

/**
 * Run cross-agent learning: scan peer agent databases and generalise shared lessons.
 */
export async function runCrossAgentLearningForCli(ctx: HandlerContext): Promise<CrossAgentLearningCliResult> {
  const { factsDb, cfg } = ctx;
  const caCfg = cfg.crossAgentLearning;

  if (!caCfg?.enabled) {
    return {
      agentsScanned: 0,
      lessonsConsidered: 0,
      generalisedStored: 0,
      linksCreated: 0,
      skippedDuplicates: 0,
      errors: 0,
    };
  }

  // Build OpenAI proxy
  const openai = ctx.openai;

  const result = await runCrossAgentLearning(factsDb, openai, caCfg, ctx.logger ?? {});

  // Record savings: each generalised pattern avoids re-learning by other agents
  if (result.generalisedStored > 0 && ctx.costTracker) {
    ctx.costTracker.recordSavings({
      feature: "cross-agent-learning",
      action: "generalised pattern stored",
      countAvoided: result.generalisedStored,
      estimatedSavingUsd: result.generalisedStored * 0.001,
      note: `${result.agentsScanned} agent(s) scanned, ${result.skippedDuplicates} duplicates skipped`,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// tool-effectiveness
// ---------------------------------------------------------------------------

/**
 * Compute and format a tool effectiveness report.
 */
export async function runToolEffectivenessForCli(
  ctx: HandlerContext,
  opts: { verbose?: boolean } = {},
): Promise<string> {
  const { cfg } = ctx;
  const teCfg = cfg.toolEffectiveness;

  if (teCfg?.enabled === false) {
    return "Tool effectiveness scoring is disabled (toolEffectiveness.enabled = false).";
  }

  // Derive the workflow store DB path from the sqlite path
  const sqlitePath = cfg.sqlitePath ?? join(homedir(), ".openclaw", "memory", "memory.db");
  const workflowDbPath = sqlitePath.replace(/(\.[^.]+)?$/, "-workflows.db");
  const effectivenessDbPath = sqlitePath.replace(/(\.[^.]+)?$/, "-tool-effectiveness.db");

  const effStore = new ToolEffectivenessStore(effectivenessDbPath);
  try {
    const report = await computeToolEffectiveness(workflowDbPath, effStore, teCfg ?? {}, ctx.logger ?? {});

    // Gap 3 (#263): Generate monthly report, gated to once per calendar month
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthlyKey = `tool-effectiveness-monthly-${month}`;
    try {
      const rawDb = ctx.factsDb.getRawDb();
      const existing = rawDb
        .prepare(`SELECT id FROM facts WHERE key = ? AND superseded_at IS NULL LIMIT 1`)
        .get(monthlyKey);
      if (!existing) {
        await generateMonthlyReport(effStore, ctx.factsDb);
      }
    } catch (mrErr) {
      capturePluginError(mrErr instanceof Error ? mrErr : new Error(String(mrErr)), {
        operation: "tool-effectiveness-monthly-report-check",
        subsystem: "tool-effectiveness",
        severity: "info",
      });
    }

    return formatToolEffectivenessReport(report);
  } finally {
    effStore.close();
  }
}

// ---------------------------------------------------------------------------
// cost-report
// ---------------------------------------------------------------------------

export interface CostReportCliOpts {
  days?: number;
  model?: boolean;
  feature?: string;
  csv?: boolean;
  /** Output format: "pretty" (default, emoji + percentages) or "compact" (terse, no emoji). */
  format?: "pretty" | "compact";
  /** Show config-mode cost estimate table instead of live data. */
  modes?: boolean;
}

/**
 * Show LLM cost breakdown by feature (or model with --model flag).
 * Issue #270.
 */
export function runCostReportForCli(
  ctx: HandlerContext,
  opts: CostReportCliOpts,
  sink: { log: (msg: string) => void },
): void {
  const { costTracker } = ctx;
  const { log } = sink;
  const days = opts.days ?? 7;
  const verbosity = ctx.cfg.verbosity ?? "normal";
  // quiet: only totals (compact layout); normal/verbose: full per-feature breakdown with savings
  const compact = opts.format === "compact" || isCompactVerbosity(verbosity);

  // --modes: show config-mode cost estimate table (no live data needed)
  if (opts.modes) {
    const estimates = getModeCostEstimates();
    if (!compact) {
      log("");
      log("📊 Config-Mode Cost Estimates ($/month, estimated)");
      log("   Based on typical usage with the default cheapest model (gpt-4.1-nano).");
      log("   Actual costs depend on your volume, model choices, and feature config.");
      log("");
    } else {
      log("───── Config-Mode Cost Estimates ─────");
    }
    const modeW = 12;
    const descW = 58;
    const costW = 20;
    const header = ["Mode".padEnd(modeW), "Description".padEnd(descW), "Est. $/month".padStart(costW)].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const e of estimates) {
      const costRange = `$${e.monthlyLow.toFixed(2)} – $${e.monthlyHigh.toFixed(2)}`;
      log([e.mode.padEnd(modeW), e.description.padEnd(descW), costRange.padStart(costW)].join("  "));
      if (!compact) {
        log(`${"".padEnd(modeW)}  Features: ${e.features.join(", ")}`);
        log("");
      }
    }
    if (!compact) {
      log(`Set mode: openclaw hybrid-mem config-mode <mode>`);
    }
    return;
  }

  if (!costTracker) {
    if (!ctx.cfg.costTracking?.enabled) {
      log("Cost tracking is disabled.");
      log("Enable it: openclaw hybrid-mem config-set costTracking enabled");
    } else {
      log("Cost tracking is not available (costTracker not initialized).");
    }
    return;
  }

  function fmtNum(n: number): string {
    return n.toLocaleString("en-US");
  }
  function fmtCost(n: number): string {
    return `$${n.toFixed(4)}`;
  }
  function pct(part: number, total: number): string {
    if (total === 0) return "  0%";
    return `${Math.round((part / total) * 100)}%`.padStart(4);
  }

  if (opts.model) {
    // Model breakdown
    const breakdown = costTracker.getModelBreakdown(days);
    if (breakdown.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log(`   Data appears after your first LLM calls (~1 hour of typical use).`);
      }
      return;
    }
    if (opts.csv) {
      log("model,calls,input_tokens,output_tokens,est_cost_usd");
      for (const r of breakdown) {
        log(`${r.model},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)}`);
      }
      return;
    }
    const total = breakdown.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );
    if (!compact) {
      log(`\n📊 LLM Cost Report — by Model (last ${days} days)`);
      log(`💰 Total: ${fmtCost(total.estimatedCostUsd)} across ${total.calls} calls`);
      log("");
    } else {
      log(`\n───── LLM Cost by Model (last ${days} days) ─────`);
    }
    const colW = [Math.max(20, ...breakdown.map((r) => r.model.length)) + 2, 8, 12, 12, 12, 5];
    const header = [
      "Model".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
      ...(compact ? [] : ["  %".padStart(colW[5]!)]),
    ].join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of breakdown) {
      log(
        [
          r.model.padEnd(colW[0]!),
          String(r.calls).padStart(colW[1]!),
          fmtNum(r.inputTokens).padStart(colW[2]!),
          fmtNum(r.outputTokens).padStart(colW[3]!),
          fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
          ...(compact ? [] : [pct(r.estimatedCostUsd, total.estimatedCostUsd).padStart(colW[5]!)]),
        ].join("  "),
      );
    }
    log("─".repeat(header.length));
    log(
      [
        "Total".padEnd(colW[0]!),
        String(total.calls).padStart(colW[1]!),
        fmtNum(total.inputTokens).padStart(colW[2]!),
        fmtNum(total.outputTokens).padStart(colW[3]!),
        fmtCost(total.estimatedCostUsd).padStart(colW[4]!),
        ...(compact ? [] : ["100%".padStart(colW[5]!)]),
      ].join("  "),
    );
  } else {
    // Feature breakdown
    const report = costTracker.getReport({ days, feature: opts.feature });
    const savingsReport = costTracker.getSavingsReport(days);

    // Build a savings lookup by feature for fast join
    const savingsByFeature = new Map<string, number>();
    for (const s of savingsReport.features) {
      savingsByFeature.set(s.feature, s.estimatedSavingUsd);
    }

    if (report.features.length === 0) {
      if (compact) {
        log(`No LLM cost data in the last ${days} days.`);
      } else {
        log(`\n✅ Cost tracking is active — no data yet for the last ${days} days.`);
        log(`   Costs will appear here after your first LLM calls (~1 hour of typical use).`);
      }
      // Still show savings if any exist (value delivered without cost)
      if (savingsReport.total.estimatedSavingUsd > 0 && !compact) {
        log(
          `\n💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`,
        );
      }
      return;
    }
    if (opts.csv) {
      log("feature,calls,input_tokens,output_tokens,est_cost_usd,est_savings_usd,net_cost_usd");
      for (const r of report.features) {
        const savings = savingsByFeature.get(r.feature) ?? 0;
        log(
          `${r.feature},${r.calls},${r.inputTokens},${r.outputTokens},${r.estimatedCostUsd.toFixed(6)},${savings.toFixed(6)},${(r.estimatedCostUsd - savings).toFixed(6)}`,
        );
      }
      return;
    }

    const totalSavings = savingsReport.total.estimatedSavingUsd;
    const netCost = report.total.estimatedCostUsd - totalSavings;

    if (!compact) {
      const featureCount = report.features.length;
      log(`\n📊 LLM Cost Report — last ${days} days`);
      log(
        `💰 Gross cost: ${fmtCost(report.total.estimatedCostUsd)} across ${featureCount} feature${featureCount === 1 ? "" : "s"} (${report.total.calls} LLM calls)`,
      );
      if (totalSavings > 0) {
        log(`💚 Automation savings: ${fmtCost(totalSavings)} (${savingsReport.total.countAvoided} ops avoided)`);
        log(`📉 Net cost: ${fmtCost(Math.max(0, netCost))}`);
      }
      log("");
    } else {
      log(`\n───── LLM Cost Report (last ${days} days) ─────`);
    }

    const hasSavings = totalSavings > 0;
    // Column widths: Feature | Calls | In-Tokens | Out-Tokens | Est.Cost | [Savings] | [Net] | [%]
    const colW = [
      Math.max(20, ...report.features.map((r) => r.feature.length)) + 2,
      8,
      12,
      12,
      12,
      ...(hasSavings ? [12, 12] : []),
      ...(compact ? [] : [5]),
    ];
    const headerParts = [
      "Feature".padEnd(colW[0]!),
      "Calls".padStart(colW[1]!),
      "In-Tokens".padStart(colW[2]!),
      "Out-Tokens".padStart(colW[3]!),
      "Est. Cost".padStart(colW[4]!),
    ];
    if (hasSavings) {
      headerParts.push("Savings".padStart(colW[5]!));
      headerParts.push("Net Cost".padStart(colW[6]!));
    }
    if (!compact) {
      headerParts.push("  %".padStart(colW[hasSavings ? 7 : 5]!));
    }
    const header = headerParts.join("  ");
    log(header);
    log("─".repeat(header.length));
    for (const r of report.features) {
      const savings = savingsByFeature.get(r.feature) ?? 0;
      const net = Math.max(0, r.estimatedCostUsd - savings);
      const parts = [
        r.feature.padEnd(colW[0]!),
        String(r.calls).padStart(colW[1]!),
        fmtNum(r.inputTokens).padStart(colW[2]!),
        fmtNum(r.outputTokens).padStart(colW[3]!),
        fmtCost(r.estimatedCostUsd).padStart(colW[4]!),
      ];
      if (hasSavings) {
        parts.push((savings > 0 ? `-$${savings.toFixed(4)}` : "").padStart(colW[5]!));
        parts.push(fmtCost(net).padStart(colW[6]!));
      }
      if (!compact) {
        parts.push(pct(r.estimatedCostUsd, report.total.estimatedCostUsd).padStart(colW[hasSavings ? 7 : 5]!));
      }
      log(parts.join("  "));
    }
    log("─".repeat(header.length));
    const totalParts = [
      "Total".padEnd(colW[0]!),
      String(report.total.calls).padStart(colW[1]!),
      fmtNum(report.total.inputTokens).padStart(colW[2]!),
      fmtNum(report.total.outputTokens).padStart(colW[3]!),
      fmtCost(report.total.estimatedCostUsd).padStart(colW[4]!),
    ];
    if (hasSavings) {
      totalParts.push(`-$${totalSavings.toFixed(4)}`.padStart(colW[5]!));
      totalParts.push(fmtCost(Math.max(0, netCost)).padStart(colW[6]!));
    }
    if (!compact) {
      totalParts.push("100%".padStart(colW[hasSavings ? 7 : 5]!));
    }
    log(totalParts.join("  "));
    log("");
    // Unknown-model warning
    if (report.unknownModelCalls > 0) {
      log(
        `⚠️  ${report.unknownModelCalls} call(s) used unrecognized models (cost unknown): ${report.unknownModels.join(", ")}`,
      );
    }
    // Model summary line
    const modelBreakdown = costTracker.getModelBreakdown(days);
    if (modelBreakdown.length > 0) {
      const modelSummary = modelBreakdown.map((m) => `${m.model} (${m.calls} calls)`).join(", ");
      log(`Models used: ${modelSummary}`);
    }
    // Savings breakdown if any (and we have savings not already shown inline)
    if (!hasSavings && savingsReport.features.length > 0) {
      log("");
      log(
        `💚 Automation savings (last ${days} days): ${fmtCost(savingsReport.total.estimatedSavingUsd)} (${savingsReport.total.countAvoided} ops avoided)`,
      );
    }
  }
  log("");
  log("ℹ️  Costs are estimates based on published model pricing. Actual costs may vary.");
  log("   Embedding calls are not included in this report.");
}
