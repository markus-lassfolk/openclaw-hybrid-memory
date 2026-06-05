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
  jobRunOutcomeFailsOrchestratorStep,
  type JobRunSemanticOutcome,
} from "../../../services/maintenance-job-run/index.js";

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
    return `written=${r.totalWritten} skipped=${r.totalSkipped} errors=${r.errors.length}`;
  } finally {
    if (ownsBus) eventBus.close?.();
  }
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
    return `pruned=${n} vectors=${cleanup.deleted}/${cleanup.attempted}`;
  });

  set("compact", async () => {
    const c = await b.runCompaction({ apply: true });
    return `hot=${c.hot} warm=${c.warm} cold=${c.cold}`;
  });

  set("auto-classify", async () => {
    const r = await b.runClassify({ dryRun: false, limit: b.cfg.autoClassify.batchSize ?? 20 });
    return `reclassified=${r.reclassified}/${r.total}`;
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
    return `status=${r.status}`;
  });

  set("analyze-maintenance-logs", async () => {
    await runAnalyzeMaintenanceLogs({ since: "24h", format: "md", out: "-" }, b);
    return "analyzed last 24h";
  });

  set("lifecycle-sync", async () => {
    const github = b.cfg.lifecycle?.adapters?.github;
    if (!github?.enabled) return "skipped (lifecycle github disabled)";
    const report = await syncLifecycleFromGitHub(b.factsDb, {
      config: github,
      apply: true,
    });
    return `matched=${report.matched} expiredNow=${report.expiredNow}`;
  });

  set("passive-observer", async () => {
    if (!b.cfg.passiveObserver?.enabled) return "skipped (passiveObserver disabled)";
    if (!b.runPassiveObserverOnce) throw new Error("passive-observer unavailable");
    return b.runPassiveObserverOnce();
  });

  set("proposals-prune", async () => {
    if (b.cfg.personaProposals?.enabled === false) return "skipped (personaProposals disabled)";
    if (!b.proposalsDb) return "skipped (proposals store unavailable)";
    const n = b.proposalsDb.pruneExpired();
    return `pruned=${n}`;
  });

  set("build-languages", async () => {
    const r = await b.runBuildLanguageKeywords({ dryRun: false });
    if (!r.ok) throw new Error(r.error);
    return `languagesAdded=${r.languagesAdded}`;
  });

  set("credentials-prune", async () => {
    if (!b.cfg.credentials?.enabled) return "skipped (credentials disabled)";
    const r = b.runCredentialsPrune({ dryRun: false, yes: true });
    return `removed=${r.removed ?? 0}`;
  });

  set("sensor-sweep", async () => runSensorSweepForCli(b));

  set("active-tasks-maintain", async () => {
    if (!b.cfg.activeTask?.enabled) return "skipped (activeTask disabled)";
    if (!b.runActiveTasksMaintain) return "skipped (active-tasks maintain unavailable)";
    return b.runActiveTasksMaintain();
  });

  // --- Nightly staggered ---
  set("extract-daily", async () => {
    if (!b.runExtractDaily) throw new Error("extract-daily unavailable");
    const r = await b.runExtractDaily({ days: 7, dryRun: false, verbose }, sink);
    return `stored=${r.stored ?? r.totalStored ?? 0}`;
  });

  set("distill", async () => {
    if (!b.runDistill) throw new Error("distill unavailable");
    const r = await b.runDistill({ dryRun: false, verbose, days: maxCatchUpDays, ...scanFlags }, sink);
    const summary = `stored=${r.stored} sessions=${r.sessionsScanned} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    const semantic = r.semanticOutcome;
    if (semantic && jobRunOutcomeFailsOrchestratorStep(semantic as JobRunSemanticOutcome)) {
      throw new Error(`distill semantic failure: ${semantic} (${summary})`);
    }
    if (semantic === "partial" || r.partialFailure) {
      throw new Error(`distill partial failure (${summary})`);
    }
    return summary;
  });

  set("resolve-contradictions", async () => {
    const r = await b.runResolveContradictions();
    return `autoResolved=${r.autoResolved.length} ambiguous=${r.ambiguous.length}`;
  });

  set("enrich-entities", async () => {
    const r = await b.runEntityEnrichment({
      limit: 200,
      dryRun: false,
      adaptiveCatchUp: true,
      verbose,
    });
    return `processed=${r.processed} enriched=${r.factsEnriched}`;
  });

  set("extract-implicit", async () => {
    if (b.runExtractImplicitFeedback) {
      const res = await b.runExtractImplicitFeedback({
        dryRun: false,
        includeClosedLoop: false,
        verbose,
        ...scanFlags,
      });
      return `${res.signalsExtracted} signals (${res.positiveCount}+/${res.negativeCount}-) from ${res.sessionsProcessed}/${res.sessionsScanned} sessions`;
    }
    return runExtractImplicitStep(followUpDeps, verbose);
  });

  set("entity-mentions-cleanup", async () => {
    const summary = b.factsDb.cleanupEntityMentions({ limit: 200, apply: true });
    return `changedFacts=${summary.changedFacts} rowsScanned=${summary.rowsScanned}`;
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
    const semantic = (r.semanticOutcome ?? r.status) as JobRunSemanticOutcome | string | undefined;
    if (semantic && jobRunOutcomeFailsOrchestratorStep(semantic as JobRunSemanticOutcome)) {
      throw new Error(`self-correction-run semantic failure: ${semantic} (${summary})`);
    }
    if (semantic === "partial" || semantic === "failed_partial") {
      throw new Error(`self-correction-run partial failure (${summary})`);
    }
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
    return `patternsStored=${r.patternsStored} facts=${r.factsAnalyzed}`;
  });

  set("reflect-rules", async () => {
    const r = await b.runReflectionRules({ dryRun: false, model: b.reflectionConfig.model, verbose });
    return `rulesStored=${r.rulesStored}`;
  });

  set("reflect-meta", async () => {
    const r = await b.runReflectionMeta({ dryRun: false, model: b.reflectionConfig.model, verbose });
    return `metaStored=${r.metaStored}`;
  });

  set("reflect-identity", async () => {
    if (!b.runReflectIdentity) return "skipped (identity reflection unavailable)";
    const r = await b.runReflectIdentity({
      dryRun: false,
      window: b.reflectionConfig.defaultWindow,
      verbose,
    });
    return `insightsStored=${r.insightsStored}`;
  });

  set("extract-procedures", async () => {
    if (!b.runExtractProcedures) throw new Error("extract-procedures unavailable");
    const r = (await b.runExtractProcedures({ dryRun: false, verbose, ...scanFlags })) as { sessionsScanned?: number };
    return `sessions=${r.sessionsScanned ?? 0}`;
  });

  set("extract-directives", async () => {
    if (!b.runExtractDirectives) throw new Error("extract-directives unavailable");
    const r = await b.runExtractDirectives({ dryRun: false, verbose, ...scanFlags });
    return `sessions=${r.sessionsScanned}`;
  });

  set("extract-reinforcement", async () => {
    if (!b.runExtractReinforcement) throw new Error("extract-reinforcement unavailable");
    const r = await b.runExtractReinforcement({ dryRun: false, verbose, ...scanFlags });
    const summary = `sessions=${r.sessionsScanned} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    const semantic = (r.semanticOutcome ?? undefined) as JobRunSemanticOutcome | string | undefined;
    if (semantic && jobRunOutcomeFailsOrchestratorStep(semantic as JobRunSemanticOutcome)) {
      throw new Error(`extract-reinforcement semantic failure: ${semantic} (${summary})`);
    }
    if (semantic === "partial" || semantic === "failed_partial") {
      throw new Error(`extract-reinforcement partial failure (${summary})`);
    }
    return summary;
  });

  set("generate-auto-skills", async () => {
    if (!b.runGenerateAutoSkills) throw new Error("generate-auto-skills unavailable");
    const r = await b.runGenerateAutoSkills({ dryRun: false, verbose });
    return `generated=${r.generated}`;
  });

  set("repair-vectors", async () => {
    const candidates = b.factsDb.listVectorlessActiveFacts({ limit: 200 });
    let reembedded = 0;
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
        /* continue */
      }
    }
    const reconcile = await reconcileOrphanVectors(b.factsDb, b.vectorDb, { operation: "orchestrator-repair-vectors" });
    return `reembedded=${reembedded} orphans=${reconcile.orphansFound}`;
  });

  set("vectordb-optimize", async () => {
    const r = await b.vectorDb.optimize(7 * 24 * 60 * 60 * 1000);
    return `compacted=${r.compacted} freedBytes=${r.freedBytes ?? 0}`;
  });

  set("scope-promote", async () => {
    const candidates = b.factsDb.findSessionFactsForPromotion(7, 0.7);
    let promoted = 0;
    for (const f of candidates) {
      if (b.factsDb.promoteScope(f.id, "global", null)) promoted++;
    }
    return `promoted=${promoted}/${candidates.length}`;
  });

  set("decay-reclassify", async () => {
    const nightly = b.cfg.nightlyCycle;
    const report = b.factsDb.reclassifyDecayClasses({
      apply: true,
      inactiveDays: nightly?.reclassifyInactiveDays,
      promoteRecallCount: nightly?.reclassifyPromoteRecallCount,
    });
    return `reclassified=${report.changed} scanned=${report.scanned}`;
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
      if (res.interrupted || res.resumeAfterRowid === null) break;
      afterRowid = res.resumeAfterRowid;
    }
    return `scanned=${scanned} collapsed=${collapsed}`;
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
      throw new Error(exitInfo.strictFailureReason ?? `${exitInfo.errorCount} error(s), ${exitInfo.warningCount} warning(s)`);
    }
    return `warnings=${report.warningCount} errors=${report.errorCount}`;
  });

  set("crystallization-rescan", async () => {
    const store = (b as { crystallizationStore?: import("../../../backends/crystallization-store.js").CrystallizationStore | null })
      .crystallizationStore;
    if (!store) return "skipped (crystallization store unavailable)";
    const proposer = new CrystallizationProposer(null, store, b.cfg.crystallization);
    const result = proposer.rescanInstalledSkills();
    if (result.errors.length > 0) throw new Error(result.errors.join("; "));
    return `scanned=${result.scanned} quarantined=${result.quarantined}`;
  });

  set("generate-proposals", async () => {
    if (!b.runGenerateProposals) throw new Error("generate-proposals unavailable");
    const r = await b.runGenerateProposals({ dryRun: false, verbose });
    const summary = `created=${r.created} jobRunId=${r.jobRunId ?? "-"} semantic=${r.semanticOutcome ?? "unknown"}`;
    const semantic = r.semanticOutcome as JobRunSemanticOutcome | string | undefined;
    if (semantic && jobRunOutcomeFailsOrchestratorStep(semantic as JobRunSemanticOutcome)) {
      throw new Error(`generate-proposals semantic failure: ${semantic} (${summary})`);
    }
    return summary;
  });

  set("pending-digest", async () => {
    const report = buildPendingReviewDigestReport({ cfg: b.cfg, factsDb: b.factsDb, since: "7d" });
    return `sections=${report.sections.length} totalPending=${report.totalPendingItems}`;
  });

  set("digest-autopilot", async () => {
    const result = await runPendingDigestAutopilotCron({ cfg: b.cfg, factsDb: b.factsDb });
    if (result.summary.status === "failed" || result.summary.status === "partial") {
      throw new Error(result.summary.status);
    }
    return `status=${result.summary.status}`;
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
    return `merged=${r.merged} clusters=${r.clustersFound}`;
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
        /* continue */
      }
    }
    return `embedded=${embedded}/${candidates.length}`;
  });

  set("enrich-entities-deep", async () => {
    const r = await b.runEntityEnrichment({ limit: 25, dryRun: false, verbose, adaptiveCatchUp: true });
    return `processed=${r.processed} enriched=${r.factsEnriched}`;
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
    await deleteVectorsForFactIds(deps.vectorDb, expiredIds, { operation: "orchestrator-cycle-prune" });
    await deleteVectorsForFactIds(deps.vectorDb, decayDeleteIds, { operation: "orchestrator-cycle-decay" });
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
    return `expired=${hardPruned} decayed=${softPruned} edicts=${edicts} audit=${audit} health=${health}`;
  });

  if (deps.runCompaction) {
    runners.set("compact", async () => {
      const c = await deps.runCompaction!();
      return `hot=${c.hot} warm=${c.warm} cold=${c.cold}`;
    });
  }

  if (deps.cfg.autoClassify?.enabled) {
    runners.set("auto-classify", async () => {
      await runAutoClassify(deps.factsDb, deps.openai, deps.cfg.autoClassify, deps.logger, {
        discoveredCategoriesPath: discoveredPath,
        model: deps.cfg.autoClassify?.model,
      });
      return "auto-classify complete";
    });
  }

  if (deps.cfg.sensorSweep?.enabled && deps.eventBus) {
    runners.set("sensor-sweep", async () => {
      const r = await sweepAll(deps.eventBus, deps.cfg.sensorSweep, deps.factsDb, {
        tier: "all",
        resolvedSqlitePath: deps.resolvedSqlitePath,
      });
      return `written=${r.totalWritten} skipped=${r.totalSkipped} errors=${r.errors.length}`;
    });
  }

  runners.set("record-storage-sample", async () => {
    const r = recordStorageGrowthSample(deps.factsDb, null, {});
    return `status=${r.status}`;
  });

  if (deps.runAnalyzeLogs) runners.set("analyze-maintenance-logs", deps.runAnalyzeLogs);
  if (deps.runLifecycleSync) runners.set("lifecycle-sync", deps.runLifecycleSync);
  if (deps.runPassiveObserverOnce) runners.set("passive-observer", deps.runPassiveObserverOnce);

  if (deps.proposalsDb) {
    runners.set("proposals-prune", async () => {
      const n = deps.proposalsDb!.pruneExpired();
      return `pruned=${n}`;
    });
  }

  if (deps.cfg.languageKeywords?.autoBuild && deps.runBuildLanguages) {
    runners.set("build-languages", deps.runBuildLanguages);
  }

  if (deps.runCredentialsPrune) {
    runners.set("credentials-prune", async () => {
      const r = await Promise.resolve(deps.runCredentialsPrune!());
      return `removed=${r.removed ?? 0}`;
    });
  }

  if (deps.runActiveTasksMaintain) {
    runners.set("active-tasks-maintain", deps.runActiveTasksMaintain);
  }

  return runners;
}

export { runPassiveObserver };
