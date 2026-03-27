import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { FactsDB } from "../backends/facts-db.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import { getDefaultCronModel, getCronModelConfig } from "../config.js";
import type { ProvenanceService } from "../services/provenance.js";
import type OpenAI from "openai";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import {
  initErrorReporter,
  isErrorReporterActive,
  flushErrorReporter,
  capturePluginError,
  setErrorReporterMuted,
} from "../services/error-reporter.js";
import { walRemove } from "../services/wal-helpers.js";
import { syncCronLastRunFromGuards } from "../services/cron-guard.js";
import { createDashboardServer } from "../routes/dashboard-server.js";
import type { DashboardServer } from "../routes/dashboard-server.js";
import { runPassiveObserver } from "../services/passive-observer.js";
import { runAutoClassify } from "../services/auto-classifier.js";
import { runBuildLanguageKeywords } from "../services/language-keywords-build.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";
import {
  type VersionCheckCacheEntry,
  fetchLatestPublishedVersion,
  isPluginOutdated,
  isVersionCheckCacheFresh,
  maybeLogOutdatedVersionNudge,
  readVersionCheckCache,
  writeVersionCheckCache,
} from "../utils/plugin-update-check.js";
import { versionInfo } from "../versionInfo.js";
import { checkOpenClawVersion } from "../utils/version-check.js";
import { runTaskQueueWatchdog } from "../services/task-queue-watchdog.js";

