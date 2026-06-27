/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getCronModelConfig } from "../../../config.js";
import { reconcileAllCronRunLedgers } from "../../../services/cron-maintenance-reconciler.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../../../services/hybrid-mem-cron-default-job-steps.js";
import { appendVectorLifecycleAuditEvent } from "../../../services/vector-lifecycle-audit.js";
import { findOrphanVectorIds, reconcileOrphanVectors } from "../../../services/vector-maintenance.js";
import { PLUGIN_ID } from "../../../utils/constants.js";
import { nowIso, formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { describeCronStoreLocation } from "../../../services/openclaw-cron-store.js";
import { ensureGoalStewardshipHeartbeatCronJob, ensureMaintenanceCronJobs } from "../../cmd-install.js";
import { buildMaintenanceCronFeatureGates, readConsolidatedCronJobsFlag } from "../../install/cron-jobs.js";

import type { VerifyRunState } from "../verify-run-state.js";

export async function runVerifyReconcileSection(state: VerifyRunState): Promise<void> {
  const {
    ctx,
    opts,
    cfg,
    factsDb,
    vectorDb,
    embeddings,
    credentialsDb,
    resolvedSqlitePath,
    resolvedLancePath,
    openai,
    log,
    tableLog,
    OK,
    FAIL,
    PAUSE,
    WARN_LINE,
    noEmoji,
    issues,
    fixes,
    warnings,
    loadBlocking,
    extDir,
    defaultConfigPath,
    openclawDir,
    openclawConfigRead,
    recommendedEmbedding,
    dashboardUrl,
  } = state;

  // ───── Reconciliation Check ─────
  if (opts.reconcile) {
    log("\n───── Vector DB Reconciliation ─────");
    if (!state.sqliteOk || !state.lanceOk || !vectorDb.isLanceDbAvailable()) {
      log(`${FAIL} Reconciliation skipped — both SQLite and LanceDB must be healthy to reconcile.`);
      state.allOk = false;
    } else {
      try {
        const reconcilePolicy = opts.reconcilePolicy ?? "balanced";
        const reconcileMaxFixes = Math.max(0, Math.min(5000, opts.reconcileMaxFixes ?? 200));
        const sqliteOrphanRebuildBudget =
          reconcilePolicy === "conservative"
            ? 0
            : reconcilePolicy === "balanced"
              ? reconcileMaxFixes
              : Math.max(reconcileMaxFixes, 2000);
        const sqliteIds = new Set(factsDb.getAllIds());
        const vectorIds = await vectorDb.getAllIds();

        // Vector orphans: IDs in LanceDB that have no corresponding SQLite fact.
        const vectorOrphans = await findOrphanVectorIds(factsDb, vectorDb);
        // SQLite orphans: active facts in SQLite with no vector in LanceDB.
        const vectorIdSet = new Set(vectorIds);
        const sqliteOrphans = Array.from(sqliteIds).filter((id) => !vectorIdSet.has(id));

        if (vectorOrphans.length === 0 && sqliteOrphans.length === 0) {
          log(
            `${OK} Reconciliation: SQLite and LanceDB are in sync (${sqliteIds.size} facts, ${vectorIds.length} vectors)`,
          );
        } else {
          state.allOk = false;
          if (vectorOrphans.length > 0) {
            log(`${FAIL} Vector orphans (in LanceDB but not SQLite): ${vectorOrphans.length}`);
            vectorOrphans.slice(0, 10).forEach((id) => {
              log(`  - ${id}`);
            });
            if (vectorOrphans.length > 10) log(`  … and ${vectorOrphans.length - 10} more`);
            if (opts.fix) {
              const reconcileResult = await reconcileOrphanVectors(factsDb, vectorDb, {
                operation: "verify-reconcile",
              });
              log(
                `  → Delete attempted for ${reconcileResult.orphansFound} orphan vector(s): ` +
                  `deleted=${reconcileResult.orphanVectorsRemoved}, failed=${reconcileResult.failed}.`,
              );

              let unresolvedAfterDelete = [...vectorOrphans];
              let recheckFailed = false;
              try {
                unresolvedAfterDelete = await findOrphanVectorIds(factsDb, vectorDb);
              } catch (recheckErr) {
                log(`${FAIL} Could not re-query LanceDB after delete attempt: ${String(recheckErr)}`);
                recheckFailed = true;
              }

              if (recheckFailed) {
                log(
                  `${FAIL} Reconciliation verification failed — cannot confirm whether ${vectorOrphans.length} orphan vector(s) were removed.`,
                );
                state.issues.push(
                  `${vectorOrphans.length} orphan vector(s) deletion could not be verified due to LanceDB re-query failure`,
                );
                state.allOk = false;
              } else {
                const verifiedRemoved = vectorOrphans.length - unresolvedAfterDelete.length;
                if (unresolvedAfterDelete.length === 0) {
                  log(`  → Verified removal: ${verifiedRemoved}/${vectorOrphans.length} orphan vector(s) are gone.`);
                  fixes.push(`Verified removal of ${verifiedRemoved} LanceDB orphan vector(s)`);
                } else {
                  log(
                    `${FAIL} Reconciliation incomplete — ${unresolvedAfterDelete.length}/${vectorOrphans.length} orphan vector(s) remain after delete attempt.`,
                  );
                  for (const id of unresolvedAfterDelete.slice(0, 10)) {
                    log(`  - unresolved: ${id}`);
                  }
                  if (unresolvedAfterDelete.length > 10) {
                    log(`  … and ${unresolvedAfterDelete.length - 10} more unresolved orphan vectors`);
                  }
                  const failReason =
                    typeof vectorDb.getLastSearchFailReason === "function" ? vectorDb.getLastSearchFailReason() : null;
                  if (failReason) {
                    log(`  → LanceDB degraded hint: lastSearchFailReason=${failReason}`);
                  }
                  state.issues.push(
                    `${unresolvedAfterDelete.length} orphan vector(s) still present after --reconcile --fix delete attempts`,
                  );
                  state.allOk = false;
                }
              }
            } else {
              log("  → Run with --fix to delete these orphan vectors from LanceDB.");
              state.issues.push(`${vectorOrphans.length} orphan vector(s) in LanceDB with no matching SQLite fact`);
            }
          }
          if (sqliteOrphans.length > 0) {
            const WARN = noEmoji ? "[WARN]" : "⚠️";
            log(`${WARN} SQLite orphans (facts in SQLite with no vector): ${sqliteOrphans.length}`);
            sqliteOrphans.slice(0, 10).forEach((id) => {
              log(`  - ${id}`);
            });
            if (sqliteOrphans.length > 10) log(`  … and ${sqliteOrphans.length - 10} more`);
            if (opts.fix && sqliteOrphanRebuildBudget > 0) {
              let rebuilt = 0;
              let failed = 0;
              for (const id of sqliteOrphans.slice(0, sqliteOrphanRebuildBudget)) {
                try {
                  const fact = factsDb.getById(id);
                  if (!fact) {
                    failed++;
                    continue;
                  }
                  const vec = await embeddings.embed(fact.text);
                  await vectorDb.store({
                    id: fact.id,
                    text: fact.text,
                    vector: vec,
                    importance: fact.importance ?? 0.5,
                    category: fact.category,
                  });
                  rebuilt++;
                } catch {
                  failed++;
                }
              }
              log(
                `  → Rebuild policy=${reconcilePolicy}: rebuilt ${rebuilt}/${Math.min(sqliteOrphans.length, sqliteOrphanRebuildBudget)} SQLite orphan vector(s)${failed > 0 ? ` (${failed} failed)` : ""}.`,
              );
              if (sqliteOrphans.length > sqliteOrphanRebuildBudget) {
                log(
                  `  → Skipped ${sqliteOrphans.length - sqliteOrphanRebuildBudget} SQLite orphan(s) due to --reconcile-max-fixes budget.`,
                );
              }
            } else if (opts.fix && sqliteOrphanRebuildBudget === 0) {
              log(
                `  → Policy=${reconcilePolicy}: SQLite-orphan auto-rebuild disabled; use re-index for full recovery.`,
              );
            } else {
              log("  → Re-run the plugin or use the re-index command to rebuild missing vectors.");
            }
            state.issues.push(`${sqliteOrphans.length} SQLite fact(s) without corresponding vectors in LanceDB`);
          }
        }
        if (resolvedSqlitePath) {
          appendVectorLifecycleAuditEvent(resolvedSqlitePath, {
            event: "reconcile_completed",
            ts: nowIso(),
            details: {
              fix: opts.fix,
              reconcilePolicy,
              reconcileMaxFixes,
              vectorOrphans: vectorOrphans.length,
              sqliteOrphans: sqliteOrphans.length,
            },
          });
        }
      } catch (e) {
        log(`${FAIL} Reconciliation: FAIL — ${String(e)}`);
        state.allOk = false;
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:reconcile" });
      }
    }
  }

  // ───── Cron Ledger Reconciliation (explicit --reconcile only; optional --fix to write) ─────
  if (opts.reconcile) {
    log("\n───── Cron Maintenance Ledger Reconciliation ─────");
    try {
      const cronRunsDir = join(openclawDir, "cron", "runs");
      const logDir = join(openclawDir, "logs", "cron-hybrid-mem");

      if (!existsSync(cronRunsDir)) {
        log(`${PAUSE} Cron runs directory not found: ${cronRunsDir}`);
      } else if (!existsSync(logDir)) {
        log(`${PAUSE} Log directory not found: ${logDir}`);
      } else {
        const result = reconcileAllCronRunLedgers(cronRunsDir, logDir, HYBRID_MEM_CRON_DEFAULT_JOB_STEPS, !opts.fix);

        if (result.examined === 0) {
          log(`${PAUSE} No cron runs found to examine`);
        } else if (result.falseOk === 0) {
          log(`${OK} All ${result.examined} examined run(s) correctly recorded`);
        } else {
          log(`${FAIL} Found ${result.falseOk} false-OK run(s) out of ${result.examined} examined`);
          if (opts.fix) {
            log(`  → Corrected ${result.corrected} ledger entr${result.corrected === 1 ? "y" : "ies"}`);
            state.fixes.push(
              `Corrected ${result.corrected} false-OK cron run ledger entr${result.corrected === 1 ? "y" : "ies"}`,
            );
          } else {
            log("  → Run with --fix to correct ledger entries");
            state.issues.push(`${result.falseOk} cron run(s) incorrectly recorded as OK despite validation failures`);
            state.allOk = false;
          }

          if (result.corrections.length > 0 && result.corrections.length <= 5) {
            for (const correction of result.corrections) {
              log(
                `  • ${correction.jobId} @ ${formatTimestampUtcFromMs(correction.timestamp)}: ${correction.validationResult.error || "validation failed"}`,
              );
            }
          } else if (result.corrections.length > 5) {
            log(
              `  • ${result.corrections.length} corrections (run 'openclaw hybrid-mem reconcile-cron-ledgers' for details)`,
            );
          }
        }
      }
    } catch (e) {
      log(`${FAIL} Cron ledger reconciliation check failed: ${e}`);
      state.allOk = false;
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:reconcile-cron-ledgers" });
    }
  }

  if (opts.fix) {
    const applied: string[] = [];
    if (state.lanceBindingsFailed) {
      try {
        const { spawnSync } = await import("node:child_process");
        function npmExecutable(): string {
          if (process.platform !== "win32") return "npm";
          const candidate = join(dirname(process.execPath), "npm.cmd");
          return existsSync(candidate) ? candidate : "npm.cmd";
        }
        const pkgs = state.lanceBindingsFailed ? ["@lancedb/lancedb"] : [];
        for (const pkg of pkgs) {
          const r = spawnSync(npmExecutable(), ["rebuild", pkg], { cwd: extDir, shell: false, stdio: "inherit" });
          if (r.status === 0) {
            applied.push(`Rebuilt native module: ${pkg}`);
          } else {
            log(`Rebuild ${pkg} failed (exit ${r.status}). Run manually: cd ${extDir} && npm rebuild ${pkg}`);
          }
        }
      } catch (e) {
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:rebuild-modules" });
      }
    }

    if (existsSync(defaultConfigPath)) {
      try {
        const raw = readFileSync(defaultConfigPath, "utf-8");
        const fixConfig = JSON.parse(raw) as Record<string, unknown>;
        let changed = false;
        if (!fixConfig.plugins || typeof fixConfig.plugins !== "object") fixConfig.plugins = {};
        const plugins = fixConfig.plugins as Record<string, unknown>;
        if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
        const entries = plugins.entries as Record<string, unknown>;
        if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object")
          entries[PLUGIN_ID] = { enabled: true, config: {} };
        const mh = entries[PLUGIN_ID] as Record<string, unknown>;
        if (!mh.config || typeof mh.config !== "object") mh.config = {};
        const cfgFix = mh.config as Record<string, unknown>;
        if (!cfgFix.embedding || typeof cfgFix.embedding !== "object") cfgFix.embedding = {};
        const emb = cfgFix.embedding as Record<string, unknown>;
        const curKey = emb.apiKey;
        const placeholder =
          typeof curKey !== "string" ||
          curKey.length < 10 ||
          curKey === "YOUR_OPENAI_API_KEY" ||
          curKey === "<OPENAI_API_KEY>";
        if (placeholder) {
          emb.apiKey = "YOUR_OPENAI_API_KEY";
          emb.model = emb.model || "text-embedding-3-small";
          changed = true;
          applied.push("Set embedding.apiKey and model (use your key or ${OPENAI_API_KEY} in config)");
        }
        const memoryDirPath = dirname(resolvedSqlitePath);
        if (!existsSync(memoryDirPath)) {
          mkdirSync(memoryDirPath, { recursive: true });
          applied.push(`Created memory directory: ${memoryDirPath}`);
        }

        // Add cron jobs (same logic as install)
        const cronStorePath = describeCronStoreLocation(openclawDir);

        try {
          const scheduleOverrides: Record<string, string> = {};
          if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
            scheduleOverrides["hybrid-mem:nightly-dream-cycle"] = cfg.nightlyCycle.schedule;
          }
          if (typeof cfg.sensorSweep?.schedule === "string" && cfg.sensorSweep.schedule.trim().length > 0) {
            scheduleOverrides["hybrid-mem:sensor-sweep"] = cfg.sensorSweep.schedule;
          }
          const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, getCronModelConfig(cfg), {
            normalizeExisting: true,
            reEnableDisabled: false,
            consolidatedCronJobs: readConsolidatedCronJobsFlag(cfg),
            scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
            featureGates: buildMaintenanceCronFeatureGates(cfg),
            digestWeeklyDelivery: cfg.digest.weekly.delivery,
          });
          added.forEach((name) => {
            applied.push(`Added ${name} job to ${cronStorePath}`);
          });
          normalized.forEach((name) => {
            applied.push(`Normalized ${name} job (schedule/pluginJobId)`);
          });
          if (cfg.goalStewardship.enabled && cfg.goalStewardship.heartbeatStewardship) {
            const heartbeat = ensureGoalStewardshipHeartbeatCronJob(openclawDir, {
              heartbeatPatterns: cfg.goalStewardship.heartbeatPatterns,
            });
            if (heartbeat.added) {
              applied.push(`Added goal-stewardship-heartbeat job to ${cronStorePath}`);
            }
            if (heartbeat.normalized) {
              applied.push("Normalized goal-stewardship-heartbeat job (schedule/sessionTarget/delivery/payload)");
            }
            if (heartbeat.skippedReason) {
              const WARN = noEmoji ? "[WARN]" : "⚠️";
              log(`${WARN} Goal stewardship heartbeat installer skipped: ${heartbeat.skippedReason}`);
            }
          }
        } catch (e) {
          log(`Could not add optional jobs to cron store: ${String(e)}`);
          capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:add-cron-jobs" });
        }

        if (changed) {
          writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
        }
        if (applied.length > 0) {
          log("\n--- Applied fixes ---");
          applied.forEach((a) => {
            log(`  • ${a}`);
          });
          if (changed) log(`Config written: ${defaultConfigPath}. Restart the gateway and run verify again.`);
        }
      } catch (e) {
        const _err = state.sink.error ?? ((s: string) => console.error(s));
        _err(`\nCould not apply fixes to config: ${String(e)}`);
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:apply-fixes" });
        const snippet = {
          embedding: { apiKey: "<set your key or use ${OPENAI_API_KEY}>", model: "text-embedding-3-small" },
          autoCapture: true,
          autoRecall: true,
          captureMaxChars: 5000,
          store: { fuzzyDedupe: false },
        };
        _err(`Minimal config snippet to merge into plugins.entries["${PLUGIN_ID}"].config:`);
        _err(JSON.stringify(snippet, null, 2));
      }
    } else {
      log("\n--- Fix (--fix) ---");
      log(
        "Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.",
      );
    }
  }

  if (opts.reconcile) {
    log("\n───── Vector / SQLite consistency (reconcile) ─────");
    try {
      await vectorDb.ensureInitialized();
      const vCount = await vectorDb.count();
      const embCount = factsDb.countCanonicalEmbeddings();
      log(`${OK} SQLite canonical embeddings (fact_embeddings): ${embCount}`);
      const lanceRowsOk = vectorDb.isLanceAvailable();
      log(`${lanceRowsOk ? OK : PAUSE} LanceDB row count: ${vCount} (lanceAvailable=${lanceRowsOk})`);
      if (lanceRowsOk && vCount !== embCount) {
        log(
          `${FAIL} Drift: fact_embeddings rows (${embCount}) != Lance rows (${vCount}). Consider re-embed or diagnostics.`,
        );
      }
    } catch (e) {
      log(`${FAIL} Reconcile check failed: ${e}`);
    }
  }
}
