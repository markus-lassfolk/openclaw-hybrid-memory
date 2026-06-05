/**
 * Maintenance step runners — wire orchestrator steps to service/CLI implementations.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { EventBus } from "../../../backends/event-bus.js";
import type { FactsDB } from "../../../backends/facts-db.js";
import type { VectorDB } from "../../../backends/vector-db.js";
import type { HybridMemoryConfig } from "../../../config.js";
import { getDefaultCronModel, getCronModelConfig } from "../../../config.js";
import { CrystallizationProposer } from "../../../services/crystallization-proposer.js";
import {
  DEFAULT_AMBIGUOUS_BACKLOG_DEGRADED_THRESHOLD,
  ORCHESTRATOR_CONTRADICTION_DEGRADED_CONSECUTIVE_THRESHOLD,
  runContradictionMaintenanceAutoStep,
} from "../../../services/contradiction-progress-summary.js";
import { syncLifecycleFromGitHub } from "../../../services/lifecycle/github-adapter.js";
import { runAnalyzeMaintenanceLogs } from "./register-analyze-maintenance-logs.js";
import { buildAuditHealthReport } from "./storage-stats-helpers.js";
import { buildAuditHealthExitInfo } from "../../../services/audit-health-exit-info.js";
import { recordStorageGrowthSample } from "./storage-stats-helpers.js";
import { runPendingDigestAutopilotCron } from "../../../services/pending-digest-autopilot-cron.js";
import { buildPendingReviewDigestReport } from "../../../services/pending-review-digest.js";
import { reconcileOrphanVectors } from "../../../services/vector-maintenance.js";
import { sweepAll } from "../../../services/sensor-sweep.js";
import { runAutoClassify } from "../../../services/auto-classifier.js";
import { runPassiveObserver } from "../../../services/passive-observer.js";
import { deleteVectorsForFactIds } from "../../../services/vector-maintenance.js";
import type { MaintenanceStepRunner } from "../../../services/maintenance-orchestrator.js";
import type { ManageBindings } from "./bindings.js";
import {
  buildDreamCycleFollowUpDepsFromBindings,
  runClosedLoopAnalysisStep,
  runContinuousVerificationStep,
  runCostLogPruneStep,
  runCrossAgentLearningStep,
  runCrystallizationProposalsStep,
  runExtractImplicitStep,
  runToolEffectivenessStep,
} from "./dream-cycle-followup-steps.js";
import { cleanupImplicitFeedbackDuplicates } from "../../cmd-feedback.js";
import { resolveScanMaintenanceOverrides, type ScanMaintenanceOverrideInput } from "../../maintenance-overrides.js";
import { nowIso } from "../../../utils/dates.js";
import {
  parseSemanticTokenFromSummary,
  semanticOutcomeBlocksOrchestratorGuard,
  semanticOutcomeIsPartialFailure,
} from "../../../services/maintenance-job-run/index.js";

function reflectRulesDiagnosticsIndicateFailure(
  d:
    | {
        parseSuccess: boolean;
        status: "ok" | "partial" | "degraded";
        zeroRulesReason?: string;
        modelResponseChars?: number;
      }
    | undefined,
  rulesStored: number,
): boolean {
  if (!d) return false;
  if (d.zeroRulesReason === "insufficient_patterns" || d.zeroRulesReason === "valid_no_actionable_rules") {
    return false;
  }
  if (d.zeroRulesReason === "invalid_response_format" && d.status === "degraded" && (d.modelResponseChars ?? 0) > 0) {
    return false;
  }
  if (d.status === "degraded") return true;
  if (d.status === "ok") return false;
  return !d.parseSuccess || rulesStored === 0;
}

export interface BuildCliRunnersOptions {
  verbose?: boolean;
  backfillDecayMarker?: string;
  /** When set, propagates --force/--full to scan-style maintenance commands. */
  scanOverrides?: ScanMaintenanceOverrideInput;
}

function scanForceFlags(opts: BuildCliRunnersOptions): { force?: boolean; full?: boolean } {
  const { bypassScanCooldown, bypassWatermark } = resolveScanMaintenanceOverrides(opts.scanOverrides);
  if (!bypassScanCooldown && !bypassWatermark) return {};
  return { force: true, full: true };
}

function noopLog(): void {}

async function runSensorSweepForCli(b: ManageBindings): Promise<string> {
  if (!b.cfg.sensorSweep?.enabled) return "skipped (sensorSweep disabled)";
  const eventBusPath = b.resolvedSqlitePath ? join(dirname(b.resolvedSqlitePath), "event-bus.db") : null;
  if (!eventBusPath) return "skipped (no event bus path)";

  let eventBus: EventBus = b.eventBus ?? new EventBus(eventBusPath);
  const ownsBus = !b.eventBus;
  try {
    const r = await sweepAll(eventBus, b.cfg.sensorSweep, b.factsDb, {
      tier: "all",
      resolvedSqlitePath: b.resolvedSqlitePath,
    });
    if (r.errors.length > 0) {
      throw new Error(`sensor-sweep errors=${r.errors.length}: ${r.errors.slice(0, 3).join("; ")}`);
    }
    return `written=${r.totalWritten} skipped=${r.totalSkipped} errors=0`;
  } finally {
    if (ownsBus) eventBus.close?.();
  }
}

