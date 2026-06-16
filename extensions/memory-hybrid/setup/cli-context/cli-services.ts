import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HandlerContext } from "../../cli/handlers.js";
import type { HybridMemCliContext } from "../../cli/register.js";
import type { FindDuplicatesResult } from "../../cli/types.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getMemoryCategories,
  resolveReflectionModelAndFallbacks,
  resolveReflectionThinkingMode,
} from "../../config.js";
import { runClassifyForCli } from "../../services/auto-classifier.js";
import { runConsolidate } from "../../services/consolidation.js";
import { type VerificationCycleResult, runVerificationCycle } from "../../services/continuous-verifier.js";
import { type DreamCycleResult, makeDreamCycleRunId, runDreamCycle } from "../../services/dream-cycle.js";
import { runEntityEnrichmentForCli } from "../../services/entity-enrichment-cli.js";
import { runExport } from "../../services/export-memory.js";
import { runFindDuplicates } from "../../services/find-duplicates.js";
import { runBuildLanguageKeywords } from "../../services/language-keywords-build.js";
import { runPassiveObserver } from "../../services/passive-observer.js";
import { mergeResults } from "../../services/merge-results.js";
import { runPreConsolidationFlush, requireWalFlushBeforeMutation } from "../../services/pre-consolidation-flush.js";
import { adjudicateContradictionWithLlm } from "../../services/contradiction-adjudicator.js";
import { runIdentityReflection } from "../../services/identity-reflection.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../../services/reflection.js";
import { parseSourceDate } from "../../utils/dates.js";
import { getEnv } from "../../utils/env-manager.js";
import { resolveTierPreferenceWithSources } from "../../utils/llm-selection.js";
import { pluginLogger } from "../../utils/logger.js";
import { versionInfo } from "../../versionInfo.js";

/** Services that are not in cli/handlers (reflection, consolidate, export, etc.) */
interface CliContextServices {
  runFindDuplicates: (opts: {
    threshold: number;
    includeStructured: boolean;
    limit: number;
  }) => Promise<FindDuplicatesResult>;
  runConsolidate: (opts: {
    threshold: number;
    includeStructured: boolean;
    dryRun: boolean;
    limit: number;
    model: string;
  }) => Promise<{ clustersFound: number; merged: number; deleted: number }>;
  runReflection: (opts: { window: number; dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
  }>;
  runReflectionRules: (opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
    thinkingMode?: import("../../services/chat.js").MiniMaxThinkingMode;
  }) => Promise<{
    rulesExtracted: number;
    rulesStored: number;
    diagnostics?: {
      modelResponseChars: number;
      parseSuccess: boolean;
      parsedCandidates: number;
      rejectedDuplicates: number;
      rejectedLowConfidence: number;
      stored: number;
      zeroRulesReason?: string;
      status: "ok" | "partial" | "degraded";
    };
  }>;
  runReflectionMeta: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    metaExtracted: number;
    metaStored: number;
    diagnostics?: import("../../services/reflection.js").ReflectionMetaDiagnostics;
  }>;
  runReflectIdentity: (opts: {
    dryRun: boolean;
    model?: string;
    verbose?: boolean;
    window?: number;
  }) => Promise<{ insightsExtracted: number; insightsStored: number; questionsAsked: number }>;
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
    batchFailures?: number;
  }>;
  runCompaction: (opts?: { apply?: boolean }) => Promise<{
    hot: number;
    warm: number;
    cold: number;
    structural: number;
    changed?: number;
    examined?: number;
    apply?: boolean;
  }>;
  runBuildLanguageKeywords: (opts: {
    model?: string;
    dryRun?: boolean;
  }) => Promise<
    { ok: true; path: string; topLanguages: string[]; languagesAdded: number } | { ok: false; error: string }
  >;
  runEntityEnrichment: (opts: {
    limit: number;
    dryRun: boolean;
    model?: string;
    all?: boolean;
    verbose?: boolean;
    onProgress?: (progress: import("../../services/entity-enrichment-cli.js").EntityEnrichmentProgress) => void;
  }) => Promise<{
    pending: number;
    pendingTotal?: number;
    pendingByTier?: { hot: number; warm: number; structural: number; cold: number; unknown: number };
    processed: number;
    factsEnriched: number;
    mode?: "bounded" | "all";
    effectiveLimit?: number | "all";
    remainingTotal?: number;
    estimatedRunsRemaining?: number;
    mentions: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    rejectReasons: Record<string, number>;
    skipped?: boolean;
    pendingFactIds?: string[];
    enrichedFacts?: import("../../services/entity-enrichment-cli.js").EntityEnrichmentVerboseFact[];
  }>;
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{ factsExported: number; proceduresExported: number; filesWritten: number; outputPath: string }>;
  runDreamCycle: (opts?: { verbose?: boolean }) => Promise<DreamCycleResult>;
  runContinuousVerification: (opts?: { verbose?: boolean }) => Promise<VerificationCycleResult>;
  requireWalFlushBeforeMutation: (phase: string) => Promise<{ committed: number; skipped: number }>;
  runResolveContradictions: () => Promise<{
    autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  }>;
  runResolveContradictionsDryRun: () => Promise<{
    autoResolvable: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  }>;
  runResolveContradictionsProjectStateLww: (opts: {
    dryRun?: boolean;
  }) => Promise<import("../../backends/facts-db/contradictions.js").ProjectStateLwwResult>;
  runResolveContradictionsAuto: (
    opts: import("../../backends/facts-db/contradictions.js").ResolveContradictionsAutoOptions,
  ) => Promise<import("../../backends/facts-db/contradictions.js").ResolveContradictionsAutoResult>;
  runApplyContradictionReviewDecisions: (
    decisions: import("../../backends/facts-db/contradictions.js").ContradictionReviewDecision[],
  ) => Promise<import("../../backends/facts-db/contradictions.js").ApplyContradictionReviewResult>;
  runPassiveObserverOnce?: () => Promise<string>;
  getMemoryCategories: () => string[];
  mergeResults: HybridMemCliContext["mergeResults"];
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
}