export interface PluginServiceContext {
  PLUGIN_ID: string;
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
  // Mutable timer refs that will be updated by the start handler
  timers: {
    pruneTimer: { value: ReturnType<typeof setInterval> | null };
    classifyTimer: { value: ReturnType<typeof setInterval> | null };
    classifyStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    proposalsPruneTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    postUpgradeTimeout: { value: ReturnType<typeof setTimeout> | null };
    passiveObserverTimer: { value: ReturnType<typeof setInterval> | null };
    watchdogTimer: { value: ReturnType<typeof setInterval> | null };
  };
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
export function createPluginService(ctx: PluginServiceContext) {
  const {
    PLUGIN_ID,
    factsDb,
    edictStore,
    vectorDb,
    embeddings,
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
  } = ctx;

  let observerRunning = false;
  let observerRunPromise: Promise<void> | null = null;
  let watchdogRunning = false;
  let watchdogRunPromise: Promise<void> | null = null;
  let shuttingDown = false;
  let dashboardServer: DashboardServer | null = null;
  let versionCheckPromise: Promise<void> | null = null;

  return {
    id: PLUGIN_ID,
    _getVersionCheckPromise: () => versionCheckPromise,
    start: async () => {
      const sqlCount = factsDb.count();
      const expired = factsDb.countExpired();
      const versionCheckCachePath =
        resolvedSqlitePath === ":memory:" ? null : join(dirname(resolvedSqlitePath), ".latest-plugin-version.json");
      const errorReportingActive = cfg.errorReporting.enabled && cfg.errorReporting.consent;
      let cachedVersionCheck = versionCheckCachePath ? readVersionCheckCache(versionCheckCachePath) : null;
      api.logger.info(
        `memory-hybrid: initialized v${versionInfo.pluginVersion} (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
      );

      checkOpenClawVersion(api.version, api.logger);

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
            checkedAt: new Date().toISOString(),
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
        const pruned = factsDb.pruneExpired();
        api.logger.info(`memory-hybrid: startup prune removed ${pruned} expired facts`);
      }

      // WAL Recovery: replay uncommitted operations from previous session
      if (wal) {
        const pendingEntries = await wal.getValidEntries();
        if (pendingEntries.length > 0) {
          api.logger.info(`memory-hybrid: WAL recovery starting — found ${pendingEntries.length} pending operation(s)`);
          let recovered = 0;
          let failed = 0;

          for (const entry of pendingEntries) {
            try {
              if (entry.operation === "store" || entry.operation === "update") {
                const { text, category, importance, entity, key, value, source, decayClass, summary, tags } =
                  entry.data;

                // Check if already stored (idempotency)
                if (!factsDb.hasDuplicate(text)) {
                  // Store to SQLite
                  const stored = factsDb.store({
                    text,
                    category: (category as MemoryCategory) || "other",
                    importance: importance ?? 0.5,
                    entity: entity || null,
                    key: key || null,
                    value: value || null,
                    source: source || "wal-recovery",
                    decayClass,
                    summary,
                    tags,
                  });

                  // Store to LanceDB (async, best effort) with same fact id for classification
                  if (entry.data.vector) {
                    void vectorDb
                      .store({
                        text,
                        vector: entry.data.vector,
                        importance: importance ?? 0.5,
                        category: category || "other",
                        id: stored.id,
                      })
                      .then(() => {
                        factsDb.setEmbeddingModel(stored.id, embeddings.modelName);
                      })
                      .catch((err) => {
                        api.logger.warn(
                          `memory-hybrid: WAL recovery vector store failed for entry ${entry.id}: ${err}`,
                        );
                        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                          subsystem: "plugin-service",
                          operation: "wal-recovery-vector-store",
                        });
                      });
                  }

                  recovered++;
                }
              } else {
                // Known but unhandled operation type (e.g., "delete")
                api.logger.warn(
                  `memory-hybrid: WAL recovery skipping unsupported operation "${entry.operation}" (entry ${entry.id})`,
                );
              }

              await walRemove(wal, entry.id, api.logger);
            } catch (err) {
              api.logger.warn(`memory-hybrid: WAL recovery failed for entry ${entry.id}: ${err}`);
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "plugin-service",
                operation: "wal-recovery-entry",
              });
              failed++;
            }
          }

          if (recovered > 0 || failed > 0) {
            api.logger.info(
              `memory-hybrid: WAL recovery completed — recovered ${recovered} operation(s), ${failed} failed`,
            );
          }

          // Prune any remaining stale entries
          try {
            const pruned = await wal.pruneStale();
            if (pruned > 0) {
              api.logger.info(`memory-hybrid: WAL pruned ${pruned} stale entries`);
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: WAL prune failed: ${err}`);
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "plugin-service",
              operation: "wal-prune-stale",
            });
          }
        }
      }

      // Issue #305: Sync cron job lastRunAtMs from persistent guard files so the cron
      // runner does not immediately re-fire jobs whose state was lost on restart/reboot.
      try {
        syncCronLastRunFromGuards(api.logger);
      } catch (err) {
        api.logger.warn?.(`memory-hybrid: cron guard sync failed (non-fatal): ${err}`);
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
            },
            cfg.dashboard.port,
          );
          api.logger.info(`memory-hybrid: dashboard started on http://127.0.0.1:${dashboardServer.port}`);
        } catch (err) {
          api.logger.warn(`memory-hybrid: dashboard server failed to start (non-fatal): ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "dashboard-start",
          });
        }
      }

      // Periodic prune timer
      timers.pruneTimer.value = setInterval(() => {
        try {
          const hardPruned = factsDb.pruneExpired();
          const softPruned = factsDb.decayConfidence();
          const edictsPruned = edictStore.pruneExpired();
          if (hardPruned > 0 || softPruned > 0 || edictsPruned > 0) {
            api.logger.info(
              `memory-hybrid: periodic prune — ${hardPruned} expired, ${softPruned} decayed, ${edictsPruned} edicts pruned`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: periodic prune failed: ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "periodic-prune",
          });
        }
      }, 60 * 60_000); // every hour

      // Daily auto-classify: reclassify "other" facts using LLM (if enabled)
      if (cfg.autoClassify.enabled) {
        const CLASSIFY_INTERVAL = 24 * 60 * 60_000; // 24 hours
        const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");

        const classifyModel = cfg.autoClassify.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
        // Run once shortly after startup (5 min delay to let things settle)
        timers.classifyStartupTimeout.value = setTimeout(async () => {
          try {
            await runAutoClassify(factsDb, openai, cfg.autoClassify, api.logger, {
              discoveredCategoriesPath: discoveredPath,
              model: classifyModel,
            });
          } catch (err) {
            api.logger.warn(`memory-hybrid: startup auto-classify failed: ${err}`);
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "plugin-service",
              operation: "startup-auto-classify",
            });
          }
        }, 5 * 60_000);

        timers.classifyTimer.value = setInterval(async () => {
          try {
            await runAutoClassify(factsDb, openai, cfg.autoClassify, api.logger, {
              discoveredCategoriesPath: discoveredPath,
              model: classifyModel,
            });
          } catch (err) {
            api.logger.warn(`memory-hybrid: daily auto-classify failed: ${err}`);
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "plugin-service",
              operation: "daily-auto-classify",
            });
          }
        }, CLASSIFY_INTERVAL);

        api.logger.info(
          `memory-hybrid: auto-classify enabled (model: ${classifyModel}, interval: 24h, batch: ${cfg.autoClassify.batchSize})`,
        );
      }

      // Auto-build multilingual keywords: run once at startup if no file, then weekly (captures language drift)
      if (cfg.languageKeywords.autoBuild) {
        const langFilePath = getLanguageKeywordsFilePath();
        const runBuild = async () => {
          try {
            const facts = factsDb.getFactsForConsolidation(300);
            const result = await runBuildLanguageKeywords(facts, openai, dirname(resolvedSqlitePath), {
              model: cfg.autoClassify.model ?? getDefaultCronModel(getCronModelConfig(cfg), "default"),
              dryRun: false,
            });
            if (result.ok && result.languagesAdded > 0) {
              api.logger.info(
                `memory-hybrid: language keywords updated (${result.topLanguages.join(", ")}, +${result.languagesAdded} languages)`,
              );
            } else if (result.ok) {
              api.logger.info(`memory-hybrid: language keywords build done (${result.topLanguages.join(", ")})`);
            } else {
              api.logger.warn(`memory-hybrid: language keywords build failed: ${result.error}`);
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: language keywords build failed: ${err}`);
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "plugin-service",
              operation: "language-keywords-build",
            });
          }
        };

        if (langFilePath && !existsSync(langFilePath)) {
          api.logger.info("memory-hybrid: no language keywords file; building from memory samples in 3s…");
          timers.languageKeywordsStartupTimeout.value = setTimeout(() => {
            void runBuild();
            timers.languageKeywordsStartupTimeout.value = null;
          }, 3000);
        }

        const weeklyMs = cfg.languageKeywords.weeklyIntervalDays * 24 * 60 * 60 * 1000;
        timers.languageKeywordsTimer.value = setInterval(() => void runBuild(), weeklyMs);
        api.logger.info(
          `memory-hybrid: language keywords auto-build enabled (every ${cfg.languageKeywords.weeklyIntervalDays} days)`,
        );
      }

      // Passive observer: background fact extraction from session transcripts
      if (cfg.passiveObserver.enabled) {
        const { getLLMModelPreference } = await import("../config.js");
        const observerModel =
          cfg.passiveObserver.model ??
          getLLMModelPreference(getCronModelConfig(cfg), "nano")[0] ??
          getDefaultCronModel(getCronModelConfig(cfg), "nano");
        const observerFallbacks = (() => {
          const pref = getLLMModelPreference(getCronModelConfig(cfg), "nano");
          return pref.length > 1 ? pref.slice(1) : undefined;
        })();
        const dbDir = dirname(resolvedSqlitePath);

        const runObserver = async () => {
          try {
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
                dbDir,
                proceduresSessionsDir: cfg.procedures.sessionsDir,
                reinforcement: cfg.reinforcement,
                provenanceService,
                eventLog,
              },
              api.logger,
            );
            if (result.factsStored > 0 || result.factsExtracted > 0 || result.factsReinforced > 0) {
              api.logger.info(
                `memory-hybrid: passive-observer — scanned ${result.sessionsScanned} sessions, ` +
                  `${result.chunksProcessed} chunks, ${result.factsExtracted} extracted, ` +
                  `${result.factsStored} stored, ${result.factsReinforced} reinforced`,
              );
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: passive-observer run failed: ${err}`);
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "plugin-service",
              operation: "passive-observer-run",
            });
          }
        };

        const intervalMs = cfg.passiveObserver.intervalMinutes * 60_000;
        timers.passiveObserverTimer.value = setInterval(() => {
          if (shuttingDown) return;
          if (observerRunning) return;
          observerRunning = true;
          observerRunPromise = runObserver().finally(() => {
            observerRunning = false;
            observerRunPromise = null;
          });
        }, intervalMs);
        api.logger.info(
          `memory-hybrid: passive-observer enabled (model: ${observerModel}, interval: ${cfg.passiveObserver.intervalMinutes}m, minImportance: ${cfg.passiveObserver.minImportance})`,
        );
      }

      // Task queue watchdog: periodically detect stale/broken autonomous queue runs and self-heal
      const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
      const watchdogRun = async () => {
        try {
          await runTaskQueueWatchdog({ repoDir: process.env.OPENCLAW_WORKSPACE ?? process.cwd() }, api.logger);
        } catch (err) {
          api.logger.warn?.(`memory-hybrid: task-queue-watchdog failed (non-fatal): ${err}`);
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "plugin-service",
            operation: "task-queue-watchdog",
          });
        }
      };
      timers.watchdogTimer.value = setInterval(() => {
        if (shuttingDown) return;
        if (watchdogRunning) return;
        watchdogRunning = true;
        watchdogRunPromise = watchdogRun().finally(() => {
          watchdogRunning = false;
          watchdogRunPromise = null;
        });
      }, WATCHDOG_INTERVAL_MS);
      api.logger.info("memory-hybrid: task-queue-watchdog enabled (interval: 5m)");

      // Post-upgrade pipeline: once per version bump, run build-languages, self-correction, reflection, procedures (via CLI)
      const rawVersionFilePath = join(dirname(resolvedSqlitePath), ".last-post-upgrade-version");
      // Expand literal $HOME or leading ~ if the sqlite path wasn't fully resolved before being stored.
      // Both forms can appear when the plugin config is serialized from user input before normalization.
      const _home = process.env.HOME ?? homedir();
      const versionFile = rawVersionFilePath.replace(/\$HOME/g, _home).replace(/^~(?=\/|$)/, _home);
      timers.postUpgradeTimeout.value = setTimeout(() => {
        timers.postUpgradeTimeout.value = null;
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

            // Helper to run CLI commands asynchronously (non-blocking)
            const runCli = async (args: string[]): Promise<boolean> => {
              return new Promise((resolve) => {
                const child = spawn("openclaw", ["hybrid-mem", ...args], {
                  cwd: homedir(),
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: 120_000,
                });

                let stderr = "";
                child.stderr?.on("data", (chunk) => {
                  stderr += chunk.toString();
                });

                child.on("close", (code) => {
                  if (code !== 0 && stderr) {
                    api.logger.warn?.(`memory-hybrid: post-upgrade ${args[0]} failed: ${stderr.slice(0, 200)}`);
                  }
                  resolve(code === 0);
                });

                child.on("error", (err) => {
                  api.logger.warn?.(`memory-hybrid: post-upgrade ${args[0]} error: ${err.message}`);
                  resolve(false);
                });
              });
            };

            const langPath = getLanguageKeywordsFilePath();
            if (langPath && !existsSync(langPath)) await runCli(["build-languages"]);
            await runCli(["self-correction-run"]);
            if (cfg.reflection.enabled) {
              await runCli(["reflect", "--window", String(cfg.reflection.defaultWindow)]);
              await runCli(["reflect-rules"]);
            }
            await runCli(["extract-procedures"]);
            await runCli(["generate-auto-skills"]);
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
      // Flush any pending error reports before shutdown (non-blocking)
      if (isErrorReporterActive()) {
        flushErrorReporter(2000).catch(() => {});
      }
      if (timers.pruneTimer.value) {
        clearInterval(timers.pruneTimer.value);
        timers.pruneTimer.value = null;
      }
      if (timers.classifyStartupTimeout.value) {
        clearTimeout(timers.classifyStartupTimeout.value);
        timers.classifyStartupTimeout.value = null;
      }
      if (timers.classifyTimer.value) {
        clearInterval(timers.classifyTimer.value);
        timers.classifyTimer.value = null;
      }
      if (timers.proposalsPruneTimer.value) {
        clearInterval(timers.proposalsPruneTimer.value);
        timers.proposalsPruneTimer.value = null;
      }
      if (timers.languageKeywordsStartupTimeout.value) {
        clearTimeout(timers.languageKeywordsStartupTimeout.value);
        timers.languageKeywordsStartupTimeout.value = null;
      }
      if (timers.languageKeywordsTimer.value) {
        clearInterval(timers.languageKeywordsTimer.value);
        timers.languageKeywordsTimer.value = null;
      }
      if (timers.passiveObserverTimer.value) {
        clearInterval(timers.passiveObserverTimer.value);
        timers.passiveObserverTimer.value = null;
      }
      if (timers.postUpgradeTimeout.value) {
        clearTimeout(timers.postUpgradeTimeout.value);
        timers.postUpgradeTimeout.value = null;
      }
      if (timers.watchdogTimer.value) {
        clearInterval(timers.watchdogTimer.value);
        timers.watchdogTimer.value = null;
      }
      if (dashboardServer) {
        try {
          dashboardServer.close();
        } catch {
          /* non-fatal */
        }
        dashboardServer = null;
      }
      api.logger.info("memory-hybrid: stopping...");
      if (observerRunPromise) {
        const timeoutMs = 5000;
        const completed = await Promise.race([
          observerRunPromise.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!completed) {
          api.logger.warn("memory-hybrid: passive-observer shutdown timed out; closing databases anyway");
        }
      }
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
      factsDb.close();
      vectorDb.close();
      if (credentialsDb) {
        credentialsDb.close();
      }
      if (proposalsDb) {
        proposalsDb.close();
      }
    },
  };
}