function formatExtractImplicitSummary(res: {
  signalsExtracted: number;
  positiveCount: number;
  negativeCount: number;
  sessionsProcessed: number;
  sessionsScanned: number;
  partial?: boolean;
}): string {
  return `${res.signalsExtracted} signals (${res.positiveCount}+/${res.negativeCount}-) from ${res.sessionsProcessed}/${res.sessionsScanned} sessions semantic=${res.partial ? "partial" : "success"}`;
}

function assertExtractImplicitNotPartial(res: { partial?: boolean; partialReason?: string }, summary: string): void {
  if (res.partial) {
    throw new Error(`extract-implicit partial failure (${res.partialReason ?? "capped"}): ${summary}`);
  }
}

function assertSemanticOutcomeDoesNotBlockStep(stepName: string, semantic: string | undefined, summary: string): void {
  if (!semantic || !semanticOutcomeBlocksOrchestratorGuard(semantic)) return;
  if (semanticOutcomeIsPartialFailure(semantic)) {
    throw new Error(`${stepName} partial failure (${summary})`);
  }
  throw new Error(`${stepName} semantic failure: ${semantic} (${summary})`);
}

function assertVectorCleanupNotPartial(stepName: string, cleanups: Array<{ failed: number }>, summary: string): void {
  const failures = cleanups.reduce((sum, c) => sum + c.failed, 0);
  if (failures === 0) return;
  throw new Error(`${stepName} partial vector cleanup failure (${summary})`);
}

function assertActiveTasksMaintainSummaryDoesNotBlock(summary: string): string {
  const status = summary.match(/\bstatus=(partial|failed)\b/i)?.[1]?.toLowerCase();
  const failed = Number.parseInt(summary.match(/\bfailed=(\d+)\b/i)?.[1] ?? "0", 10);
  const semantic = parseSemanticTokenFromSummary(summary);
  if (
    status === "partial" ||
    status === "failed" ||
    failed > 0 ||
    semanticOutcomeBlocksOrchestratorGuard(semantic)
  ) {
    const semanticSummary = summary.includes("semantic=") ? summary : `${summary} semantic=partial`;
    throw new Error(`active-tasks-maintain ${status ?? semantic ?? "partial"} failure (${semanticSummary})`);
  }
  return summary;
}

function assertPassiveObserverSummaryDoesNotBlock(summary: string): string {
  const errors = Number.parseInt(summary.match(/\berrors=(\d+)\b/i)?.[1] ?? "0", 10);
  const semantic = parseSemanticTokenFromSummary(summary);
  if (errors > 0 || semanticOutcomeBlocksOrchestratorGuard(semantic)) {
    const semanticSummary = summary.includes("semantic=") ? summary : `${summary} semantic=partial`;
    throw new Error(`passive-observer errors=${errors || "semantic"} (${semanticSummary})`);
  }
  return summary;
}

function formatEntityEnrichmentSummary(r: {
  processed: number;
  factsEnriched: number;
  llmFailures?: number;
  stopReason?: string;
  remainingTotal?: number;
}): string {
  const llmFailures = r.llmFailures ?? 0;
  const stopReason = r.stopReason ?? "completed";
  const incompleteCatchUp =
    stopReason === "exhausted" || stopReason === "time_budget" || stopReason === "provider_budget";
  const partial = llmFailures > 0 || incompleteCatchUp;
  return `processed=${r.processed} enriched=${r.factsEnriched} llmFailures=${llmFailures} stopReason=${stopReason} remaining=${r.remainingTotal ?? 0} semantic=${partial ? "partial" : "success"}`;
}

function assertEntityEnrichmentNotPartial(r: {
  llmFailures?: number;
  stopReason?: string;
}, summary: string): void {
  const llmFailures = r.llmFailures ?? 0;
  const stopReason = r.stopReason ?? "completed";
  const incompleteCatchUp =
    stopReason === "exhausted" || stopReason === "time_budget" || stopReason === "provider_budget";
  if (llmFailures > 0 || incompleteCatchUp) {
    throw new Error(`entity enrichment partial failure (${summary})`);
  }
}

function assertAnalyzeMaintenanceLogsSummaryDoesNotBlock(summary: string): string {
  const strictFail = /\bstrict=fail\b/i.test(summary);
  const semantic = parseSemanticTokenFromSummary(summary);
  if (strictFail || semanticOutcomeBlocksOrchestratorGuard(semantic)) {
    throw new Error(`analyze-maintenance-logs strict findings (${summary})`);
  }
  return summary;
}

function assertLifecycleSyncSummaryDoesNotBlock(summary: string): string {
  const syncErrors = Number.parseInt(summary.match(/\bsync_errors=(\d+)\b/i)?.[1] ?? "0", 10);
  const semantic = parseSemanticTokenFromSummary(summary);
  if (syncErrors > 0 || semanticOutcomeBlocksOrchestratorGuard(semantic)) {
    const semanticSummary = summary.includes("semantic=") ? summary : `${summary} semantic=partial`;
    throw new Error(`lifecycle-sync partial failure (${semanticSummary})`);
  }
  return summary;
}