/** Context passed from plugin register() to wire CLI without pulling all service imports into index. */
export interface HybridMemCliRegistrationContext {
  factsDb: HandlerContext["factsDb"];
  vectorDb: HandlerContext["vectorDb"];
  embeddings: HandlerContext["embeddings"];
  openai: HandlerContext["openai"];
  cfg: HandlerContext["cfg"];
  credentialsDb: HandlerContext["credentialsDb"];
  aliasDb: HandlerContext["aliasDb"];
  wal: HandlerContext["wal"];
  proposalsDb: HandlerContext["proposalsDb"];
  identityReflectionStore: HandlerContext["identityReflectionStore"];
  personaStateStore: HandlerContext["personaStateStore"];
  crystallizationStore?: HandlerContext["crystallizationStore"];
  toolProposalStore?: HandlerContext["toolProposalStore"];
  verificationStore?: import("../../services/verification-store.js").VerificationStore | null;
  provenanceService?: import("../../services/provenance.js").ProvenanceService | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
  detectCategory: HandlerContext["detectCategory"];
  /** Optional event log for episodic consolidation in dream cycle. */
  eventLog?: import("../../backends/event-log.js").EventLog | null;
  /** LLM cost tracker (Issue #270). */
  costTracker?: import("../../backends/cost-tracker.js").CostTracker | null;
  /** Event Bus for sensor sweep (Issue #236). Required when sensorSweep.enabled. */
  eventBus?: import("../../backends/event-bus.js").EventBus | null;
  /** Audit log (Issue #790). */
  auditStore?: import("../../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../../backends/agent-health-store.js").AgentHealthStore | null;
  changeFeed?: import("../../services/change-feed.js").ChangeFeed | null;
}

