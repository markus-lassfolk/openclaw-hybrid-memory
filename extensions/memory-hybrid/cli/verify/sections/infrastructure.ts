/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectDualPluginInstallVersionMismatch,
  resolveKnownNpmProjectPluginDir,
  resolveNpmProjectPluginDirFromLayout,
} from "../../install/workspace.js";
import {
  detectStaleLegacyInstallIndexEntry,
  formatStaleInstallIndexWarning,
  reconcileLegacyInstallIndex,
} from "../../install/install-index-reconcile.js";
import { capturePluginError, isErrorReporterActive, resolvePendingErrorReportCount } from "../../../services/error-reporter.js";
import { listQuarantinedGoalIds, resolveGoalsDir, auditGoalIndexDrift, rebuildGoalIndex } from "../../../services/goal-registry.js";
import { PLUGIN_ID } from "../../../utils/constants.js";
import { workspaceRootForCli } from "../../config-feature-summaries.js";
import {
  getEventLoopLagSnapshot,
  resolveEventLoopDegradedThresholdMs,
  sampleSchedulerDelayMs,
  startEventLoopLagMonitor,
} from "../../../utils/event-loop-health.js";

import type { VerifyRunState } from "../verify-run-state.js";
import { getCachedFactCount } from "../fact-count.js";