function assertRecordStorageSampleSummaryDoesNotBlock(summary: string): string {
  if (/\breason=storage_unavailable\b/i.test(summary)) {
    const semanticSummary = summary.includes("semantic=") ? summary : `${summary} semantic=partial`;
    throw new Error(`record-storage-sample storage unavailable (${semanticSummary})`);
  }
  return summary;
}

function resolveOpenclawHomeFromSqlitePath(resolvedSqlitePath: string | null | undefined): string {
  if (resolvedSqlitePath) return join(dirname(resolvedSqlitePath), "..");
  return join(homedir(), ".openclaw");
}

function assertContradictionMaintenanceSummaryDoesNotBlock(
  summary: string,
  evaluation: { degraded: boolean },
): string {
  const semantic = parseSemanticTokenFromSummary(summary);
  if (evaluation.degraded || semanticOutcomeBlocksOrchestratorGuard(semantic)) {
    throw new Error(`resolve-contradictions degraded backlog (${summary})`);
  }
  return summary;
}

export function buildCliMaintenanceRunners(
  b: ManageBindings,
  opts: BuildCliRunnersOptions = {},
): Map<string, MaintenanceStepRunner> {
  const verbose = opts.verbose ?? false;
  const sink = { log: noopLog, warn: noopLog };
  const runners = new Map<string, MaintenanceStepRunner>();
  const followUpDeps = buildDreamCycleFollowUpDepsFromBindings(b);
  const memoryDir = b.resolvedSqlitePath ? dirname(b.resolvedSqlitePath) : join(homedir(), ".openclaw", "memory");
  const backfillMarker = opts.backfillDecayMarker ?? join(memoryDir, ".backfill-decay-done");
  const scanFlags = scanForceFlags(opts);
  const maxCatchUpDays = b.cfg.maintenance?.orchestrator?.maxCatchUpDays ?? 14;

  const set = (name: string, fn: () => Promise<string>) => runners.set(name, fn);

  // --- Cycle ---
  set("prune", async () => {
    const pending = b.factsDb.listExpiredFactIdsPendingPrune();
    const n = b.factsDb.prune();
    const cleanup = await deleteVectorsForFactIds(b.vectorDb, pending, { operation: "orchestrator-prune" });
    const summary = `pruned=${n} vectors=${cleanup.deleted}/${cleanup.attempted} failures=${cleanup.failed} semantic=${cleanup.failed > 0 ? "partial" : "success"}`;
    assertVectorCleanupNotPartial("prune", [cleanup], summary);
    return summary;
  });

  set("compact", async () => {
    const c = await b.runCompaction({ apply: true });
    return `hot=${c.hot} warm=${c.warm} cold=${c.cold} semantic=success`;
  });

  set("auto-classify", async () => {
    const r = await b.runClassify({ dryRun: false, limit: b.cfg.autoClassify.batchSize ?? 20 });
    const batchFailures = r.batchFailures ?? 0;
    const summary = `reclassified=${r.reclassified}/${r.total} batchFailures=${batchFailures} semantic=${batchFailures > 0 ? "partial" : "success"}`;
    if (batchFailures > 0) {
      throw new Error(`auto-classify partial batch failures (${summary})`);
    }
    return summary;
  });

  set("record-storage-sample", async () => {
    let lanceBytes: number | null = null;
    try {
      const sizes = await Promise.resolve(b.richStatsExtras?.getStorageSizes());
      if (sizes && typeof sizes.lanceBytes === "number") lanceBytes = sizes.lanceBytes;
    } catch {
      /* non-fatal */
    }
    const r = recordStorageGrowthSample(b.factsDb, lanceBytes, {});
    const summary = `status=${r.status} reason=${r.reason ?? "none"} semantic=${r.reason === "storage_unavailable" ? "partial" : "success"}`;
    return assertRecordStorageSampleSummaryDoesNotBlock(summary);
  });

  set("analyze-maintenance-logs", async () => {
    const result = await runAnalyzeMaintenanceLogs({ since: "24h", format: "md", out: "-", noPersist: true }, b);
    return assertAnalyzeMaintenanceLogsSummaryDoesNotBlock(result.summary);
  });

  set("lifecycle-sync", async () => {
    const github = b.cfg.lifecycle?.adapters?.github;
    if (!github?.enabled) return "skipped (lifecycle github disabled)";
    const report = await syncLifecycleFromGitHub(b.factsDb, {
      config: github,
      apply: true,
    });
    const summary = `matched=${report.matched} expiredNow=${report.expiredNow} sync_errors=${report.errors.length} semantic=${report.errors.length > 0 ? "partial" : "success"}`;
    return assertLifecycleSyncSummaryDoesNotBlock(summary);
  });

  set("passive-observer", async () => {
    if (!b.cfg.passiveObserver?.enabled) return "skipped (passiveObserver disabled)";
    if (!b.runPassiveObserverOnce) throw new Error("passive-observer unavailable");
    return assertPassiveObserverSummaryDoesNotBlock(await b.runPassiveObserverOnce());
  });

  set("proposals-prune", async () => {
    if (b.cfg.personaProposals?.enabled === false) return "skipped (personaProposals disabled)";
    if (!b.proposalsDb) return "skipped (proposals store unavailable)";
    const n = b.proposalsDb.pruneExpired();
    return `pruned=${n} semantic=success`;
  });

  set("build-languages", async () => {
    const r = await b.runBuildLanguageKeywords({ dryRun: false });
    const summary = `languagesAdded=${r.languagesAdded ?? 0} semantic=${r.ok ? "success" : "partial"}`;
    if (!r.ok) throw new Error(`build-languages failed (${r.error ?? "unknown"} ${summary})`);
    return summary;
  });

  set("credentials-prune", async () => {
    if (!b.cfg.credentials?.enabled) return "skipped (credentials disabled)";
    const r = b.runCredentialsPrune({ dryRun: false, yes: true });
    return `removed=${r.removed ?? 0} semantic=success`;
  });

  set("sensor-sweep", async () => runSensorSweepForCli(b));

  set("active-tasks-maintain", async () => {
    if (!b.cfg.activeTask?.enabled) return "skipped (activeTask disabled)";
    if (!b.runActiveTasksMaintain) return "skipped (active-tasks maintain unavailable)";
    return assertActiveTasksMaintainSummaryDoesNotBlock(await b.runActiveTasksMaintain());
  });

  // --- Nightly staggered ---
  set("extract-daily", async () => {
    if (!b.runExtractDaily) throw new Error("extract-daily unavailable");
    const r = await b.runExtractDaily({ days: 7, dryRun: false, verbose }, sink);
    const vectorFailures = (r as { vectorFailures?: number }).vectorFailures ?? 0;
    const summary = `stored=${r.stored ?? r.totalStored ?? 0} vector_failures=${vectorFailures} semantic=${(r as { semanticOutcome?: string }).semanticOutcome ?? (vectorFailures > 0 ? "partial" : "success")}`;
    assertSemanticOutcomeDoesNotBlockStep(
      "extract-daily",
      (r as { semanticOutcome?: string }).semanticOutcome ?? (vectorFailures > 0 ? "partial" : undefined),
      summary,
    );
    return summary;
  });

  set("distill", async () => {
    if (!b.runDistill) throw new Error("distill unavailable");
    const r = await b.runDistill({ dryRun: false, verbose, days: maxCatchUpDays, ...scanFlags }, sink);
    const summary = `stored=${r.stored} sessions=${r.sessionsScanned} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    if (r.partialFailure) {
      throw new Error(`distill partial failure (${summary})`);
    }
    assertSemanticOutcomeDoesNotBlockStep("distill", r.semanticOutcome, summary);
    return summary;
  });

  set("resolve-contradictions", async () => {
    const openclawHome = resolveOpenclawHomeFromSqlitePath(b.resolvedSqlitePath);
    const { summary, evaluation } = await runContradictionMaintenanceAutoStep({
      openclawHome,
      degradedAmbiguousThreshold: DEFAULT_AMBIGUOUS_BACKLOG_DEGRADED_THRESHOLD,
      degradedConsecutiveThreshold: ORCHESTRATOR_CONTRADICTION_DEGRADED_CONSECUTIVE_THRESHOLD,
      runAuto: () =>
        b.runResolveContradictionsAuto({
          dryRun: false,
          targetRate: 0.8,
        }),
    });
    return assertContradictionMaintenanceSummaryDoesNotBlock(summary, evaluation);
  });

  set("enrich-entities", async () => {
    const r = await b.runEntityEnrichment({
      limit: 200,
      dryRun: false,
      adaptiveCatchUp: true,
      verbose,
    });
    const summary = formatEntityEnrichmentSummary(r);
    assertEntityEnrichmentNotPartial(r, summary);
    return summary;
  });

  set("extract-implicit", async () => {
    if (b.runExtractImplicitFeedback) {
      const res = await b.runExtractImplicitFeedback({
        dryRun: false,
        includeClosedLoop: false,
        verbose,
        ...scanFlags,
      });
      const summary = formatExtractImplicitSummary(res);
      assertExtractImplicitNotPartial(res, summary);
      return summary;
    }
    return runExtractImplicitStep(followUpDeps, verbose);
  });

  set("entity-mentions-cleanup", async () => {
    const summary = b.factsDb.cleanupEntityMentions({ limit: 200, apply: true });
    return `changedFacts=${summary.changedFacts} rowsScanned=${summary.rowsScanned} removedRows=${summary.removedRows} semantic=success`;
  });

  set("dream-cycle-core", async () => {
    if (!b.runDreamCycle) throw new Error("dream-cycle unavailable");
    const r = await b.runDreamCycle(verbose ? { verbose: true } : undefined);
    if (!r.skipped && !r.success) throw new Error(r.digestSummary);
    return r.skipped ? "skipped (disabled)" : r.digestSummary.slice(0, 120);
  });

  set("continuous-verification", async () => runContinuousVerificationStep(followUpDeps, verbose));
  set("closed-loop-analysis", async () => runClosedLoopAnalysisStep(followUpDeps, verbose));
  set("cross-agent-learning", async () => runCrossAgentLearningStep(followUpDeps, verbose));
  set("tool-effectiveness", async () => runToolEffectivenessStep(followUpDeps, verbose));
  set("crystallization-proposals", async () => runCrystallizationProposalsStep(followUpDeps));
  set("cost-log-prune", async () => runCostLogPruneStep(followUpDeps));

  set("self-correction-run", async () => {
    const r = await b.runSelfCorrectionRun({ dryRun: false, days: 1, verbose, ...scanFlags });
    const summary = `incidents=${r.incidentsFound} analysed=${r.analysed} toolsApplied=${r.toolsApplied ?? 0} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? r.status ?? "unknown"}`;
    assertSemanticOutcomeDoesNotBlockStep("self-correction-run", r.semanticOutcome ?? r.status, summary);
    return summary;
  });

  // --- Weekly cadence ---
  set("reflect", async () => {
    const r = await b.runReflection({
      window: b.reflectionConfig.defaultWindow,
      dryRun: false,
      model: b.reflectionConfig.model ?? getDefaultCronModel(getCronModelConfig(b.cfg), "maintenance"),
      verbose,
    });
    const summary = `patternsStored=${r.patternsStored} facts=${r.factsAnalyzed} semantic=${r.semanticOutcome ?? "success"}`;
    if (r.semanticOutcome === "failed") {
      throw new Error(`reflect LLM failure (${summary})`);
    }
    assertSemanticOutcomeDoesNotBlockStep("reflect", r.semanticOutcome, summary);
    return summary;
  });

  set("reflect-rules", async () => {
    const r = await b.runReflectionRules({ dryRun: false, model: b.reflectionConfig.model, verbose });
    const d = r.diagnostics;
    const summary = [
      `rulesStored=${r.rulesStored}`,
      `rulesExtracted=${r.rulesExtracted}`,
      d ? `parse_success=${d.parseSuccess}` : null,
      d?.zeroRulesReason ? `zero_rules_reason=${d.zeroRulesReason}` : null,
      d ? `status=${d.status}` : null,
      d?.status === "degraded" || reflectRulesDiagnosticsIndicateFailure(d, r.rulesStored) ? "semantic=failed" : null,
    ]
      .filter(Boolean)
      .join(" ");
    if (d?.status === "degraded" || reflectRulesDiagnosticsIndicateFailure(d, r.rulesStored)) {
      throw new Error(`reflect-rules semantic failure (${d?.zeroRulesReason ?? "degraded"}): ${summary}`);
    }
    return summary;
  });

  set("reflect-meta", async () => {
    const r = await b.runReflectionMeta({ dryRun: false, model: b.reflectionConfig.model, verbose });
    const d = r.diagnostics;
    const summary = [
      `metaStored=${r.metaStored}`,
      d ? `status=${d.status}` : null,
      d?.status === "partial" || d?.status === "degraded" ? "semantic=partial" : "semantic=success",
    ]
      .filter(Boolean)
      .join(" ");
    if (d?.status === "partial" || d?.status === "degraded") {
      throw new Error(`reflect-meta semantic failure (${d?.zeroMetasReason ?? d.status}): ${summary}`);
    }
    return summary;
  });

  set("reflect-identity", async () => {
    if (!b.runReflectIdentity) return "skipped (identity reflection unavailable)";
    const r = await b.runReflectIdentity({
      dryRun: false,
      window: b.reflectionConfig.defaultWindow,
      verbose,
    });
    const summary = `insightsStored=${r.insightsStored} insightsExtracted=${r.insightsExtracted} semantic=${r.semanticOutcome ?? "success"}`;
    if (r.semanticOutcome === "failed") {
      throw new Error(`reflect-identity semantic failure (${summary})`);
    }
    assertSemanticOutcomeDoesNotBlockStep("reflect-identity", r.semanticOutcome, summary);
    return summary;
  });

  set("extract-procedures", async () => {
    if (!b.runExtractProcedures) throw new Error("extract-procedures unavailable");
    const r = (await b.runExtractProcedures({ dryRun: false, verbose, ...scanFlags })) as {
      sessionsScanned?: number;
      readFailures?: number;
    };
    const readFailures = r.readFailures ?? 0;
    const summary = `sessions=${r.sessionsScanned ?? 0} readFailures=${readFailures} semantic=${readFailures > 0 ? "partial" : "success"}`;
    if (readFailures > 0) {
      throw new Error(`extract-procedures read failures (${summary})`);
    }
    return summary;
  });

  set("extract-directives", async () => {
    if (!b.runExtractDirectives) throw new Error("extract-directives unavailable");
    const r = await b.runExtractDirectives({ dryRun: false, verbose, ...scanFlags });
    const partial = r.partial === true || r.dedupeDegraded === true;
    const summary = `sessions=${r.sessionsScanned} stored=${r.stored ?? 0} partial=${partial} dedupeDegraded=${r.dedupeDegraded ?? false} semantic=${partial ? "partial" : "success"}`;
    if (partial) {
      throw new Error(`extract-directives partial failure (${r.cursorBlockedReason ?? "dedupe"}): ${summary}`);
    }
    return summary;
  });

  set("extract-reinforcement", async () => {
    if (!b.runExtractReinforcement) throw new Error("extract-reinforcement unavailable");
    const r = await b.runExtractReinforcement({ dryRun: false, verbose, ...scanFlags });
    const summary = `sessions=${r.sessionsScanned} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    if (r.annotationStatus === "degraded_model_or_parser" || r.annotationStatus === "failed_annotation") {
      throw new Error(`extract-reinforcement annotation failure: ${r.annotationStatus} (${summary})`);
    }
    assertSemanticOutcomeDoesNotBlockStep("extract-reinforcement", r.semanticOutcome, summary);
    return summary;
  });

  set("generate-auto-skills", async () => {
    if (!b.runGenerateAutoSkills) throw new Error("generate-auto-skills unavailable");
    const r = await b.runGenerateAutoSkills({ dryRun: false, verbose, apply: true });
    const failedValidation = r.summary?.failedValidation ?? 0;
    const failedEval = r.summary?.failedEval ?? 0;
    const partial = failedValidation > 0 || failedEval > 0;
    const summary = `generated=${r.generated} failedValidation=${failedValidation} failedEval=${failedEval} semantic=${partial ? "partial" : "success"}`;
    if (partial) {
      throw new Error(`generate-auto-skills validation failures (${summary})`);
    }
    return summary;
  });

  set("repair-vectors", async () => {
    const candidates = b.factsDb.listVectorlessActiveFacts({ limit: 200 });
    let reembedded = 0;
    let failures = 0;
    for (const fact of candidates.slice(0, 200)) {
      try {
        const vec = await b.embeddings.embed(fact.text);
        await b.vectorDb.store({
          id: fact.id,
          text: fact.text,
          vector: vec,
          importance: 0.5,
          category: fact.category,
        });
        reembedded++;
      } catch {
        failures++;
      }
    }
    const reconcile = await reconcileOrphanVectors(b.factsDb, b.vectorDb, { operation: "orchestrator-repair-vectors" });
    const partial = failures > 0 || reconcile.failed > 0;
    const summary = `reembedded=${reembedded}/${candidates.length} failures=${failures} orphans=${reconcile.orphansFound} orphan_cleanup_failed=${reconcile.failed} semantic=${partial ? "partial" : "success"}`;
    if (failures > 0) {
      throw new Error(`repair-vectors partial failure (${summary})`);
    }
    assertVectorCleanupNotPartial("repair-vectors", [reconcile], summary);
    return summary;
  });

  set("vectordb-optimize", async () => {
    const r = await b.vectorDb.optimize(7 * 24 * 60 * 60 * 1000);
    return `compacted=${r.compacted} freedBytes=${r.freedBytes ?? 0}`;
  });

  set("scope-promote", async () => {
    const candidates = b.factsDb.findSessionFactsForPromotion(7, 0.7);
    let promoted = 0;
    let skipped = 0;
    let failed = 0;
    for (const f of candidates) {
      const outcome = b.factsDb.promoteScopeToGlobalWithOutcome(f.id);
      if (outcome === "promoted") promoted++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }
    const partial = failed > 0;
    const summary = `promoted=${promoted}/${candidates.length} skipped=${skipped} failed=${failed} semantic=${partial ? "partial" : "success"}`;
    if (partial) {
      throw new Error(`scope-promote partial failure (${summary})`);
    }
    return summary;
  });

  set("decay-reclassify", async () => {
    const nightly = b.cfg.nightlyCycle;
    const report = b.factsDb.reclassifyDecayClasses({
      apply: true,
      inactiveDays: nightly?.reclassifyInactiveDays,
      promoteRecallCount: nightly?.reclassifyPromoteRecallCount,
    });
    return `reclassified=${report.changed} scanned=${report.scanned} semantic=success`;
  });

  set("implicit-feedback-collapse", async () => {
    let afterRowid = 0;
    let scanned = 0;
    let collapsed = 0;
    let carryCanonical: ReadonlyArray<{ id: string; text: string }> = [];
    for (;;) {
      const res = cleanupImplicitFeedbackDuplicates(b.factsDb, {
        threshold: 0.7,
        limit: 1000,
        includeLegacy: true,
        dryRun: false,
        afterRowid: afterRowid > 0 ? afterRowid : undefined,
        seedCanonical: carryCanonical,
      });
      scanned += res.scanned;
      collapsed += res.collapsed;
      carryCanonical = res.carryCanonical;
      if (res.interrupted) {
        const summary = `scanned=${scanned} collapsed=${collapsed} interrupted=true semantic=partial`;
        throw new Error(`implicit-feedback-collapse interrupted (${summary})`);
      }
      if (res.resumeAfterRowid === null) break;
      afterRowid = res.resumeAfterRowid;
    }
    return `scanned=${scanned} collapsed=${collapsed} semantic=success`;
  });

  set("audit-health", async () => {
    const report = buildAuditHealthReport(
      b.factsDb,
      b.getMemoryCategories,
      b.cfg.entityExtraction?.stopWords ?? [],
      b.cfg.graph?.hubDegreeCap,
    );
    const exitInfo = buildAuditHealthExitInfo({
      strict: true,
      warningCount: report.warningCount,
      errorCount: report.errorCount,
      ok: report.ok,
      status: report.status,
    });
    if (exitInfo.exitCode !== 0) {
      throw new Error(
        exitInfo.strictFailureReason ?? `${exitInfo.errorCount} error(s), ${exitInfo.warningCount} warning(s)`,
      );
    }
    return `warnings=${report.warningCount} errors=${report.errorCount}`;
  });

  set("crystallization-rescan", async () => {
    const store = (
      b as { crystallizationStore?: import("../../../backends/crystallization-store.js").CrystallizationStore | null }
    ).crystallizationStore;
    if (!store) return "skipped (crystallization store unavailable)";
    const proposer = new CrystallizationProposer(null, store, b.cfg.crystallization);
    const result = proposer.rescanInstalledSkills();
    if (result.errors.length > 0) {
      throw new Error(
        `crystallization-rescan errors=${result.errors.length} (${result.errors.join("; ")} semantic=partial)`,
      );
    }
    return `scanned=${result.scanned} quarantined=${result.quarantined} semantic=success`;
  });

  set("generate-proposals", async () => {
    if (!b.runGenerateProposals) throw new Error("generate-proposals unavailable");
    const r = await b.runGenerateProposals({ dryRun: false, verbose });
    const summary = `created=${r.created} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    assertSemanticOutcomeDoesNotBlockStep("generate-proposals", r.semanticOutcome, summary);
    return summary;
  });

  set("pending-digest", async () => {
    const report = buildPendingReviewDigestReport({ cfg: b.cfg, factsDb: b.factsDb, since: "7d" });
    return `sections=${report.sections.length} totalPending=${report.totalPendingItems}`;
  });

  set("digest-autopilot", async () => {
    const result = await runPendingDigestAutopilotCron({ cfg: b.cfg, factsDb: b.factsDb });
    const semantic =
      result.summary.status === "failed" || result.summary.status === "partial" ? "partial" : "success";
    if (result.summary.status === "failed" || result.summary.status === "partial") {
      throw new Error(`digest-autopilot ${result.summary.status} (status=${result.summary.status} semantic=${semantic})`);
    }
    return `status=${result.summary.status} semantic=${semantic}`;
  });

  set("consolidate", async () => {
    const model = getDefaultCronModel(getCronModelConfig(b.cfg), "default");
    const r = await b.runConsolidate({
      threshold: 0.92,
      includeStructured: false,
      dryRun: false,
      limit: 10,
      model,
    });
    const clustersFailed = (r as { clustersFailed?: number }).clustersFailed ?? 0;
    const vectorFailures = (r as { vectorFailures?: number }).vectorFailures ?? 0;
    const skipped = (r as { skipped?: boolean }).skipped === true;
    const semantic =
      (r as { semanticOutcome?: string }).semanticOutcome ??
      (skipped ? "failed" : clustersFailed > 0 || vectorFailures > 0 ? "partial" : "success");
    const summary = `merged=${r.merged} clusters=${r.clustersFound} clustersFailed=${clustersFailed} vector_failures=${vectorFailures} semantic=${semantic}`;
    if (skipped) {
      throw new Error(`consolidate skipped (${(r as { skipReason?: string }).skipReason ?? "unavailable"}): ${summary}`);
    }
    assertSemanticOutcomeDoesNotBlockStep("consolidate", semantic, summary);
    return summary;
  });

  set("backfill-decay", async () => {
    if (existsSync(backfillMarker)) return "already done";
    const n = b.factsDb.backfillDecay();
    const total = Object.values(n).reduce((a, c) => a + c, 0);
    writeFileSync(backfillMarker, `${nowIso()}\n`);
    return `backfilled=${total}`;
  });

  set("reembed-vectorless", async () => {
    const candidates = b.factsDb.listVectorlessActiveFacts({ limit: 1000 });
    let embedded = 0;
    let failures = 0;
    for (const fact of candidates) {
      try {
        const vec = await b.embeddings.embed(fact.text);
        await b.vectorDb.store({
          id: fact.id,
          text: fact.text,
          vector: vec,
          importance: 0.5,
          category: fact.category,
        });
        embedded++;
      } catch {
        failures++;
      }
    }
    const summary = `embedded=${embedded}/${candidates.length} failures=${failures} semantic=${failures > 0 ? "partial" : "success"}`;
    if (failures > 0) {
      throw new Error(`reembed-vectorless partial failure (${summary})`);
    }
    return summary;
  });

  set("enrich-entities-deep", async () => {
    const r = await b.runEntityEnrichment({ limit: 25, dryRun: false, verbose, adaptiveCatchUp: true });
    const summary = formatEntityEnrichmentSummary(r);
    assertEntityEnrichmentNotPartial(r, summary);
    return summary;
  });

  return runners;
}

export interface PluginCycleRunnerDeps {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  edictStore: { pruneExpired: () => number };
  auditStore?: { prune: (days: number) => number } | null;
  agentHealthStore?: { prune: (days: number) => number } | null;
  proposalsDb?: { pruneExpired: () => number } | null;
  credentialsDb?: { prune?: () => number } | null;
  openai: import("openai").default;
  embeddings: import("../../services/embeddings.js").EmbeddingProvider;
  eventBus?: EventBus | null;
  resolvedSqlitePath: string;
  logger: { info: (s: string) => void; warn: (s: string) => void };
  runCompaction?: () => Promise<{ hot: number; warm: number; cold: number }>;
  runBuildLanguages?: () => Promise<string>;
  runPassiveObserverOnce?: () => Promise<string>;
  runAnalyzeLogs?: () => Promise<string>;
  runLifecycleSync?: () => Promise<string>;
  runActiveTasksMaintain?: () => Promise<string>;
  runCredentialsPrune?: () => Promise<{ removed?: number }>;
}

export function buildPluginCycleRunners(deps: PluginCycleRunnerDeps): Map<string, MaintenanceStepRunner> {
  const runners = new Map<string, MaintenanceStepRunner>();
  const discoveredPath = join(dirname(deps.resolvedSqlitePath), ".discovered-categories.json");

  runners.set("prune", async () => {
    const decayNowSec = Math.floor(Date.now() / 1000);
    const expiredIds = deps.factsDb.listExpiredFactIdsPendingPrune();
    const decayDeleteIds = deps.factsDb.listFactIdsToBeDeletedByDecayRun(decayNowSec);
    const hardPruned = deps.factsDb.pruneExpired();
    const softPruned = deps.factsDb.decayConfidence(decayNowSec);
    const expiredCleanup = await deleteVectorsForFactIds(deps.vectorDb, expiredIds, {
      operation: "orchestrator-cycle-prune",
    });
    const decayCleanup = await deleteVectorsForFactIds(deps.vectorDb, decayDeleteIds, {
      operation: "orchestrator-cycle-decay",
    });
    const edicts = deps.edictStore.pruneExpired();
    let audit = 0;
    let health = 0;
    try {
      audit = deps.auditStore?.prune(90) ?? 0;
    } catch {
      /* non-fatal */
    }
    try {
      health = deps.agentHealthStore?.prune(30) ?? 0;
    } catch {
      /* non-fatal */
    }
    const vectorFailures = expiredCleanup.failed + decayCleanup.failed;
    const summary = `expired=${hardPruned} decayed=${softPruned} edicts=${edicts} audit=${audit} health=${health} vector_failures=${vectorFailures} semantic=${vectorFailures > 0 ? "partial" : "success"}`;
    assertVectorCleanupNotPartial("prune", [expiredCleanup, decayCleanup], summary);
    return summary;
  });

  if (deps.runCompaction) {
    runners.set("compact", async () => {
      const c = await deps.runCompaction!();
      return `hot=${c.hot} warm=${c.warm} cold=${c.cold} semantic=success`;
    });
  }

  if (deps.cfg.autoClassify?.enabled) {
    runners.set("auto-classify", async () => {
      const r = await runAutoClassify(deps.factsDb, deps.openai, deps.cfg.autoClassify, deps.logger, {
        discoveredCategoriesPath: discoveredPath,
        model: deps.cfg.autoClassify?.model,
      });
      const batchFailures = r.batchFailures ?? 0;
      const summary = `reclassified=${r.reclassified} batchFailures=${batchFailures} semantic=${batchFailures > 0 ? "partial" : "success"}`;
      if (batchFailures > 0) {
        throw new Error(`auto-classify partial batch failures (${summary})`);
      }
      return summary;
    });
  }

  if (deps.cfg.sensorSweep?.enabled && deps.eventBus) {
    runners.set("sensor-sweep", async () => {
      const r = await sweepAll(deps.eventBus, deps.cfg.sensorSweep, deps.factsDb, {
        tier: "all",
        resolvedSqlitePath: deps.resolvedSqlitePath,
      });
      if (r.errors.length > 0) {
        throw new Error(`sensor-sweep errors=${r.errors.length}: ${r.errors.slice(0, 3).join("; ")}`);
      }
      return `written=${r.totalWritten} skipped=${r.totalSkipped} errors=0`;
    });
  }

  runners.set("record-storage-sample", async () => {
    const r = recordStorageGrowthSample(deps.factsDb, null, {});
    const summary = `status=${r.status} reason=${r.reason ?? "none"} semantic=${r.reason === "storage_unavailable" ? "partial" : "success"}`;
    return assertRecordStorageSampleSummaryDoesNotBlock(summary);
  });

  if (deps.runAnalyzeLogs) {
    runners.set("analyze-maintenance-logs", async () =>
      assertAnalyzeMaintenanceLogsSummaryDoesNotBlock(await deps.runAnalyzeLogs!()),
    );
  }
  if (deps.runLifecycleSync) {
    runners.set("lifecycle-sync", async () =>
      assertLifecycleSyncSummaryDoesNotBlock(await deps.runLifecycleSync!()),
    );
  }
  if (deps.runPassiveObserverOnce) {
    runners.set("passive-observer", async () =>
      assertPassiveObserverSummaryDoesNotBlock(await deps.runPassiveObserverOnce!()),
    );
  }

  if (deps.proposalsDb) {
    runners.set("proposals-prune", async () => {
      const n = deps.proposalsDb!.pruneExpired();
      return `pruned=${n} semantic=success`;
    });
  }

  if (deps.cfg.languageKeywords?.autoBuild && deps.runBuildLanguages) {
    runners.set("build-languages", deps.runBuildLanguages);
  }

  if (deps.runCredentialsPrune) {
    runners.set("credentials-prune", async () => {
      const r = await Promise.resolve(deps.runCredentialsPrune!());
      return `removed=${r.removed ?? 0} semantic=success`;
    });
  }

  if (deps.runActiveTasksMaintain) {
    runners.set("active-tasks-maintain", async () =>
      assertActiveTasksMaintainSummaryDoesNotBlock(await deps.runActiveTasksMaintain!()),
    );
  }

  return runners;
}

export { runPassiveObserver };
