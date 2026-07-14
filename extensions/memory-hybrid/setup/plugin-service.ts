import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveDreamCycleLogDir } from "../utils/dream-cycle-paths.js";
import { nowIso } from "../utils/dates.js";
import type OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { clearRuntimeTimers, type PluginRuntime } from "../api/plugin-runtime.js";
import { isRegistrationSuperseded } from "../utils/registration-superseded.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import {
  applyHybridMemoryToolsMd,
  ensureHybridMemoryWorkspaceSkillIfMissing,
  loadOpenclawRootForWorkspace,
} from "../cli/cmd-install.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import type { DashboardServer } from "../routes/dashboard-server.js";
import { createDashboardServer } from "../routes/dashboard-server.js";
import { reconcileActiveTaskInProgressSessions } from "../services/active-task.js";
import { syncCronLastRunFromGuards } from "../services/cron-guard.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import {
  capturePluginError,
  describePendingTelemetryDrain,
  flushErrorReporter,
  getLastErrorReportSendFailureKind,
  getPendingErrorReportCount,
  initErrorReporter,
  isErrorReporterActive,
  setErrorReporterMuted,
} from "../services/error-reporter.js";
import { resolveGoalsDir, runGoalHealthCheck } from "../services/goal-stewardship.js";
import { runBuildLanguageKeywords } from "../services/language-keywords-build.js";
import { runCredentialsPruneForCli } from "../cli/cmd-credentials.js";
import { collectMaintenanceSteps, summarizeMaintenanceLogAnalysis } from "../services/maintenance-log-analyzer.js";
import { runMaintenanceTiers } from "../services/maintenance-orchestrator.js";
import { buildPluginCycleRunners } from "../cli/commands/manage/maintenance-step-runners.js";
import { syncLifecycleFromGitHub } from "../services/lifecycle/github-adapter.js";
import { runPassiveObserver } from "../services/passive-observer.js";
import type { ProvenanceService } from "../services/provenance.js";
import {
  reconcileActiveTaskInProgressSessionsFacts,
  reconcileActiveTaskLiveState,
  activeTaskRenderGoalsOpts,
  renderActiveTaskMarkdownFile,
} from "../services/task-ledger-facts.js";
import { runTaskQueueWatchdog } from "../services/task-queue-watchdog.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";
import { deleteVectorsForFactIds } from "../services/vector-maintenance.js";
import type { VerificationStore } from "../services/verification-store.js";
import { registerWorkerLeaseShutdown } from "../services/worker-lease.js";
import { isWorkshopEnabled } from "../services/workshop-config.js";
import { syncWorkshopProposedEvents, withWorkshopDefaults } from "../services/workshop-service.js";
import { parseDuration } from "../utils/duration.js";
import { getEnv } from "../utils/env-manager.js";
import { resolveOpenClawWorkspaceRoot } from "../utils/openclaw-workspace.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";
import { integrationVerbose } from "../utils/integration-trace.js";
import { findPluginRoot } from "../utils/plugin-root.js";
import {
  fetchLatestPublishedVersion,
  isPluginOutdated,
  isVersionCheckCacheFresh,
  maybeLogOutdatedVersionNudge,
  readVersionCheckCache,
  type VersionCheckCacheEntry,
  writeVersionCheckCache,
} from "../utils/plugin-update-check.js";
import { checkOpenClawVersion } from "../utils/version-check.js";
import { stopEventLoopLagMonitor } from "../utils/event-loop-health.js";
import { versionInfo } from "../versionInfo.js";

export interface PluginServiceContext {
  PLUGIN_ID: string;
  /**
   * Registration generation that produced the runtime driving this service. Captured at
   * plugin-service.start() time so the startup DB-touching blocks can suppress closed-DB
   * errors that fire after a re-register supersedes this service instance (rapid hot-reload
   * guard, supplements #1550 / #2058 / #2059).
   */
  bootRegistrationGeneration?: number;
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  embeddings: import("../services/embeddings.js").EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
  credentialsDb: CredentialsDB | null;
  proposalsDb: ProposalsDB | null;
  wal: WriteAheadLog | null;
  eventLog?: import("../backends/event-log.js").EventLog | null;
  cfg: HybridMemoryConfig;
  openai: OpenAI;
  resolvedLancePath: string;
  resolvedSqlitePath: string;
  api: ClawdbotPluginApi;
  pythonBridge?: import("../services/python-bridge.js").PythonBridge | null;
  provenanceService?: ProvenanceService | null;
  costTracker?: import("../backends/cost-tracker.js").CostTracker | null;
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
  // Memory Viewer stores (Issue #1023)
  verificationStore?: VerificationStore | null;
  issueStore?: IssueStore | null;
  workflowStore?: WorkflowStore | null;
  narrativesDb?: NarrativesDB | null;
  crystallizationStore?: import("../backends/crystallization-store.js").CrystallizationStore | null;
  toolProposalStore?: import("../backends/tool-proposal-store.js").ToolProposalStore | null;
  changeFeed?: import("../services/change-feed.js").ChangeFeed | null;
  eventBus?: import("../backends/event-bus.js").EventBus | null;
  // #90: previously threaded into the runtime but never passed to the plugin service, so
  // stop() had no way to close them.
  identityReflectionStore?: import("../backends/identity-reflection-store.js").IdentityReflectionStore | null;
  personaStateStore?: import("../backends/persona-state-store.js").PersonaStateStore | null;
  learningsDb?: import("../backends/learnings-db.js").LearningsDB | null;
  apitapStore?: import("../backends/apitap-store.js").ApitapStore | null;
  aliasDb?: import("../services/retrieval-aliases.js").AliasDB | null;
  vaultRegistry?: import("../services/vault-registry.js").VaultRegistry | null;
  // Mutable timer refs that will be updated by the start handler
  timers: PluginRuntime["timers"];
}

/**
 * Terminally close a store during plugin stop(), preferring permanentClose() (which transitions
 * BaseSqliteStore's internal phase to "shutdown" so `liveDb` throws on any later access) over the
 * non-terminal close() every BaseSqliteStore subclass also exposes. close() alone is designed for
 * background maintenance and deliberately allows the store to auto-reopen a new native handle on
 * next access — exactly what a stale tool/hook closure invoked after "shutdown" would trigger,
 * accumulating duplicate SQLite connections (issue #1550). Falls back to close() for stores that
 * don't implement permanentClose() (e.g. VerificationStore, and VectorDB whose close() is already
 * terminal), matching bootstrap-databases.ts's closeOldDatabases() convention.
 */