export async function runVerifyInfrastructureSection(state: VerifyRunState): Promise<void> {
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

  log("\n───── Infrastructure ─────");

  const extensionsPluginDir = join(openclawDir, "extensions", PLUGIN_ID);
  const npmProjectPluginDir =
    resolveNpmProjectPluginDirFromLayout(extDir) ?? resolveKnownNpmProjectPluginDir();
  if (npmProjectPluginDir) {
    const dualInstall = detectDualPluginInstallVersionMismatch(npmProjectPluginDir, extensionsPluginDir);
    if (dualInstall) {
      warnings.push(dualInstall);
      log(`${WARN_LINE} Plugin install layout: ${dualInstall}`);
    }
  }

  // Issue #2008: detect stale legacy install-index entries that cause
  // OpenClaw core to keep emitting "Left plugin install index in place
  // because shared SQLite state has conflicting plugin install metadata".
  // We compare the legacy `${stateDir}/plugins/installs.json` record against
  // the live plugin path/version we are actually running from.
  const installIndexDetection = detectStaleLegacyInstallIndexEntry({
    pluginId: PLUGIN_ID,
    livePath: extDir,
  });
  if (
    installIndexDetection.present &&
    installIndexDetection.verdict !== "no-conflict" &&
    installIndexDetection.verdict !== "matches-live"
  ) {
    if (installIndexDetection.verdict === "safe-reconcile" && opts.fix) {
      const result = reconcileLegacyInstallIndex({ detection: installIndexDetection });
      if (result.ok && result.action !== "noop") {
        warnings.push(
          `Reconciled stale install-index entry for ${PLUGIN_ID} (${result.action}; backup at ${result.backupPath ?? "<unknown>"}).`,
        );
        log(
          `${OK} Install index: dropped stale ${PLUGIN_ID} entry pointing at ${installIndexDetection.staleInstallPath ?? "<unknown>"} (${installIndexDetection.staleVersion ?? "<unknown>"}) — live is ${installIndexDetection.livePath} (${installIndexDetection.liveVersion ?? "<unknown>"}). Backup: ${result.backupPath ?? "<unknown>"}.`,
        );
      } else {
        const detail = result.error ?? formatStaleInstallIndexWarning(installIndexDetection);
        warnings.push(detail);
        log(`${WARN_LINE} Install index: ${detail}`);
      }
    } else {
      const detail = formatStaleInstallIndexWarning(installIndexDetection);
      warnings.push(detail);
      log(`${WARN_LINE} Install index: ${detail}`);
      if (installIndexDetection.verdict === "safe-reconcile") {
        log(`  → Run \`openclaw hybrid-mem verify --fix\` to drop the stale entry.`);
        fixes.push(
          `Run \`openclaw hybrid-mem verify --fix\` (or \`openclaw hybrid-mem install-index reconcile\`) to reconcile the stale ${PLUGIN_ID} entry in ${installIndexDetection.legacyPath}.`,
        );
      }
    }
  }

  if (cfg.errorReporting?.enabled !== false && cfg.errorReporting?.consent !== false) {
    const pendingReports = resolvePendingErrorReportCount(resolvedSqlitePath);
    if (isErrorReporterActive() || pendingReports > 0) {
      if (pendingReports > 0) {
        warnings.push(`Error reporter has ${pendingReports} pending telemetry report(s)`);
        log(`${WARN_LINE} Error reporter: ${pendingReports} pending report(s) in queue (retries on startup/shutdown flush)`);
      } else {
        log(`${OK} Error reporter: pending queue empty`);
      }
    } else if (cfg.errorReporting?.enabled === true) {
      log(`${WARN_LINE} Error reporter: not active (check consent and DSN)`);
    }
  }

  startEventLoopLagMonitor();
  const lagBeforeGoals = getEventLoopLagSnapshot();
  if (cfg.goalStewardship?.enabled) {
    const goalsDir = resolveGoalsDir(workspaceRootForCli(), cfg.goalStewardship.goalsDir);
    const quarantined = listQuarantinedGoalIds(goalsDir);
    if (quarantined.length > 0) {
      const preview = quarantined.slice(0, 5).join(", ");
      const suffix = quarantined.length > 5 ? ` (+${quarantined.length - 5} more)` : "";
      warnings.push(`Goal registry has ${quarantined.length} quarantined corrupt goal file(s)`);
      log(
        `${WARN_LINE} Goals: ${quarantined.length} quarantined corrupt file(s) (${preview}${suffix}). Restore from state/goals/*.json.corrupt or delete after backup.`,
      );
    }
    const drift = await auditGoalIndexDrift(goalsDir);
    const driftCount =
      drift.missingInIndex.length + drift.orphanInIndex.length + drift.staleFields.length;
    if (driftCount > 0) {
      const parts: string[] = [];
      if (drift.missingInIndex.length > 0) {
        parts.push(`missing in index: ${drift.missingInIndex.slice(0, 5).join(", ")}`);
      }
      if (drift.orphanInIndex.length > 0) {
        parts.push(`orphan in index: ${drift.orphanInIndex.slice(0, 5).join(", ")}`);
      }
      if (drift.staleFields.length > 0) {
        parts.push(`${drift.staleFields.length} stale field(s)`);
      }
      warnings.push(`Goal index drift detected (${parts.join("; ")})`);
      log(`${WARN_LINE} Goals: index drift — ${parts.join("; ")}. Run \`openclaw hybrid-mem verify --fix\` to rebuild _index.json.`);
      if (opts.fix) {
        await rebuildGoalIndex(goalsDir);
        log(`  → Rebuilt goals/_index.json`);
        const driftIdx = warnings.findIndex((w) => w.startsWith("Goal index drift detected"));
        if (driftIdx >= 0) warnings.splice(driftIdx, 1);
      }
    }
  }

  const lagAfterGoals = getEventLoopLagSnapshot();
  const schedulerDelayMs = await sampleSchedulerDelayMs();
  const thresholdMs = resolveEventLoopDegradedThresholdMs();
  const lagMaxMs = lagAfterGoals.maxMs ?? lagBeforeGoals.maxMs;
  if (lagAfterGoals.health === "degraded" || (lagMaxMs !== null && lagMaxMs > thresholdMs)) {
    const detail =
      lagMaxMs !== null
        ? `max lag ${lagMaxMs.toFixed(1)}ms (threshold ${thresholdMs}ms, scheduler sample ${schedulerDelayMs.toFixed(1)}ms)`
        : `scheduler delay ${schedulerDelayMs.toFixed(1)}ms`;
    warnings.push(`Event loop lag elevated: ${detail}`);
    log(
      `${WARN_LINE} Event loop: degraded — ${detail}. Yield points in goal registry and recall reduce gateway health RPC starvation (#931).`,
    );
  } else {
    const healthyDetail =
      lagMaxMs !== null
        ? `max lag ${lagMaxMs.toFixed(1)}ms (threshold ${thresholdMs}ms)`
        : `scheduler sample ${schedulerDelayMs.toFixed(1)}ms`;
    log(`${OK} Event loop: healthy (${healthyDetail})`);
  }

  if (
    cfg.embedding.provider === "openai" &&
    (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10)
  ) {
    state.issues.push("embedding.apiKey is missing, placeholder, or too short");
    state.loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
    state.fixes.push(
      `LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ${defaultConfigPath} or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`,
    );
    state.configOk = false;
  }
  if (!cfg.embedding.model) {
    state.issues.push("embedding.model is missing");
    state.loadBlocking.push("embedding.model is missing");
    state.fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
    state.configOk = false;
  }
  if (state.configOk) {
    const msg =
      cfg.embedding.provider === "openai"
        ? "Config: embedding.apiKey and model present"
        : "Config: embedding.model present";
    log(`${OK} ${msg}`);
  } else {
    log(`${FAIL} Config: issues found`);
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    if (state.loadBlocking.some((s) => s.includes("embedding"))) {
      log(
        `${WARN} Embedding: missing or invalid — retrieval and indexing will not work. Set embedding.apiKey and embedding.model in plugin config.`,
      );
      log(
        `  Suggested first setup: openclaw hybrid-mem install (recommended embedding: ${recommendedEmbedding.provider}/${recommendedEmbedding.model} from ${recommendedEmbedding.source}).`,
      );
    }
  }

  // Check for unsupported agents.defaults.pruning config (#105)
  if (openclawConfigRead.root) {
    const agentsDefaults = (openclawConfigRead.root.agents as Record<string, unknown>)?.defaults as
      | Record<string, unknown>
      | undefined;
    if (agentsDefaults != null && "pruning" in agentsDefaults) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      log(`${WARN} Config: agents.defaults.pruning is set but not supported by OpenClaw core — it has no effect`);
      log(
        `  Fix: Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).`,
      );
      state.issues.push("agents.defaults.pruning is set but unsupported (has no effect)");
      state.fixes.push(
        'Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).',
      );
      if (opts.fix) {
        agentsDefaults.pruning = undefined;
        writeFileSync(defaultConfigPath, JSON.stringify(openclawConfigRead.root, null, 2), "utf-8");
        log(`  → Removed agents.defaults.pruning from ${defaultConfigPath}`);
        state.fixes.pop();
        issues.pop();
      }
    }
  }

  const isBindingsError = (msg: string) =>
    /bindings|better_sqlite3\.node|compiled against|ABI|NODE_MODULE_VERSION|@lancedb\/lancedb|Cannot find module/.test(
      msg,
    );
  let _sqliteBindingsFailed = false;
  state.lanceBindingsFailed = false;

  try {
    const n = getCachedFactCount(factsDb, resolvedSqlitePath);
    state.sqliteOk = true;
    log(`${OK} SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
  } catch (e) {
    const msg = String(e);
    state.issues.push(`SQLite: ${msg}`);
    if (isBindingsError(msg)) {
      _sqliteBindingsFailed = true;
      state.fixes.push("node:sqlite is not available. Upgrade Node.js to >=22.16.0 or use a compatible version.");
    } else {
      state.fixes.push(
        `SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`,
      );
    }
    log(`${FAIL} SQLite: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:sqlite-check" });
  }

  try {
    const n = await vectorDb.count();
    state.lanceOk = true;
    log(`${OK} LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
    const degradedState =
      typeof (vectorDb as { getDegradedState?: unknown }).getDegradedState === "function"
        ? (
            vectorDb as {
              getDegradedState: () => { active: boolean; reason: string | null; sinceEpochMs: number | null };
            }
          ).getDegradedState()
        : { active: false, reason: null as string | null, sinceEpochMs: null as number | null };
    if (degradedState.active) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      log(
        `${WARN} LanceDB degraded mode is active${degradedState.reason ? ` (reason=${degradedState.reason})` : ""}. Use 'openclaw hybrid-mem repair-vectors' after connectivity/config fixes.`,
      );
      state.warnings.push(
        `LanceDB degraded mode active${degradedState.reason ? ` (${degradedState.reason})` : ""}; vector retrieval may be unavailable`,
      );
    }
  } catch (e) {
    const msg = String(e);
    state.issues.push(`LanceDB: ${msg}`);
    if (isBindingsError(msg)) {
      state.lanceBindingsFailed = true;
      state.fixes.push(
        `Native module (@lancedb/lancedb) needs rebuild. Run: cd ${extDir} && npm rebuild @lancedb/lancedb`,
      );
    } else if (msg.includes("VectorDB not initialized") || msg.includes("close() was called")) {
      state.fixes.push(
        "LanceDB connection was not ready (often transient after plugin load or reload). Re-run verify; the plugin will reconnect automatically. Not caused by reindexing.",
      );
    } else {
      state.fixes.push(
        `LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`,
      );
    }
    log(`${FAIL} LanceDB: FAIL — ${msg}`);
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:lancedb-check" });
  }
}
