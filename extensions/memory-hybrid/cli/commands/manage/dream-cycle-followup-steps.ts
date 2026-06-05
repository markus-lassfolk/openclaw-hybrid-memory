/**
 * Dream-cycle follow-up stages extracted for independent orchestrator scheduling.
 */

import type { HybridMemoryConfig } from "../../../config.js";
import type { FactsDB } from "../../../backends/facts-db.js";
import type { ChangeFeed } from "../../../services/change-feed.js";
import { runCrystallizationProposalCycle } from "../../../services/crystallization-maintenance.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../../../services/feedback-effectiveness.js";

export interface DreamCycleFollowUpDeps {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  changeFeed?: ChangeFeed | null;
  runContinuousVerification?: (opts?: { verbose?: boolean }) => Promise<{
    checked: number;
    confirmed: number;
    stale: number;
    uncertain: number;
    errors: number;
  }>;
  runExtractImplicitFeedback?: (opts: {
    days?: number;
    dryRun: boolean;
    includeClosedLoop?: boolean;
    verbose?: boolean;
  }) => Promise<{
    signalsExtracted: number;
    positiveCount: number;
    negativeCount: number;
    sessionsProcessed: number;
    sessionsScanned: number;
    partial?: boolean;
    partialReason?: string;
  }>;
  runCrossAgentLearning?: (opts?: { verbose?: boolean }) => Promise<{
    generalisedStored: number;
    agentsScanned: number;
    errors: number;
  }>;
  runToolEffectiveness?: (opts?: { verbose?: boolean }) => Promise<string>;
  pruneCostLog?: (retainDays?: number) => number | Promise<number>;
}

export async function runContinuousVerificationStep(
  deps: DreamCycleFollowUpDeps,
  verbose = false,
): Promise<string> {
  if (!deps.runContinuousVerification) return "skipped (handler unavailable)";
  const res = await deps.runContinuousVerification(verbose ? { verbose: true } : undefined);
  if (res.errors > 0) {
    throw new Error(`${res.errors}/${res.checked} verification check(s) errored`);
  }
  return `checked=${res.checked} confirmed=${res.confirmed} stale=${res.stale}`;
}

export async function runExtractImplicitStep(deps: DreamCycleFollowUpDeps, verbose = false): Promise<string> {
  if (!deps.runExtractImplicitFeedback) return "skipped (handler unavailable)";
  const res = await deps.runExtractImplicitFeedback({
    dryRun: false,
    includeClosedLoop: false,
    verbose,
  });
  const summary = `${res.signalsExtracted} signals (${res.positiveCount}+/${res.negativeCount}-) from ${res.sessionsProcessed}/${res.sessionsScanned} sessions semantic=${res.partial ? "partial" : "success"}`;
  if (res.partial) {
    throw new Error(`extract-implicit partial failure (${res.partialReason ?? "capped"}): ${summary}`);
  }
  return summary;
}

export async function runClosedLoopAnalysisStep(deps: DreamCycleFollowUpDeps, verbose = false): Promise<string> {
  const clReport = await runClosedLoopAnalysis(deps.factsDb, deps.cfg.closedLoop ?? { enabled: true }, {
    verbose,
    logger: () => {},
  });
  return `${clReport.rulesAnalyzed} rules measured, ${clReport.deprecated} deprecated, ${clReport.boosted} boosted`;
}

export async function runCrossAgentLearningStep(deps: DreamCycleFollowUpDeps, verbose = false): Promise<string> {
  if (!deps.runCrossAgentLearning) return "skipped (handler unavailable)";
  const res = await deps.runCrossAgentLearning(verbose ? { verbose: true } : undefined);
  if (res.errors > 0) {
    throw new Error(`cross-agent-learning batch errors=${res.errors}`);
  }
  return `${res.generalisedStored} patterns from ${res.agentsScanned} agents`;
}

export async function runToolEffectivenessStep(deps: DreamCycleFollowUpDeps, verbose = false): Promise<string> {
  if (!deps.runToolEffectiveness) return "skipped (handler unavailable)";
  const output = await deps.runToolEffectiveness({ verbose });
  const firstLine = (typeof output === "string" ? output : "").split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("No tool effectiveness data available")) return `no-op (${firstLine})`;
  if (firstLine.length === 0) throw new Error("unexpected empty output");
  return firstLine.slice(0, 120);
}

export async function runCrystallizationProposalsStep(deps: DreamCycleFollowUpDeps): Promise<string> {
  const crystalRes = runCrystallizationProposalCycle(deps.cfg, {
    changeFeed: deps.changeFeed ?? null,
  });
  if (crystalRes.skippedReason === "disabled") return "skipped (disabled)";
  if (crystalRes.skippedReason === "stores-unavailable") {
    throw new Error(crystalRes.reasons[0] ?? "crystallization stores unavailable");
  }
  return `proposed=${crystalRes.proposed}, skipped=${crystalRes.skipped}`;
}

export async function runCostLogPruneStep(deps: DreamCycleFollowUpDeps): Promise<string> {
  if (!deps.pruneCostLog) return "skipped (handler unavailable)";
  const pruned = await Promise.resolve(deps.pruneCostLog(deps.cfg.costTracking?.retainDays));
  return pruned > 0 ? `pruned ${pruned} entries` : "nothing to prune";
}

export function buildDreamCycleFollowUpDepsFromBindings(b: import("./bindings.js").ManageBindings): DreamCycleFollowUpDeps {
  return {
    cfg: b.cfg,
    factsDb: b.factsDb,
    changeFeed: b.changeFeed ?? null,
    runContinuousVerification: b.runContinuousVerification,
    runExtractImplicitFeedback: b.runExtractImplicitFeedback,
    runCrossAgentLearning: b.runCrossAgentLearning,
    runToolEffectiveness: b.runToolEffectiveness,
    pruneCostLog: b.pruneCostLog,
  };
}