function closeStorePermanently(
  store: { permanentClose?: () => void; close?: () => void } | null | undefined,
  subsystem: string,
  logger: { warn: (msg: string) => void },
): void {
  if (!store) return;
  try {
    if (typeof store.permanentClose === "function") {
      store.permanentClose();
    } else if (typeof store.close === "function") {
      store.close();
    }
  } catch (err) {
    logger.warn(`memory-hybrid: failed to close ${subsystem} during shutdown: ${err}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "plugin-service",
      operation: `close-${subsystem}`,
      severity: "warning",
    });
  }
}

/**
 * Creates the plugin service registration object with start/stop handlers.
 * Manages:
 * - Error reporter initialization
 * - WAL recovery on startup
 * - Periodic pruning, classification, language keywords building
 * - Post-upgrade pipeline
 * - Cleanup on shutdown
 */
export function shouldSkipPluginServiceStartForSupersededGeneration(
  bootRegistrationGeneration: number | undefined,
): boolean {
  return bootRegistrationGeneration !== undefined && isRegistrationSuperseded(bootRegistrationGeneration);
}

export function createPluginService(ctx: PluginServiceContext) {
  const {
    PLUGIN_ID,
    bootRegistrationGeneration,
    factsDb,
    edictStore,
    vectorDb,
    embeddings,
    embeddingRegistry,
    credentialsDb,
    proposalsDb,
    wal,
    eventLog,
    cfg,
    openai,
    resolvedLancePath,
    resolvedSqlitePath,
    api,
    timers,
    provenanceService,
    costTracker,
    auditStore,
    agentHealthStore,
    pythonBridge,
    verificationStore,
    issueStore,
    workflowStore,
    narrativesDb,
    crystallizationStore,
    toolProposalStore,
    changeFeed,
    eventBus,
    identityReflectionStore,
    personaStateStore,
    learningsDb,
    apitapStore,
    aliasDb,
    vaultRegistry,
  } = ctx;

  let watchdogRunning = false;
  let watchdogRunPromise: Promise<void> | null = null;
  let maintenanceTickPromise: Promise<void> | null = null;
  let shuttingDown = false;
  let dashboardServer: DashboardServer | null = null;
  let versionCheckPromise: Promise<void> | null = null;

  return {
    id: PLUGIN_ID,
    _getVersionCheckPromise: () => versionCheckPromise,
    start: async () => {
      timers.shuttingDownRef.value = false;
      // Rapid hot-reload guard: if this service instance is already superseded by a newer
      // registration, skip the heavy startup work (which touches donor DBs that the newer
      // re-register is about to close). Without this, `plugin service failed ... The
      // database connection is not open` fires on every rapid config hot reload.
      if (shouldSkipPluginServiceStartForSupersededGeneration(bootRegistrationGeneration)) {
        api.logger.debug?.(
          `memory-hybrid: plugin-service start skipped (registration generation ${bootRegistrationGeneration} superseded)`,
        );
        return;
      }
      // Issue #422: surface missing Python deps early; deferred from register() for lighter CLI (issue #1111).
      if (pythonBridge) {
        const { ok, missing, spawnError } = pythonBridge.checkDependencies();
        if (!ok) {
          if (spawnError) {
            api.logger.warn(
              `memory-hybrid: documents.enabled but Python binary not found or failed to spawn: ${spawnError.message}. ` +
                `Check documents.pythonPath configuration (currently: ${cfg.documents.pythonPath}).`,
            );
          } else {
            const pkgs = missing.join(", ");
            api.logger.warn(
              `memory-hybrid: documents.enabled but required Python package(s) not installed: ${pkgs}. ` +
                `Run: ${cfg.documents.pythonPath} -m pip install ${missing.join(" ")}  (see extensions/memory-hybrid/scripts/requirements.txt)`,
            );
          }
        }
      }

      const sqlCount = factsDb.count();
      const expired = factsDb.countExpired();
      const versionCheckCachePath =
        resolvedSqlitePath === ":memory:" ? null : join(dirname(resolvedSqlitePath), ".latest-plugin-version.json");
      const errorReportQueuePath =
        resolvedSqlitePath === ":memory:"
          ? undefined
          : join(dirname(resolvedSqlitePath), ".error_reports.pending.jsonl");
      const errorReportingActive = cfg.errorReporting.enabled && cfg.errorReporting.consent;
      let cachedVersionCheck = versionCheckCachePath ? readVersionCheckCache(versionCheckCachePath) : null;
      api.logger.info(
        `memory-hybrid: initialized v${versionInfo.pluginVersion} (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
      );

      if (typeof factsDb.getRawDb === "function") {
        registerWorkerLeaseShutdown(
          factsDb,
          `plugin-${process.pid}`,
          api.logger as { info?: (msg: string) => void; warn?: (msg: string) => void },
        );
      }

      checkOpenClawVersion(api.version, api.logger);

      try {
        const pluginRootDir = findPluginRoot(import.meta.url);
        const skillOutcome = ensureHybridMemoryWorkspaceSkillIfMissing({
          pluginRootDir,
          mergedOpenclawConfig: loadOpenclawRootForWorkspace(),
        });
        if (skillOutcome.deployed) {
          api.logger.info(`memory-hybrid: deployed bundled Agent Skill to workspace: ${skillOutcome.path}`);
        } else if (skillOutcome.skippedReason) {
          const benign = new Set(["already_exists", "bundled_missing", "destination_dir_exists"]);
          if (!benign.has(skillOutcome.skippedReason)) {
            const msg = `memory-hybrid: workspace skill bootstrap failed (${skillOutcome.skippedReason}) — ${skillOutcome.path}`;
            api.logger.warn(msg);
            capturePluginError(new Error(msg), {
              subsystem: "plugin-service",
              operation: "ensure-workspace-skill",
            });
          }
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "plugin-service",
          operation: "ensure-workspace-skill",
        });
      }

      try {
        const openclawConfig = loadOpenclawRootForWorkspace();
        const toolsOutcome = applyHybridMemoryToolsMd({
          mergedOpenclawConfig: openclawConfig,
          pluginRootDir: findPluginRoot(import.meta.url),
          dryRun: false,
        });
        if (toolsOutcome.updated) {
          api.logger.info(`memory-hybrid: ensured workspace TOOLS.md at ${toolsOutcome.path}`);
        } else if (toolsOutcome.error) {
          api.logger.warn(`memory-hybrid: workspace TOOLS.md bootstrap failed — ${toolsOutcome.error}`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "plugin-service",
          operation: "ensure-workspace-tools-md",
        });
      }

      if (
        errorReportingActive &&
        cachedVersionCheck &&
        isPluginOutdated(versionInfo.pluginVersion, cachedVersionCheck.latestVersion) &&
        isVersionCheckCacheFresh(cachedVersionCheck, cfg.errorReporting.updateNudge.cacheTtlHours)
      ) {
        setErrorReporterMuted(true, `outdated-plugin:${cachedVersionCheck.latestVersion}`);
        const nextCachedVersionCheck = maybeLogOutdatedVersionNudge(
          versionInfo.pluginVersion,
          cachedVersionCheck,
          cfg.errorReporting.updateNudge,
          api.logger,
        );
        if (versionCheckCachePath && nextCachedVersionCheck.lastNudgedAt !== cachedVersionCheck.lastNudgedAt) {
          try {
            writeVersionCheckCache(versionCheckCachePath, nextCachedVersionCheck);
          } catch (err) {
            api.logger.debug?.(
              `memory-hybrid: failed to update nudge cache: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          cachedVersionCheck = nextCachedVersionCheck;
        }
      } else {
        setErrorReporterMuted(false);
      }

      // ========================================================================
      // Startup Task Sequencing (to avoid race conditions):
      // 1. Error reporter init (async)
      // 2. Prune expired facts (synchronous)
      // 3. WAL recovery (synchronous)
      // 4. Start periodic timers (async background tasks with delays)
      // ========================================================================

      // Initialize error reporter (always present — opt-out via enabled: false or consent: false)
      try {
        await initErrorReporter(
          {
            enabled: cfg.errorReporting.enabled,
            dsn: cfg.errorReporting.dsn,
            mode: cfg.errorReporting.mode ?? "community",
            consent: cfg.errorReporting.consent,
            environment: cfg.errorReporting.environment,
            sampleRate: cfg.errorReporting.sampleRate ?? 1.0,
            maxBreadcrumbs: 10,
            botId: cfg.errorReporting.botId,
            botName: cfg.errorReporting.botName,
            resolvedIssues: cfg.errorReporting.resolvedIssues,
            pendingQueuePath: errorReportQueuePath,
          },
          versionInfo.pluginVersion,
          api.logger,
          api.context?.agentId,
        );
        if (isErrorReporterActive()) {
          api.logger.info("memory-hybrid: error reporting enabled");
        }
      } catch (err) {
        api.logger.warn(`memory-hybrid: error reporter initialization failed: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "plugin-service",
          operation: "init-error-reporter",
        });
      }

      versionCheckPromise = (async () => {
        if (!errorReportingActive) return;
        try {
          const latestPublished = await fetchLatestPublishedVersion();
          if (!latestPublished.latestVersion || !latestPublished.source) {
            if (
              cachedVersionCheck &&
              isPluginOutdated(versionInfo.pluginVersion, cachedVersionCheck.latestVersion) &&
              isVersionCheckCacheFresh(cachedVersionCheck, cfg.errorReporting.updateNudge.cacheTtlHours)
            ) {
              setErrorReporterMuted(true, `outdated-plugin:${cachedVersionCheck.latestVersion}`);
            }
            return;
          }

          let cacheEntry: VersionCheckCacheEntry = {
            latestVersion: latestPublished.latestVersion,
            source: latestPublished.source,
            checkedAt: nowIso(),
            lastNudgedAt: cachedVersionCheck?.lastNudgedAt,
          };

          if (shuttingDown) return;

          if (isPluginOutdated(versionInfo.pluginVersion, latestPublished.latestVersion)) {
            setErrorReporterMuted(true, `outdated-plugin:${latestPublished.latestVersion}`);
            cacheEntry = maybeLogOutdatedVersionNudge(
              versionInfo.pluginVersion,
              cacheEntry,
              cfg.errorReporting.updateNudge,
              api.logger,
            );
          } else {
            setErrorReporterMuted(false);
          }

          if (shuttingDown) return;
          if (versionCheckCachePath) {
            try {
              writeVersionCheckCache(versionCheckCachePath, cacheEntry);
            } catch (err) {
              api.logger.debug?.(
                `memory-hybrid: failed to write version check cache: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } catch (err) {
          api.logger.debug?.(
            `memory-hybrid: latest-version check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (
            cachedVersionCheck &&
            isPluginOutdated(versionInfo.pluginVersion, cachedVersionCheck.latestVersion) &&
            isVersionCheckCacheFresh(cachedVersionCheck, cfg.errorReporting.updateNudge.cacheTtlHours)
          ) {
            setErrorReporterMuted(true, `outdated-plugin:${cachedVersionCheck.latestVersion}`);
          }
        }
      })();

      if (expired > 0) {
        const expiredIds = factsDb.listExpiredFactIdsPendingPrune();
        const pruned = factsDb.pruneExpired();
        const vectorCleanup = await deleteVectorsForFactIds(vectorDb, expiredIds, {
          operation: "plugin-startup-prune-expired",
          logger: api.logger,
        });
        api.logger.info(`memory-hybrid: startup prune removed ${pruned} expired facts`);
        if (vectorCleanup.failed > 0) {
          api.logger.warn(
            `memory-hybrid: startup vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
          );
          capturePluginError(
            new Error(
              `startup vector cleanup partial: deleted ${vectorCleanup.deleted}/${vectorCleanup.attempted}, failed ${vectorCleanup.failed}`,
            ),
            { operation: "plugin-startup-prune-expired", subsystem: "vector" },
          );
        }
      }

      if (ctx.changeFeed && cfg.liveChangeFeed?.enabled !== false) {
        try {
          const prunedChanges = ctx.changeFeed.pruneOlderThan(cfg.liveChangeFeed?.retentionDays ?? 90);
          if (prunedChanges > 0) {
            api.logger.info(`memory-hybrid: pruned ${prunedChanges} old change-feed event(s)`);
          }
        } catch (err) {
          api.logger.debug?.(`memory-hybrid: change-feed prune failed (non-fatal): ${String(err)}`);
        }
        if (isWorkshopEnabled(cfg)) {
          try {
            const synced = syncWorkshopProposedEvents(
              withWorkshopDefaults({
                cfg,
                factsDb,
                proposalsDb: proposalsDb ?? null,
                crystallizationStore: crystallizationStore ?? null,
                toolProposalStore: toolProposalStore ?? null,
                workflowStore: workflowStore ?? null,
                resolvedSqlitePath,
                changeFeed: ctx.changeFeed,
              }),
            );
            if (synced > 0) {
              api.logger.info(`memory-hybrid: synced ${synced} workshop proposed change event(s) on startup`);
            }
          } catch (err) {
            api.logger.debug?.(`memory-hybrid: workshop change-feed sync failed (non-fatal): ${String(err)}`);
          }
        }
      }

      // WAL Recovery: replay uncommitted operations from previous session
      if (wal) {
        const recoveryFlush = await runPreConsolidationFlush(
          { wal, factsDb, vectorDb, embeddings },
          api.logger,
          "WAL recovery",
        );
        if (recoveryFlush.failed) {
          api.logger.error?.(
            "memory-hybrid: WAL recovery failed on startup; mutation commands should abort until WAL replay succeeds",
          );
        } else if (recoveryFlush.committed > 0 || recoveryFlush.skipped > 0) {
          api.logger.info(
            `memory-hybrid: WAL recovery completed — committed ${recoveryFlush.committed}, skipped ${recoveryFlush.skipped}`,
          );
        }

        // Size-based compaction — prunes stale entries when file exceeds maxSizeBytes.
        try {
          const compacted = await wal.compactIfOversized(cfg.wal?.maxSizeBytes ?? 16 * 1024 * 1024);
          if (compacted > 0) {
            api.logger.info(`memory-hybrid: WAL size compaction rewrite completed (maxSizeBytes limit)`);
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: WAL compact failed: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "wal-compact",
          });
        }
      }

      // Issue #305: Sync cron job lastRunAtMs from persistent guard files so the cron
      // runner does not immediately re-fire jobs whose state was lost on restart/reboot.
      try {
        syncCronLastRunFromGuards(api.logger);
      } catch (err) {
        api.logger.warn?.(`memory-hybrid: cron guard sync failed (non-fatal): ${err}`);
      }

      // Wiki integration: register corpus supplement so facts appear in `memory_search corpus=all`
      const uiIntegrationVerbose = integrationVerbose(cfg.verbosity);
      if (cfg.wikiIntegration?.enabled && cfg.wikiIntegration.corpusSupplement) {
        try {
          const { createMemoryCorpusSupplement } = await import("../services/memory-corpus-supplement.js");
          const supplement = createMemoryCorpusSupplement({
            factsDb,
            includeAllScopes: true,
            verbose: uiIntegrationVerbose,
          });
          const registerCorpus = (api as { registerMemoryCorpusSupplement?: (s: unknown) => void })
            .registerMemoryCorpusSupplement;
          if (typeof registerCorpus === "function") {
            registerCorpus(supplement);
            api.logger.info("memory-hybrid: registered MemoryCorpusSupplement for wiki/search integration");
          } else {
            api.logger.debug?.(
              "memory-hybrid: api.registerMemoryCorpusSupplement not available — corpus supplement skipped",
            );
          }
        } catch (err) {
          api.logger.warn?.(
            `memory-hybrid: corpus supplement registration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "corpus-supplement-register",
          });
        }
      }

      // Wiki integration: register publicArtifacts for memory-wiki bridge import
      if (cfg.wikiIntegration?.enabled && cfg.wikiIntegration.publicArtifacts) {
        try {
          const { registerPublicArtifactsBestEffort } = await import("../services/public-artifacts-provider.js");
          registerPublicArtifactsBestEffort(
            api as Parameters<typeof registerPublicArtifactsBestEffort>[0],
            factsDb,
            uiIntegrationVerbose,
          );
        } catch (err) {
          api.logger.warn?.(
            `memory-hybrid: publicArtifacts registration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "public-artifacts-register",
          });
        }
      }

      // Wiki integration: optional workspace markdown mirror (supplement to publicArtifacts RPC)
      if (cfg.wikiIntegration?.enabled && cfg.wikiIntegration.workspaceExportIntervalMinutes > 0) {
        try {
          const { syncWikiWorkspaceExport } = await import("../services/wiki-workspace-export.js");
          const wikiWorkspaceRoot = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
          let wikiExportInFlight = false;

          const runWikiWorkspaceExport = (): void => {
            if (shuttingDown || wikiExportInFlight) return;
            wikiExportInFlight = true;
            try {
              syncWikiWorkspaceExport(factsDb, wikiWorkspaceRoot, uiIntegrationVerbose);
            } catch (err) {
              api.logger.warn?.(
                `memory-hybrid: wiki workspace export failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              wikiExportInFlight = false;
            }
          };

          runWikiWorkspaceExport();
          // #88: a concurrent stop() may have run during the dynamic import above; arming a fresh
          // interval after that would leak forever since clearRuntimeTimers already ran and won't run again.
          if (timers.shuttingDownRef.value) {
            api.logger.debug?.("memory-hybrid: skipping wiki workspace export timer — shutdown in progress");
          } else {
            const wikiExportIntervalMs = cfg.wikiIntegration.workspaceExportIntervalMinutes * 60 * 1000;
            timers.wikiWorkspaceExport = {
              value: setInterval(runWikiWorkspaceExport, wikiExportIntervalMs),
            };
            api.logger.info(
              `memory-hybrid: wiki workspace mirror enabled — syncing to memory/hybrid-wiki/ every ${cfg.wikiIntegration.workspaceExportIntervalMinutes} min`,
            );
          }
        } catch (err) {
          api.logger.warn?.(
            `memory-hybrid: wiki workspace export startup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "wiki-workspace-export-start",
          });
        }
      }

      // Workboard integration: defer probe on cold start (#1940), then retry before arming sync
      if (cfg.workboard?.enabled) {
        const {
          scheduleWorkboardStartupIntegration,
          captureWorkboardBootRegistrationGeneration,
          createWorkboardStartupShouldAbort,
        } = await import("./workboard-integration.js");
        // #88: a concurrent stop() may have run during the dynamic import above; scheduling a fresh
        // deferred timer after that would leak until it self-aborts, and races clearRuntimeTimers.
        if (timers.shuttingDownRef.value) {
          api.logger.debug?.("memory-hybrid: skipping workboard integration setup — shutdown in progress");
        } else {
          const bootRegistrationGeneration = captureWorkboardBootRegistrationGeneration();
          scheduleWorkboardStartupIntegration({
            factsDb,
            vectorDb,
            embeddings,
            cfg,
            api,
            timers,
            shouldAbort: createWorkboardStartupShouldAbort(bootRegistrationGeneration, timers.shuttingDownRef),
            connectLabel: "startup",
          });
        }
      }

      // Issue #309: Mission Control dashboard HTTP server
      if (cfg.dashboard.enabled) {
        try {
          dashboardServer = await createDashboardServer(
            {
              factsDb,
              vectorDb,
              resolvedSqlitePath,
              resolvedLancePath,
              gitRepo: cfg.dashboard.gitRepo,
              costTracker,
              logger: api.logger,
              auditStore,
              agentHealthStore,
              edictStore,
              verificationStore,
              issueStore,
              workflowStore,
              narrativesDb,
              provenanceService,
              graphHubDegreeCap: cfg.graph.hubDegreeCap,
              graphHubScorePenalty: cfg.graph.hubScorePenalty,
              hybridCfg: cfg,
              proposalsDb,
              crystallizationStore: crystallizationStore ?? null,
              toolProposalStore: toolProposalStore ?? null,
              dreamCycleLogDir: resolveDreamCycleLogDir(),
              changeFeed: changeFeed ?? null,
              cfg,
              embeddings,
              embeddingRegistry,
            },
            cfg.dashboard.port,
          );
          // #88: a concurrent stop() may have run while createDashboardServer() was awaiting startup;
          // stop()'s dashboard-close block already ran and won't run again, so close it here instead
          // of leaking a live HTTP server past shutdown.
          if (timers.shuttingDownRef.value) {
            dashboardServer.close();
            dashboardServer = null;
            api.logger.debug?.("memory-hybrid: dashboard server closed immediately — shutdown occurred during startup");
          } else {
            api.logger.info(`memory-hybrid: dashboard started on http://127.0.0.1:${dashboardServer.port}`);
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: dashboard server failed to start (non-fatal): ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "dashboard-start",
          });
        }
      }

      // Unified maintenance tick (cycle tier) — replaces scattered prune/classify/language/observer timers
      let maintenanceTickInFlight = false;
      const runMaintenanceCycleTick = async (label: string) => {
        if (maintenanceTickInFlight) {
          api.logger.debug?.(`memory-hybrid: maintenance tick (${label}) skipped: in_flight`);
          return;
        }
        if (shuttingDown) {
          api.logger.debug?.(`memory-hybrid: maintenance tick (${label}) skipped: shutting_down`);
          return;
        }
        if (typeof factsDb.isOpen === "function" && !factsDb.isOpen()) {
          api.logger.debug?.(`memory-hybrid: maintenance tick (${label}) skipped: db_closed`);
          return;
        }
        maintenanceTickInFlight = true;
        const tickStartedMs = Date.now();
        try {
          const runCompaction = async () =>
            factsDb.retier(
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
              true,
            );

          const runBuildLanguages = async () => {
            const facts = factsDb.getFactsForConsolidation(300);
            const result = await runBuildLanguageKeywords(facts, openai, dirname(resolvedSqlitePath), {
              model: cfg.autoClassify.model ?? getDefaultCronModel(getCronModelConfig(cfg), "default"),
              dryRun: false,
            });
            if (!result.ok) throw new Error(`build-languages failed (${result.error ?? "unknown"} semantic=partial)`);
            return `languagesAdded=${result.languagesAdded} semantic=success`;
          };

          const runPassiveObserverOnce = async () => {
            if (!cfg.passiveObserver?.enabled) return "disabled";
            const { getLLMModelPreference } = await import("../config.js");
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
                provenanceService,
                eventLog,
                dedupWindowMinutes: cfg.store.dedupWindowMinutes ?? 30,
              },
              api.logger,
            );
            const semantic = result.errors > 0 ? "partial" : result.deadlineStopped ? "monitoring" : "success";
            const summary = `stored=${result.factsStored} scanned=${result.sessionsScanned} errors=${result.errors} semantic=${semantic}`;
            if (result.errors > 0) {
              throw new Error(`passive-observer errors=${result.errors} (${summary})`);
            }
            return summary;
          };

          const runLifecycleSync = async () => {
            const github = cfg.lifecycle?.adapters?.github;
            if (!github?.enabled) return "skipped (lifecycle github disabled)";
            const report = await syncLifecycleFromGitHub(factsDb, {
              config: github,
              apply: true,
            });
            return `matched=${report.matched} expiredNow=${report.expiredNow} sync_errors=${report.errors.length} semantic=${report.errors.length > 0 ? "partial" : "success"}`;
          };

          const openclawDir = join(homedir(), ".openclaw");

          const runAnalyzeLogs = async () => {
            const logDir = join(openclawDir, "logs", "cron-hybrid-mem");
            if (!existsSync(logDir)) return "skipped (no cron log dir)";
            const steps = collectMaintenanceSteps(logDir, "24h");
            if (steps.length === 0) return "no log steps in 24h semantic=success";
            return summarizeMaintenanceLogAnalysis(steps).summary;
          };

          const runCredentialsPrune =
            credentialsDb && cfg.credentials?.enabled
              ? async () =>
                  runCredentialsPruneForCli({ credentialsDb } as import("../cli/handlers.js").HandlerContext, {
                    dryRun: false,
                    yes: true,
                  })
              : undefined;

          const runActiveTasksMaintain = async () => {
            if (!cfg.activeTask.enabled) return "disabled";
            const workspaceRoot = resolveOpenClawWorkspaceRoot();
            const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);
            if (cfg.activeTask.ledger === "facts") {
              const r = await reconcileActiveTaskInProgressSessionsFacts(factsDb, vectorDb, embeddings, staleMinutes, {
                flushOnComplete: cfg.activeTask.flushOnComplete !== false,
                memoryDir: join(workspaceRoot, "memory"),
              });
              return `reconciled=${r.reconciledLabels.length} failed=${r.failed} semantic=${r.failed > 0 ? "partial" : "success"}`;
            }
            return "ledger=file (watchdog handles)";
          };

          const runners = buildPluginCycleRunners({
            cfg,
            factsDb,
            vectorDb,
            edictStore,
            auditStore,
            agentHealthStore,
            proposalsDb,
            openai,
            embeddings,
            eventBus: eventBus ?? null,
            resolvedSqlitePath,
            logger: api.logger,
            runCompaction,
            runBuildLanguages,
            runPassiveObserverOnce,
            runLifecycleSync,
            runActiveTasksMaintain,
            runAnalyzeLogs,
            runCredentialsPrune,
          });

          const result = await runMaintenanceTiers(
            { cfg, runners, logger: api.logger, openclawDir, journalDb: factsDb.getRawDb() },
            ["cycle"],
            {
              verbose: false,
            },
          );
          const durationMs = Date.now() - tickStartedMs;
          const summaryTrunc =
            result.summaryLine.length > 240 ? `${result.summaryLine.slice(0, 237)}...` : result.summaryLine;
          if (result.exitCode !== 0) {
            api.logger.warn?.(
              `memory-hybrid: maintenance tick (${label}) exit=${result.exitCode} durationMs=${durationMs}: ${summaryTrunc}`,
            );
          } else {
            api.logger.info?.(
              `memory-hybrid: maintenance tick (${label}) ok durationMs=${durationMs} stepsRun=${result.steps.length}: ${summaryTrunc}`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: maintenance tick failed: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "maintenance-tick",
            operation: "maintenance-tick",
          });
        } finally {
          maintenanceTickInFlight = false;
        }
      };

      const runTrackedMaintenanceCycleTick = (label: string) => {
        maintenanceTickPromise = runMaintenanceCycleTick(label).finally(() => {
          maintenanceTickPromise = null;
        });
      };

      // #88: guard against arming timers after a concurrent stop() already ran clearRuntimeTimers —
      // those handles would never be cleared and would keep firing past shutdown.
      if (timers.shuttingDownRef.value) {
        api.logger.debug?.("memory-hybrid: skipping maintenance tick timers — shutdown in progress");
      } else {
        timers.maintenanceStartupTimeout.value = setTimeout(() => {
          runTrackedMaintenanceCycleTick("startup");
          timers.maintenanceStartupTimeout.value = null;
        }, 5 * 60_000);

        timers.maintenanceTick.value = setInterval(() => {
          runTrackedMaintenanceCycleTick("interval");
        }, 60 * 60_000);
        api.logger.info("memory-hybrid: unified maintenance tick enabled (cycle tier, 60m interval)");
      }

      // Task queue watchdog: periodically detect stale/broken autonomous queue runs and self-heal
      const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
      const watchdogRun = async () => {
        try {
          await runTaskQueueWatchdog({ repoDir: resolveOpenClawWorkspaceRoot() }, api.logger);
        } catch (err) {
          api.logger.warn?.(`memory-hybrid: task-queue-watchdog failed (non-fatal): ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "task-queue-watchdog",
          });
        }
        if (cfg.activeTask.enabled) {
          try {
            const workspaceRoot = resolveOpenClawWorkspaceRoot();
            const activeTaskFilePath = isAbsolute(cfg.activeTask.filePath)
              ? cfg.activeTask.filePath
              : join(workspaceRoot, cfg.activeTask.filePath);
            const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);
            const memoryDir = join(workspaceRoot, "memory");
            let reconciledLabels: string[] = [];
            let wrote = false;
            if (cfg.activeTask.ledger === "facts") {
              const r = await reconcileActiveTaskInProgressSessionsFacts(factsDb, vectorDb, embeddings, staleMinutes, {
                flushOnComplete: cfg.activeTask.flushOnComplete !== false,
                memoryDir,
              });
              reconciledLabels = r.reconciledLabels;
              wrote = r.wrote;
              // Gate is intentional: live GitHub reconciliation only runs when explicitly enabled in config.
              if (cfg.activeTask.liveStateReconcile.enabled) {
                try {
                  const liveResult = await reconcileActiveTaskLiveState(factsDb, vectorDb, embeddings, {
                    maxRequests: 20,
                    log: api.logger,
                  });
                  if (liveResult.updatedCount > 0) {
                    api.logger.info?.(
                      `memory-hybrid: live-state reconcile — marked ${liveResult.updatedCount} task(s) done (checked ${liveResult.checkedCount}, skipped ${liveResult.skippedCount})`,
                    );
                    await renderActiveTaskMarkdownFile(
                      factsDb,
                      staleMinutes,
                      activeTaskFilePath,
                      cfg.activeTask.projection,
                      api.logger,
                      activeTaskRenderGoalsOpts(cfg, workspaceRoot),
                    );
                  }
                } catch (liveErr) {
                  api.logger.warn?.(`memory-hybrid: live-state reconcile failed (non-fatal): ${liveErr}`);
                }
              }
            } else {
              const r = await reconcileActiveTaskInProgressSessions(activeTaskFilePath, staleMinutes, {
                flushOnComplete: cfg.activeTask.flushOnComplete !== false,
                memoryDir,
              });
              reconciledLabels = r.reconciledLabels;
              wrote = r.wrote;
            }
            if (wrote && reconciledLabels.length > 0) {
              api.logger.info?.(
                `memory-hybrid: active-task session reconcile — completed orphan subagent row(s): ${reconciledLabels.join(", ")}`,
              );
              if (cfg.activeTask.ledger === "facts") {
                try {
                  await renderActiveTaskMarkdownFile(
                    factsDb,
                    staleMinutes,
                    activeTaskFilePath,
                    cfg.activeTask.projection,
                    api.logger,
                    activeTaskRenderGoalsOpts(cfg, workspaceRoot),
                  );
                } catch (renderErr) {
                  api.logger.warn?.(
                    `memory-hybrid: active-task projection render after reconcile failed (non-fatal): ${renderErr}`,
                  );
                }
              }
            }
          } catch (reconcileErr) {
            api.logger.warn?.(`memory-hybrid: active-task session reconcile failed (non-fatal): ${reconcileErr}`);
            capturePluginError(reconcileErr instanceof Error ? reconcileErr : new Error(String(reconcileErr)), {
              subsystem: "plugin-service",
              operation: "active-task-session-reconcile",
            });
          }
        }
        if (cfg.goalStewardship.enabled && cfg.goalStewardship.watchdogHealthCheck) {
          try {
            const workspaceRootGs = resolveOpenClawWorkspaceRoot();
            const goalsDir = resolveGoalsDir(workspaceRootGs, cfg.goalStewardship.goalsDir);
            const gh = await runGoalHealthCheck({
              goalsDir,
              cfg: cfg.goalStewardship,
              workspaceRoot: workspaceRootGs,
              logger: api.logger,
              eventLog: eventLog ?? null,
            });
            if (gh.goalsChecked > 0) {
              const compact = gh.outcomes
                .map((o) => `${o.label}:${o.outcome}${o.reason ? `(${o.reason.slice(0, 80)})` : ""}`)
                .join("; ");
              api.logger.info?.(
                `memory-hybrid: goal health check — ${gh.goalsChecked} checked, ${gh.goalsUpdated} updated; outcomes: ${compact || "none"}`,
              );
            }
          } catch (ghErr) {
            api.logger.warn?.(`memory-hybrid: goal health check failed (non-fatal): ${ghErr}`);
            capturePluginError(ghErr instanceof Error ? ghErr : new Error(String(ghErr)), {
              subsystem: "plugin-service",
              operation: "goal-health-check",
            });
          }
        }
      };
      // #88: guard against arming this timer after a concurrent stop() already ran clearRuntimeTimers.
      if (timers.shuttingDownRef.value) {
        api.logger.debug?.("memory-hybrid: skipping task-queue-watchdog timer — shutdown in progress");
      } else {
        timers.watchdogTimer.value = setInterval(() => {
          if (shuttingDown) return;
          if (typeof factsDb.isOpen === "function" && !factsDb.isOpen()) return;
          if (watchdogRunning) return;
          watchdogRunning = true;
          watchdogRunPromise = watchdogRun().finally(() => {
            watchdogRunning = false;
            watchdogRunPromise = null;
          });
        }, WATCHDOG_INTERVAL_MS);
        api.logger.info("memory-hybrid: task-queue-watchdog enabled (interval: 5m)");
      }

      // Post-upgrade pipeline: once per version bump, run build-languages, self-correction, reflection, procedures (via CLI)
      const rawVersionFilePath = join(dirname(resolvedSqlitePath), ".last-post-upgrade-version");
      // Expand literal $HOME or leading ~ if the sqlite path wasn't fully resolved before being stored.
      // Both forms can appear when the plugin config is serialized from user input before normalization.
      const _home = getEnv("HOME") ?? homedir();
      const versionFile = rawVersionFilePath.replace(/\$HOME/g, _home).replace(/^~(?=\/|$)/, _home);
      timers.postUpgradeTimeout.value = setTimeout(() => {
        timers.postUpgradeTimeout.value = null;
        if (timers.shuttingDownRef.value) return;
        let lastVer = "";
        try {
          lastVer = readFileSync(versionFile, "utf-8").trim();
        } catch (err) {
          // ENOENT is expected on first run — don't report to error monitoring
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            capturePluginError(err as Error, {
              operation: "read-version-file",
              severity: "warning",
              subsystem: "plugin-service",
            });
          }
          /* ignore */
        }
        if (lastVer === versionInfo.pluginVersion) return;
        api.logger.info(
          "memory-hybrid: post-upgrade pipeline starting (build-languages, self-correction, reflection, procedures)…",
        );
        void (async () => {
          try {
            const { spawn } = await import("node:child_process");

            const openclawBin = process.env.OPENCLAW_BIN?.trim() || "openclaw";
            const postUpgradeCliTimeoutMs = 600_000;

            const summarizeCliFailure = (stderr: string, stdout: string): string => {
              const lines = `${stdout}\n${stderr}`
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .filter(
                  (l) =>
                    !l.includes("Credentials vault is in plaintext mode") &&
                    !l.includes("credentials vault enabled (plaintext") &&
                    !l.includes("duplicate plugin id detected") &&
                    !l.includes("registerContextEngine not found"),
                );
              const tail = lines.slice(-3).join(" | ");
              return tail || "(no actionable output; see gateway logs)";
            };

            // Helper to run CLI commands asynchronously (non-blocking)
            const runCli = async (args: string[]): Promise<boolean> => {
              return new Promise((resolve) => {
                const child = spawn(openclawBin, ["hybrid-mem", ...args], {
                  cwd: homedir(),
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: postUpgradeCliTimeoutMs,
                  env: process.env,
                });

                let stderr = "";
                let stdout = "";
                child.stderr?.on("data", (chunk) => {
                  stderr += chunk.toString();
                });
                child.stdout?.on("data", (chunk) => {
                  stdout += chunk.toString();
                });

                child.on("close", (code) => {
                  if (code !== 0) {
                    api.logger.warn?.(
                      `memory-hybrid: post-upgrade ${args[0]} failed (exit ${code ?? "?"}): ${summarizeCliFailure(stderr, stdout)}`,
                    );
                  }
                  resolve(code === 0);
                });

                child.on("error", (err) => {
                  api.logger.warn?.(`memory-hybrid: post-upgrade ${args[0]} error: ${err.message}`);
                  resolve(false);
                });
              });
            };

            // #89: this pipeline is fire-and-forget from start()'s perspective and can run for
            // several minutes across sequential subprocess spawns; check for a concurrent stop()
            // before each step so a shutdown mid-pipeline stops spawning new CLI subprocesses
            // instead of continuing to mutate the databases after the plugin was asked to stop.
            const abortIfShuttingDown = (): boolean => {
              if (!timers.shuttingDownRef.value) return false;
              api.logger.info?.("memory-hybrid: post-upgrade pipeline aborted — shutdown in progress");
              return true;
            };

            const langPath = getLanguageKeywordsFilePath();
            if (abortIfShuttingDown()) return;
            if (langPath && !existsSync(langPath)) await runCli(["build-languages"]);
            if (abortIfShuttingDown()) return;
            await runCli(["self-correction-run", "--force"]);
            if (cfg.reflection.enabled) {
              if (abortIfShuttingDown()) return;
              await runCli(["reflect", "--window", String(cfg.reflection.defaultWindow), "--force"]);
              if (abortIfShuttingDown()) return;
              await runCli(["reflect-rules", "--force"]);
            }
            if (abortIfShuttingDown()) return;
            await runCli(["extract-procedures", "--force"]);
            if (abortIfShuttingDown()) return;
            await runCli(["generate-auto-skills"]);
            // Only mark the pipeline complete once every step above actually ran to completion.
            if (abortIfShuttingDown()) return;
            writeFileSync(versionFile, versionInfo.pluginVersion, "utf-8");
            api.logger.info("memory-hybrid: post-upgrade pipeline done.");
          } catch (e) {
            api.logger.warn?.(`memory-hybrid: post-upgrade pipeline error: ${e}`);
            capturePluginError(e instanceof Error ? e : new Error(String(e)), {
              subsystem: "plugin-service",
              operation: "post-upgrade-pipeline",
            });
          }
        })();
      }, 20000);
    },
    stop: async () => {
      shuttingDown = true;
      timers.shuttingDownRef.value = true;
      clearRuntimeTimers(timers);
      // #91: startEventLoopLagMonitor() is armed during registration (register-plugin.ts) but was
      // never paired with a stop() here — only the CLI one-shot teardown path called this,
      // leaving the perf_hooks histogram sampling indefinitely after a real plugin shutdown.
      stopEventLoopLagMonitor();
      // Flush pending error reports with adaptive timeout so persisted queue replay can drain.
      if (isErrorReporterActive()) {
        const flushed = await flushErrorReporter().catch(() => false);
        if (!flushed) {
          // Distinguish a transient offline endpoint (info, expected) from a genuine local queue
          // problem (warn) so restarts against an unreachable GlitchTip don't look like errors (#2113).
          const drainState = describePendingTelemetryDrain({
            phase: "shutdown",
            pendingCount: getPendingErrorReportCount(),
            failureKind: getLastErrorReportSendFailureKind(),
          });
          if (drainState.level === "info") {
            api.logger.info?.(drainState.message);
          } else {
            api.logger.warn(drainState.message);
          }
        }
      }
      if (dashboardServer) {
        try {
          dashboardServer.close();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "dashboard-close",
            severity: "warning",
          });
        }
        dashboardServer = null;
      }
      api.logger.info("memory-hybrid: stopping...");
      if (watchdogRunPromise) {
        const timeoutMs = 5000;
        const completed = await Promise.race([
          watchdogRunPromise.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!completed) {
          api.logger.warn("memory-hybrid: task-queue-watchdog shutdown timed out; continuing shutdown anyway");
        }
      }
      if (maintenanceTickPromise) {
        // A tick still holding factsDb/vectorDb handles when they're closed below can throw
        // "database is closed" mid-operation, or (worse) race a write against handle teardown.
        const timeoutMs = 5000;
        const completed = await Promise.race([
          maintenanceTickPromise.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!completed) {
          api.logger.warn("memory-hybrid: maintenance-tick shutdown timed out; continuing shutdown anyway");
        }
      }
      if (versionCheckPromise) {
        const timeoutMs = 5000;
        const completed = await Promise.race([
          versionCheckPromise.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!completed) {
          api.logger.warn("memory-hybrid: version-check shutdown timed out; continuing shutdown anyway");
        }
      }
      if (ctx.pythonBridge) {
        await ctx.pythonBridge.shutdown();
      }
      closeStorePermanently(factsDb, "factsDb", api.logger);
      // VectorDB is LanceDB-based (not a BaseSqliteStore); its close() is already terminal.
      vectorDb.close();
      closeStorePermanently(credentialsDb, "credentialsDb", api.logger);
      closeStorePermanently(proposalsDb, "proposalsDb", api.logger);
      closeStorePermanently(auditStore, "auditStore", api.logger);
      closeStorePermanently(agentHealthStore, "agentHealthStore", api.logger);
      closeStorePermanently(edictStore, "edictStore", api.logger);
      closeStorePermanently(eventLog, "eventLog", api.logger);
      closeStorePermanently(narrativesDb, "narrativesDb", api.logger);
      closeStorePermanently(issueStore, "issueStore", api.logger);
      closeStorePermanently(workflowStore, "workflowStore", api.logger);
      closeStorePermanently(crystallizationStore, "crystallizationStore", api.logger);
      closeStorePermanently(toolProposalStore, "toolProposalStore", api.logger);
      // VerificationStore doesn't extend BaseSqliteStore / doesn't implement permanentClose();
      // closeStorePermanently() falls back to its plain close().
      closeStorePermanently(verificationStore, "verificationStore", api.logger);
      closeStorePermanently(eventBus, "eventBus", api.logger);
      // #90: these were threaded through PluginRuntime but never reached plugin-service's stop(),
      // so they leaked open SQLite handles on shutdown (only closed on re-register, not a plain stop()).
      closeStorePermanently(identityReflectionStore, "identityReflectionStore", api.logger);
      closeStorePermanently(personaStateStore, "personaStateStore", api.logger);
      closeStorePermanently(learningsDb, "learningsDb", api.logger);
      closeStorePermanently(apitapStore, "apitapStore", api.logger);
      // AliasDB doesn't extend BaseSqliteStore / doesn't implement permanentClose();
      // closeStorePermanently() falls back to its plain close().
      closeStorePermanently(aliasDb, "aliasDb", api.logger);
      if (vaultRegistry) {
        try {
          vaultRegistry.closeAll();
        } catch (err) {
          api.logger.warn(`memory-hybrid: failed to close vaultRegistry during shutdown: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "close-vaultRegistry",
            severity: "warning",
          });
        }
      }
    },
  };
}
