import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import type OpenAI from "openai";
import {
  initErrorReporter,
  isErrorReporterActive,
  flushErrorReporter,
  capturePluginError,
} from "../services/error-reporter.js";
import { walRemove } from "../services/wal-helpers.js";
import { runAutoClassify } from "../services/auto-classifier.js";
import { runBuildLanguageKeywords } from "../services/language-keywords-build.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";
import { versionInfo } from "../versionInfo.js";

export interface PluginServiceContext {
  PLUGIN_ID: string;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  credentialsDb: CredentialsDB | null;
  proposalsDb: ProposalsDB | null;
  wal: WriteAheadLog | null;
  cfg: HybridMemoryConfig;
  openai: OpenAI;
  resolvedLancePath: string;
  resolvedSqlitePath: string;
  api: ClawdbotPluginApi;
  // Mutable timer refs that will be updated by the start handler
  timers: {
    pruneTimer: { value: ReturnType<typeof setInterval> | null };
    classifyTimer: { value: ReturnType<typeof setInterval> | null };
    classifyStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    proposalsPruneTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    postUpgradeTimeout: { value: ReturnType<typeof setTimeout> | null };
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
    vectorDb,
    credentialsDb,
    proposalsDb,
    wal,
    cfg,
    openai,
    resolvedLancePath,
    resolvedSqlitePath,
    api,
    timers,
  } = ctx;

  return {
    id: PLUGIN_ID,
    start: async () => {
      const sqlCount = factsDb.count();
      const expired = factsDb.countExpired();
      api.logger.info(
        `memory-hybrid: initialized v${versionInfo.pluginVersion} (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
      );

      // ========================================================================
      // Startup Task Sequencing (to avoid race conditions):
      // 1. Error reporter init (async)
      // 2. Prune expired facts (synchronous)
      // 3. WAL recovery (synchronous)
      // 4. Start periodic timers (async background tasks with delays)
      // ========================================================================

      // Initialize error reporter if configured
      if (cfg.errorReporting) {
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
            },
            versionInfo.pluginVersion,
            api.logger,
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
      }

      if (expired > 0) {
        const pruned = factsDb.pruneExpired();
        api.logger.info(`memory-hybrid: startup prune removed ${pruned} expired facts`);
      }

      // WAL Recovery: replay uncommitted operations from previous session
      if (wal) {
        const pendingEntries = wal.getValidEntries();
        if (pendingEntries.length > 0) {
          api.logger.info(`memory-hybrid: WAL recovery starting — found ${pendingEntries.length} pending operation(s)`);
          let recovered = 0;
          let failed = 0;

          for (const entry of pendingEntries) {
            try {
              if (entry.operation === "store" || entry.operation === "update") {
                const { text, category, importance, entity, key, value, source, decayClass, summary, tags } = entry.data;

                // Check if already stored (idempotency)
                if (!factsDb.hasDuplicate(text)) {
                  // Store to SQLite
                  const stored = factsDb.store({
                    text,
                    category: (category as MemoryCategory) || "other",
                    importance: importance ?? 0.7,
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
                    void vectorDb.store({
                      text,
                      vector: entry.data.vector,
                      importance: importance ?? 0.7,
                      category: category || "other",
                      id: stored.id,
                    }).catch((err) => {
                      api.logger.warn(`memory-hybrid: WAL recovery vector store failed for entry ${entry.id}: ${err}`);
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
                api.logger.warn(`memory-hybrid: WAL recovery skipping unsupported operation "${entry.operation}" (entry ${entry.id})`);
              }

              walRemove(wal, entry.id, api.logger);
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
            api.logger.info(`memory-hybrid: WAL recovery completed — recovered ${recovered} operation(s), ${failed} failed`);
          }

          // Prune any remaining stale entries
          try {
            const pruned = wal.pruneStale();
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

      // Periodic prune timer
      timers.pruneTimer.value = setInterval(() => {
        try {
          const hardPruned = factsDb.pruneExpired();
          const softPruned = factsDb.decayConfidence();
          if (hardPruned > 0 || softPruned > 0) {
            api.logger.info(
              `memory-hybrid: periodic prune — ${hardPruned} expired, ${softPruned} decayed`,
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

        // Run once shortly after startup (5 min delay to let things settle)
        timers.classifyStartupTimeout.value = setTimeout(async () => {
          try {
            await runAutoClassify(factsDb, openai, cfg.autoClassify, api.logger, {
              discoveredCategoriesPath: discoveredPath,
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
          `memory-hybrid: auto-classify enabled (model: ${cfg.autoClassify.model}, interval: 24h, batch: ${cfg.autoClassify.batchSize})`,
        );
      }

      // Auto-build multilingual keywords: run once at startup if no file, then weekly (captures language drift)
      if (cfg.languageKeywords.autoBuild) {
        const langFilePath = getLanguageKeywordsFilePath();
        const runBuild = async () => {
          try {
            const facts = factsDb.getFactsForConsolidation(300);
            const result = await runBuildLanguageKeywords(
              facts,
              openai,
              dirname(resolvedSqlitePath),
              { model: cfg.autoClassify.model, dryRun: false },
            );
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

      // Post-upgrade pipeline: once per version bump, run build-languages, self-correction, reflection, procedures (via CLI)
      const versionFile = join(dirname(resolvedSqlitePath), ".last-post-upgrade-version");
      timers.postUpgradeTimeout.value = setTimeout(() => {
        timers.postUpgradeTimeout.value = null;
        let lastVer = "";
        try {
          lastVer = readFileSync(versionFile, "utf-8").trim();
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'read-version-file',
            severity: 'info',
            subsystem: 'plugin-service'
          });
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
    stop: () => {
      // Flush any pending error reports before shutdown (non-blocking)
      if (isErrorReporterActive()) {
        flushErrorReporter(2000).catch(() => {});
      }
      if (timers.pruneTimer.value) { clearInterval(timers.pruneTimer.value); timers.pruneTimer.value = null; }
      if (timers.classifyStartupTimeout.value) { clearTimeout(timers.classifyStartupTimeout.value); timers.classifyStartupTimeout.value = null; }
      if (timers.classifyTimer.value) { clearInterval(timers.classifyTimer.value); timers.classifyTimer.value = null; }
      if (timers.proposalsPruneTimer.value) { clearInterval(timers.proposalsPruneTimer.value); timers.proposalsPruneTimer.value = null; }
      if (timers.languageKeywordsStartupTimeout.value) {
        clearTimeout(timers.languageKeywordsStartupTimeout.value);
        timers.languageKeywordsStartupTimeout.value = null;
      }
      if (timers.languageKeywordsTimer.value) { clearInterval(timers.languageKeywordsTimer.value); timers.languageKeywordsTimer.value = null; }
      if (timers.postUpgradeTimeout.value) {
        clearTimeout(timers.postUpgradeTimeout.value);
        timers.postUpgradeTimeout.value = null;
      }
      api.logger.info("memory-hybrid: stopping...");
      factsDb.close();
      vectorDb.close();
      if (credentialsDb) { credentialsDb.close(); }
      if (proposalsDb) { proposalsDb.close(); }
    },
  };
}