export function buildCliContextServices(
  ctx: HybridMemCliRegistrationContext,
  api: ClawdbotPluginApi,
): CliContextServices {
  const {
    factsDb,
    vectorDb,
    embeddings,
    openai,
    cfg,
    resolvedSqlitePath,
    aliasDb,
    verificationStore,
    provenanceService,
    proposalsDb,
    wal,
  } = ctx;
  const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
  const adaptiveMaintenanceStatePath = join(dirname(resolvedSqlitePath), ".adaptive-llm-limits.json");
  const logSink = { info: (m: string) => pluginLogger.info(m), warn: (m: string) => pluginLogger.warn(m) };
  const walFlushDeps = { wal, factsDb, vectorDb, embeddings };
  const guardWal = (phase: string) => requireWalFlushBeforeMutation(walFlushDeps, api.logger, phase);
  const guardWalUnlessDryRun = async (phase: string, dryRun?: boolean) => {
    if (!dryRun) await guardWal(phase);
  };
  return {
    runFindDuplicates: (opts) => runFindDuplicates(factsDb, vectorDb, embeddings, opts, api.logger),
    runConsolidate: async (opts) => {
      if (cfg.embedding?.provider === "openai" && !cfg.embedding?.apiKey) {
        api.logger.warn?.(
          "memory-hybrid: consolidate skipped — embedding.provider is openai but embedding.apiKey is missing",
        );
        return {
          clustersFound: 0,
          merged: 0,
          deleted: 0,
          skipped: true,
          skipReason: "missing_embedding_api_key",
          semanticOutcome: "failed",
        };
      }
      await guardWalUnlessDryRun("cli_consolidation", opts.dryRun);
      return runConsolidate(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { ...opts, thinkingMode: resolveReflectionThinkingMode(cfg) },
        api.logger,
        aliasDb,
        provenanceService,
      );
    },
    runReflection: async (opts) => {
      await guardWalUnlessDryRun("cli_reflection", opts.dryRun);
      const requestedModel = opts.model ?? cfg.reflection.model;
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "maintenance", requestedModel);
      const effectiveModel = requestedModel ?? defaultModel;
      const modelSource = opts.model
        ? "--model"
        : cfg.reflection.model?.trim()
          ? "reflection.model"
          : "llm.maintenance[0]";
      const result = await runReflection(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        {
          defaultWindow: cfg.reflection.defaultWindow,
          minObservations: cfg.reflection.minObservations,
          enabled: cfg.reflection.enabled,
        },
        {
          ...opts,
          model: effectiveModel,
          modelSource,
          fallbackModels,
          adaptiveStatePath: adaptiveMaintenanceStatePath,
          thinkingMode: resolveReflectionThinkingMode(cfg),
        },
        logSink,
        provenanceService,
      );
      // Record savings: each pattern stored encodes knowledge that saves future manual analysis
      if (result.patternsStored > 0 && !opts.dryRun && ctx.costTracker) {
        ctx.costTracker.recordSavings({
          feature: "reflection",
          action: "pattern extracted and stored",
          countAvoided: result.patternsStored,
          estimatedSavingUsd: result.patternsStored * 0.0005,
          note: `${result.factsAnalyzed} facts analyzed → ${result.patternsStored} patterns stored`,
        });
      }
      return result;
    },
    runReflectionRules: async (opts) => {
      await guardWalUnlessDryRun("cli_reflect_rules", opts.dryRun);
      const explicitModel = opts.model?.trim() || undefined;
      const configuredModel = cfg.reflection.model?.trim() || undefined;
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(
        cfg,
        "maintenance",
        explicitModel ?? configuredModel,
      );
      const effectiveModel = explicitModel ?? configuredModel ?? defaultModel;
      const modelSource = explicitModel ? "--model" : configuredModel ? "reflection.model" : "llm.maintenance[0]";
      return runReflectionRules(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        {
          ...opts,
          model: effectiveModel,
          modelSource,
          fallbackModels,
          adaptiveStatePath: adaptiveMaintenanceStatePath,
          thinkingMode: opts.thinkingMode ?? "disabled",
        },
        logSink,
        provenanceService,
      );
    },
    runReflectionMeta: async (opts) => {
      await guardWalUnlessDryRun("cli_reflect_meta", opts.dryRun);
      const requestedModel = opts.model ?? cfg.reflection.model;
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "maintenance", requestedModel);
      const effectiveModel = requestedModel ?? defaultModel;
      const modelSource = opts.model
        ? "--model"
        : cfg.reflection.model?.trim()
          ? "reflection.model"
          : "llm.maintenance[0]";
      return runReflectionMeta(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        {
          ...opts,
          model: effectiveModel,
          modelSource,
          fallbackModels,
          adaptiveStatePath: adaptiveMaintenanceStatePath,
          thinkingMode: resolveReflectionThinkingMode(cfg),
        },
        logSink,
        provenanceService,
      );
    },
    runReflectIdentity: async (opts) => {
      if (!ctx.identityReflectionStore) {
        return { insightsExtracted: 0, insightsStored: 0, questionsAsked: 0 };
      }
      await guardWalUnlessDryRun("cli_reflect_identity", opts.dryRun);
      const requestedModel = opts.model ?? cfg.identityReflection.model;
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "maintenance", requestedModel);
      const effectiveModel = requestedModel ?? defaultModel;
      return runIdentityReflection(
        factsDb,
        ctx.identityReflectionStore,
        openai,
        cfg.identityReflection,
        {
          dryRun: opts.dryRun,
          model: effectiveModel,
          fallbackModels,
          verbose: opts.verbose,
          window: opts.window,
        },
        logSink,
      );
    },
    runClassify: async (opts) => {
      await guardWalUnlessDryRun("cli_classify", opts.dryRun);
      const result = await runClassifyForCli(
        factsDb,
        openai,
        cfg.autoClassify,
        {
          ...opts,
          model: opts.model ?? cfg.autoClassify.model ?? resolveReflectionModelAndFallbacks(cfg, "nano").defaultModel,
        },
        discoveredPath,
        logSink,
        undefined,
      );
      // Record savings: batching avoids N individual LLM calls
      if (result.reclassified > 0 && !opts.dryRun && ctx.costTracker) {
        const batchSize = cfg.autoClassify.batchSize ?? 20;
        const batchesUsed = Math.ceil(result.reclassified / batchSize);
        const callsAvoided = Math.max(0, result.reclassified - batchesUsed);
        if (callsAvoided > 0) {
          ctx.costTracker.recordSavings({
            feature: "auto-classify",
            action: "batch-classified facts",
            countAvoided: callsAvoided,
            estimatedSavingUsd: callsAvoided * 0.0001,
            note: `${result.reclassified} facts in ${batchesUsed} batch(es) vs ${result.reclassified} individual calls`,
          });
        }
      }
      return result;
    },
    runCompaction: async (opts?: { apply?: boolean }) => {
      if (opts?.apply !== false) {
        await guardWal("cli_compaction_retier");
      }
      return factsDb.retier(
        {
          inactivePreferenceDays: cfg.memoryTiering.inactivePreferenceDays,
          hotMaxTokens: cfg.memoryTiering.hotMaxTokens,
          hotMaxFacts: cfg.memoryTiering.hotMaxFacts,
          coldAfterInactivityDays: cfg.memoryTiering.coldAfterInactivityDays,
          hotMinAccessCount: cfg.memoryTiering.hotMinAccessCount,
          hotAccessWindowDays: cfg.memoryTiering.hotAccessWindowDays,
          hotPreferenceImportance: cfg.memoryTiering.hotPreferenceImportance,
          hotByRecallWindowDays: cfg.memoryTiering.hotByRecall.windowDays,
          hotByRecallTopN: cfg.memoryTiering.hotByRecall.topN,
          structuralByCategoryEnabled: cfg.memoryTiering.structuralByCategory,
          structuralPermanentEnabled: cfg.memoryTiering.structuralPermanent,
        },
        opts?.apply !== false,
      );
    },
    runBuildLanguageKeywords: async (opts) => {
      await guardWalUnlessDryRun("cli_build_language_keywords", opts.dryRun);
      return runBuildLanguageKeywords(factsDb.getFactsForConsolidation(300), openai, dirname(resolvedSqlitePath), {
        model:
          opts.model ?? cfg.autoClassify.model ?? resolveReflectionModelAndFallbacks(cfg, "maintenance").defaultModel,
        dryRun: opts.dryRun,
      });
    },
    runEntityEnrichment: async (opts) => {
      await guardWalUnlessDryRun("cli_entity_enrichment", opts.dryRun);
      return runEntityEnrichmentForCli(factsDb, openai, cfg, opts);
    },
    runExport: (opts) =>
      Promise.resolve(
        runExport(factsDb, opts, {
          pluginVersion: versionInfo.pluginVersion,
          schemaVersion: versionInfo.schemaVersion,
        }),
      ),
    runDreamCycle: async (opts?: { verbose?: boolean }) => {
      const verbose = !!opts?.verbose;
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "maintenance");
      const dreamModel = cfg.nightlyCycle.model ?? defaultModel;
      const tierPref = resolveTierPreferenceWithSources(cfg, "default");
      const dreamSource =
        typeof cfg.nightlyCycle.model === "string" && cfg.nightlyCycle.model.trim().length > 0
          ? "nightlyCycle.model"
          : tierPref.models[0] === dreamModel
            ? (tierPref.sources[0] ?? "built-in")
            : "built-in";
      pluginLogger.info("memory-hybrid: dream-cycle model tier = default");
      pluginLogger.info(`memory-hybrid: dream-cycle starting with model ${dreamModel} (source=${dreamSource})`);
      pluginLogger.info(
        `memory-hybrid: dream-cycle fallback chain = [${fallbackModels && fallbackModels.length > 0 ? fallbackModels.join(", ") : ""}]`,
      );
      if (verbose) {
        pluginLogger.info("memory-hybrid: dream-cycle — pre-cycle WAL flush (replay pending writes)…");
      }
      const flush = await runPreConsolidationFlush(
        { wal, factsDb, vectorDb, embeddings },
        api.logger,
        "dream_cycle_consolidation",
      );
      if (verbose) {
        pluginLogger.info(
          `memory-hybrid: dream-cycle — WAL flush done (committed=${flush.committed}, skipped=${flush.skipped}, failed=${flush.failed})`,
        );
      }
      const runId = makeDreamCycleRunId();
      return runDreamCycle(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        ctx.eventLog ?? null,
        {
          enabled: cfg.nightlyCycle.enabled,
          schedule: cfg.nightlyCycle.schedule,
          reflectWindowDays: cfg.nightlyCycle.reflectWindowDays,
          pruneMode: cfg.nightlyCycle.pruneMode,
          model: dreamModel,
          fallbackModels: fallbackModels ?? [],
          consolidateAfterDays: cfg.nightlyCycle.consolidateAfterDays,
          eventLogArchivalDays: cfg.eventLog.archivalDays,
          eventLogArchivePath: cfg.eventLog.archivePath,
          maxUnconsolidatedAgeDays: cfg.nightlyCycle.maxUnconsolidatedAgeDays,
          maxEventsPerConsolidation: cfg.nightlyCycle.maxEventsPerConsolidation,
          logRetentionDays: cfg.nightlyCycle.logRetentionDays,
          vacuumOnCycle: cfg.nightlyCycle.vacuumOnCycle,
          reclassifyDecayOnCycle: cfg.nightlyCycle.reclassifyDecayOnCycle,
          reclassifyInactiveDays: cfg.nightlyCycle.reclassifyInactiveDays,
          reclassifyPromoteRecallCount: cfg.nightlyCycle.reclassifyPromoteRecallCount,
          enableReflectionRules: cfg.nightlyCycle.enableReflectionRules,
          ingestDreamFindings: cfg.nightlyCycle.ingestDreamFindings === true,
          verbose,
          episodicConsolidationEventTypes: {
            allow: cfg.nightlyCycle.consolidationEventTypeAllow,
            deny: cfg.nightlyCycle.consolidationEventTypeDeny,
          },
          runId,
          walFlushFailed: flush.failed,
          stageArtifactDir: (() => {
            const envDir = getEnv("HYBRID_MEM_DREAM_STAGE_DIR");
            if (envDir?.trim()) {
              return join(envDir.trim(), `run-${runId}`);
            }
            const openclawHome = getEnv("OPENCLAW_HOME")?.trim() || join(homedir(), ".openclaw");
            return join(openclawHome, "logs", "dream-cycle", `run-${runId}`);
          })(),
        },
        logSink,
        provenanceService,
        {
          cfg,
          proposalsDb: proposalsDb ?? null,
          crystallizationStore: ctx.crystallizationStore ?? null,
          toolProposalStore: ctx.toolProposalStore ?? null,
          workflowStore: ctx.workflowStore ?? null,
          api,
          changeFeed: ctx.changeFeed ?? null,
          resolvedSqlitePath,
        },
      );
    },
    runContinuousVerification: async (opts?: { verbose?: boolean }) => {
      if (!verificationStore || !cfg.verification.enabled || !cfg.verification.continuousVerification) {
        return { checked: 0, confirmed: 0, stale: 0, uncertain: 0, errors: 0, errorSummaries: [] };
      }
      const verbose = !!opts?.verbose;
      return runVerificationCycle(verificationStore, factsDb, openai, {
        cycleDays: cfg.verification.cycleDays,
        verificationModel: cfg.verification.verificationModel,
        ...(verbose
          ? {
              onProgress: (message: string) => {
                pluginLogger.info(message);
              },
            }
          : {}),
      });
    },
    runResolveContradictions: async () => {
      await guardWal("cli_resolve_contradictions");
      return factsDb.resolveContradictions();
    },
    runResolveContradictionsDryRun: () => Promise.resolve(factsDb.previewResolveContradictions()),
    runResolveContradictionsProjectStateLww: async (opts: { dryRun?: boolean }) => {
      await guardWalUnlessDryRun("cli_resolve_contradictions_project_state_lww", opts.dryRun);
      return factsDb.resolveContradictionsProjectStateLww(opts);
    },
    runResolveContradictionsAuto: async (opts) => {
      await guardWalUnlessDryRun("cli_resolve_contradictions_auto", opts.dryRun);
      const model =
        opts.model ?? cfg.autoClassify.model ?? resolveReflectionModelAndFallbacks(cfg, "maintenance").defaultModel;
      return factsDb.resolveContradictionsAuto({
        ...opts,
        ...(opts.llm
          ? {
              model,
              adjudicate: (item) => adjudicateContradictionWithLlm(openai, model, item),
            }
          : {}),
        actor: "resolve-contradictions",
        toolVersion: versionInfo.pluginVersion,
      });
    },
    runApplyContradictionReviewDecisions: async (decisions) => {
      await guardWal("cli_apply_contradiction_review_decisions");
      return factsDb.applyContradictionReviewDecisions(decisions, {
        actor: "resolve-contradictions-review",
        toolVersion: versionInfo.pluginVersion,
      });
    },
    requireWalFlushBeforeMutation: guardWal,
    runPassiveObserverOnce: async () => {
      if (!cfg.passiveObserver?.enabled) return "skipped (passiveObserver disabled)";
      const { getLLMModelPreference } = await import("../../config.js");
      const observerModel =
        cfg.passiveObserver.model ??
        getLLMModelPreference(getCronModelConfig(cfg), "nano")[0] ??
        getDefaultCronModel(getCronModelConfig(cfg), "nano");
      const observerFallbacks = (() => {
        const pref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
        return pref.length > 1 ? pref.slice(1) : undefined;
      })();
      const result = await runPassiveObserver(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        cfg.passiveObserver,
        cfg.categories,
        {
          model: observerModel,
          fallbackModels: observerFallbacks,
          dbDir: dirname(resolvedSqlitePath),
          proceduresSessionsDir: cfg.procedures.sessionsDir,
          reinforcement: cfg.reinforcement,
          provenanceService: ctx.provenanceService ?? null,
          eventLog: ctx.eventLog ?? null,
          dedupWindowMinutes: cfg.store.dedupWindowMinutes ?? 30,
        },
        pluginLogger,
      );
      const summary = `stored=${result.factsStored} scanned=${result.sessionsScanned} errors=${result.errors} semantic=${result.errors > 0 ? "partial" : "success"}`;
      if (result.errors > 0) {
        throw new Error(`passive-observer errors=${result.errors} (${summary})`);
      }
      return summary;
    },
    getMemoryCategories: () => [...getMemoryCategories()],
    mergeResults,
    parseSourceDate,
    versionInfo,
  };
}
