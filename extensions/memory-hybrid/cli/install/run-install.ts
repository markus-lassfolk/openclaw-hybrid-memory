/**
 * CLI Install/Uninstall/Upgrade Command Handlers
 *
 * Contains all install-related functions extracted from handlers.ts:
 * - buildPreFilterConfig
 * - Cron constants and helpers (PLUGIN_JOB_ID_PREFIX, MIN_INTERVAL_MS,
 *   MAINTENANCE_CRON_JOBS, LEGACY_JOB_MATCHERS, resolveCronJob,
 *   ensureMaintenanceCronJobs, createProgressReporter)
 * - deepMerge
 * - runResetAuthBackoffForCli
 * - runInstallForCli
 * - runUninstallForCli
 * - runUpgradeForCli
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, relative } from "node:path";

import { getEnv } from "../utils/env-manager.js";
import { expandTilde } from "../utils/path.js";
import { findPluginRoot } from "../utils/plugin-root.js";

import type { DigestWeeklyDeliveryConfig, HybridMemoryConfig } from "../config.js";
import { type CronModelConfig, getCronModelConfig, getDefaultCronModel } from "../config.js";
import { parseDigestWeeklyDeliveryOnly } from "../config/parsers/features.js";
import { buildGuardPrefix } from "../services/cron-guard.js";
import {
  HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
  buildHybridMemCronTaskMessage,
  hybridMemCronEnvSanitizerBashLines,
} from "../services/cron-job-bash-harness.js";
import { findDeprecatedHybridMemCronTokens } from "../services/deprecated-cron-commands.js";
import { capturePluginError } from "../services/error-reporter.js";
import { compileHeartbeatMatchers } from "../services/goal-stewardship-heartbeat.js";
import { type PreFilterConfig, preFilterSessions } from "../services/session-pre-filter.js";
import { ensureWorkspaceBootstrap } from "../setup/workspace-bootstrap.js";
import { resetAllBackoff } from "../utils/auth-failover.js";
import { DEFAULT_COMPACTION_MODEL } from "../utils/compaction-model-watchdog.js";
import { PLUGIN_ID } from "../utils/constants.js";
import {
  extractCronStoreJobModel,
  readAgentsPrimaryModelFromOpenclawJsonPath,
  setCronStoreJobModelFields,
} from "../utils/openclaw-agent-defaults.js";
import type { HandlerContext } from "./handlers.js";
import type { InstallCliResult, UninstallCliResult, UpgradeCliResult } from "./types.js";

export function runInstallForCli(opts: { dryRun: boolean }): InstallCliResult {
  const openclawDir = join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  const fullDefaults = buildInstallDefaults();
  const pluginRootDir = findPluginRoot(import.meta.url);

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runInstallForCli:read-config" });
      return { ok: false, error: `Could not read ${configPath}: ${e}` };
    }
  }
  const existingEmbedding = inspectExistingEmbeddingSetup(config);
  const detectedEmbedding = detectRecommendedEmbeddingSetup(config, pluginRootDir);
  const existingApiKey =
    (config?.plugins as Record<string, unknown>)?.entries &&
    ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] &&
    (
      ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
        string,
        unknown
      >
    )?.config &&
    (
      (
        ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
          string,
          unknown
        >
      ).config as Record<string, unknown>
    )?.embedding &&
    (
      (
        (
          ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<
            string,
            unknown
          >
        ).config as Record<string, unknown>
      ).embedding as Record<string, unknown>
    )?.apiKey;
  const isRealKey =
    typeof existingApiKey === "string" &&
    existingApiKey.length >= 10 &&
    existingApiKey !== "YOUR_OPENAI_API_KEY" &&
    existingApiKey !== "<OPENAI_API_KEY>";

  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  if (!(config.agents && typeof config.agents === "object")) config.agents = { defaults: {} };
  deepMerge(config, fullDefaults as unknown as Record<string, unknown>);
  if (isRealKey) {
    const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const mh = entries[PLUGIN_ID] as Record<string, unknown>;
    const cfg = mh?.config as Record<string, unknown>;
    const emb = cfg?.embedding as Record<string, unknown>;
    if (emb) emb.apiKey = existingApiKey;
  }
  const embeddingPatch = applyDetectedEmbeddingSetup(config, detectedEmbedding, existingEmbedding);
  const after = JSON.stringify(config, null, 2);
  const workspaceRoot = resolveAgentWorkspaceRoot(config);
  const dashboardUrl = getDashboardUrl(config);

  if (opts.dryRun) {
    const skillPreview = installHybridMemoryWorkspaceSkill({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: true,
    });
    const toolsPreview = applyHybridMemoryToolsMd({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: true,
    });
    let bootstrapPreview = { workspaceRoot, directories: [], files: [] } as ReturnType<typeof ensureWorkspaceBootstrap>;
    let bootstrapPreviewError: string | undefined;
    try {
      bootstrapPreview = ensureWorkspaceBootstrap({ workspaceRoot, dryRun: true });
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:workspace-bootstrap:dry-run" });
      bootstrapPreview = { workspaceRoot, directories: [], files: [] };
      bootstrapPreviewError = String(err);
    }
    const previewDone: string[] = [
      "Would write or repair the hybrid-memory plugin config block.",
      "Would refresh the workspace skill.",
      "Would refresh the managed TOOLS.md section.",
      `Would ensure workspace starter layout under ${workspaceRoot}.`,
      `Would point you to Mission Control at ${dashboardUrl}.`,
    ];
    if (embeddingPatch.changed) {
      previewDone.push(
        `Would prefill embedding defaults with ${detectedEmbedding.provider}/${detectedEmbedding.model} (${detectedEmbedding.source}).`,
      );
    }
    if (bootstrapPreviewError) {
      previewDone.push(`Workspace bootstrap check would warn: ${bootstrapPreviewError}`);
    }
    const previewRemaining: string[] = [];
    if (detectedEmbedding.provider === "openai" && !detectedEmbedding.envKey && !existingEmbedding.hasUsableApiKey) {
      previewRemaining.push("Add an OpenAI-compatible embedding API key, then restart the gateway.");
    } else if (detectedEmbedding.provider === "google" && !existingEmbedding.hasUsableApiKey) {
      previewRemaining.push(
        "Add llm.providers.google.apiKey (or export GOOGLE_API_KEY / GEMINI_API_KEY), then restart.",
      );
    } else if (detectedEmbedding.provider === "ollama") {
      previewRemaining.push("Make sure Ollama is running locally before verify.");
    }
    previewRemaining.push("Restart the gateway after applying the config.");
    previewRemaining.push("Run `openclaw hybrid-mem verify` to confirm the install.");
    return {
      ok: true,
      configPath,
      dryRun: true,
      written: false,
      configJson: after,
      pluginId: PLUGIN_ID,
      workspaceSkillPath: skillPreview.path,
      workspaceSkillError: skillPreview.error,
      workspaceToolsMdPath: toolsPreview.path,
      workspaceToolsMdError: toolsPreview.error,
      workspaceToolsMdUpdated: toolsPreview.updated,
      workspaceRoot,
      dashboardUrl,
      detectedEmbedding,
      bootstrapDirectoriesCreated: bootstrapPreview.directories.filter((entry) => entry.created).length,
      bootstrapFilesCreated: bootstrapPreview.files.filter((entry) => entry.created).length,
      completed: previewDone,
      remaining: previewRemaining,
    };
  }

  try {
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(join(openclawDir, "memory"), { recursive: true });
    writeFileSync(configPath, after, "utf-8");
    const skillInstall = installHybridMemoryWorkspaceSkill({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: false,
    });
    const toolsMdInstall = applyHybridMemoryToolsMd({
      mergedOpenclawConfig: config,
      pluginRootDir,
      dryRun: false,
    });
    let bootstrapInstall = { workspaceRoot, directories: [], files: [] } as ReturnType<typeof ensureWorkspaceBootstrap>;
    let bootstrapInstallError: string | undefined;
    try {
      bootstrapInstall = ensureWorkspaceBootstrap({ workspaceRoot, dryRun: false });
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:workspace-bootstrap" });
      bootstrapInstallError = String(err);
      // non-fatal: workspace bootstrap should not fail a successful config install
    }
    let cronSummary: { added: string[]; normalized: string[] } | undefined;
    try {
      const pluginCfg = getPluginEntryConfig(config);
      const pluginConfig = pluginCfg as CronModelConfig | undefined;
      const dreamCycleRaw = pluginCfg?.nightlyCycle as Record<string, unknown> | undefined;
      const dreamCycleSchedule =
        typeof dreamCycleRaw?.schedule === "string" && (dreamCycleRaw.schedule as string).trim().length > 0
          ? (dreamCycleRaw.schedule as string).trim()
          : undefined;
      const sensorSweepRaw = pluginCfg?.sensorSweep as Record<string, unknown> | undefined;
      const sensorSweepSchedule =
        typeof sensorSweepRaw?.schedule === "string" && (sensorSweepRaw.schedule as string).trim().length > 0
          ? (sensorSweepRaw.schedule as string).trim()
          : undefined;
      const installScheduleOverrides: Record<string, string> = {};
      if (dreamCycleSchedule)
        installScheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`] = dreamCycleSchedule;
      if (sensorSweepSchedule) installScheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}sensor-sweep`] = sensorSweepSchedule;
      cronSummary = ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
        normalizeExisting: false,
        reEnableDisabled: false,
        scheduleOverrides: Object.keys(installScheduleOverrides).length > 0 ? installScheduleOverrides : undefined,
        featureGates: {
          "sensorSweep.enabled": (sensorSweepRaw?.enabled as boolean | undefined) === true,
          "nightlyCycle.enabled": (dreamCycleRaw?.enabled as boolean | undefined) === true,
        },
        digestWeeklyDelivery: parseDigestWeeklyDeliveryOnly(getPluginEntryConfig(config) ?? {}),
      });
    } catch (err) {
      capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:cron-setup" });
      // non-fatal: cron jobs optional on install
    }
    const completed: string[] = [
      `Wrote hybrid-memory config to ${configPath}.`,
      `Installed workspace skill at ${skillInstall.path}${skillInstall.error ? ` (warning: ${skillInstall.error})` : ""}.`,
      `Checked TOOLS.md managed block at ${toolsMdInstall.path}${toolsMdInstall.updated ? " (updated)" : " (already current)"}.`,
      bootstrapInstallError
        ? `Workspace starter layout warning in ${workspaceRoot}: ${bootstrapInstallError}.`
        : `Ensured workspace starter layout in ${workspaceRoot} (${bootstrapInstall.directories.filter((entry) => entry.created).length} dirs, ${bootstrapInstall.files.filter((entry) => entry.created).length} files created).`,
      `Dashboard home: ${dashboardUrl}`,
    ];
    if (embeddingPatch.changed) {
      completed.push(
        `Prefilled embedding defaults with ${detectedEmbedding.provider}/${detectedEmbedding.model} (${detectedEmbedding.source}).`,
      );
    } else {
      completed.push(`Kept existing embedding setup (${detectedEmbedding.provider}/${detectedEmbedding.model}).`);
    }
    if (cronSummary) {
      completed.push(
        cronSummary.added.length > 0
          ? `Ensured maintenance cron jobs (${cronSummary.added.length} added).`
          : "Checked maintenance cron jobs.",
      );
    }
    for (const note of embeddingPatch.notes) completed.push(note);
    const remaining: string[] = [];
    if (detectedEmbedding.provider === "openai" && !existingEmbedding.hasUsableApiKey && !detectedEmbedding.envKey) {
      remaining.push('Set plugins.entries["openclaw-hybrid-memory"].config.embedding.apiKey to a real key.');
    }
    if (detectedEmbedding.provider === "google" && !existingEmbedding.hasUsableApiKey) {
      remaining.push("Set llm.providers.google.apiKey (or export GOOGLE_API_KEY / GEMINI_API_KEY).");
    }
    if (detectedEmbedding.provider === "ollama") {
      remaining.push("Keep Ollama running locally before using semantic recall.");
    }
    remaining.push("Restart the gateway so the new config and workspace files are picked up.");
    remaining.push("Run `openclaw hybrid-mem verify` for the beginner-friendly health check.");
    return {
      ok: true,
      configPath,
      dryRun: false,
      written: true,
      pluginId: PLUGIN_ID,
      workspaceSkillPath: skillInstall.path,
      workspaceSkillError: skillInstall.error,
      workspaceToolsMdPath: toolsMdInstall.path,
      workspaceToolsMdError: toolsMdInstall.error,
      workspaceToolsMdUpdated: toolsMdInstall.updated,
      workspaceRoot,
      dashboardUrl,
      detectedEmbedding,
      bootstrapDirectoriesCreated: bootstrapInstall.directories.filter((entry) => entry.created).length,
      bootstrapFilesCreated: bootstrapInstall.files.filter((entry) => entry.created).length,
      completed,
      remaining,
    };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runInstallForCli:write-config" });
    return { ok: false, error: `Could not write config: ${err}` };
  }
}

export function runUninstallForCli(
  ctx: HandlerContext,
  opts: { cleanAll: boolean; leaveConfig: boolean },
): UninstallCliResult {
  const { resolvedSqlitePath, resolvedLancePath } = ctx;
  const openclawDir = join(homedir(), ".openclaw");
  const openclawMemoryDir = join(openclawDir, "memory");
  const dangerousUninstallEnabled = getEnv("OPENCLAW_HYBRID_MEM_UNINSTALL_DANGEROUS") === "1";
  const configPath = join(openclawDir, "openclaw.json");
  const cleaned: string[] = [];
  let outcome: UninstallCliResult["outcome"];
  let error = "";

  if (!opts.leaveConfig && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
      const plugins = config.plugins as Record<string, unknown>;
      if (!plugins.slots || typeof plugins.slots !== "object") plugins.slots = {};
      (plugins.slots as Record<string, string>).memory = "memory-core";
      if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
      const entries = plugins.entries as Record<string, unknown>;
      if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = {};
      (entries[PLUGIN_ID] as Record<string, boolean>).enabled = false;
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      outcome = "config_updated";
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runUninstallForCli:update-config" });
      outcome = "config_error";
      error = String(e);
    }
  } else if (!opts.leaveConfig) {
    outcome = "config_not_found";
  } else {
    outcome = "leave_config";
  }

  if (opts.cleanAll) {
    if (
      existsSync(resolvedSqlitePath) &&
      (dangerousUninstallEnabled || isPathInsideDir(openclawMemoryDir, resolvedSqlitePath))
    ) {
      try {
        rmSync(resolvedSqlitePath, { force: true });
        cleaned.push(resolvedSqlitePath);
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runUninstallForCli:remove-sqlite" });
      }
    }
    if (
      existsSync(resolvedLancePath) &&
      (dangerousUninstallEnabled || isPathInsideDir(openclawMemoryDir, resolvedLancePath))
    ) {
      try {
        rmSync(resolvedLancePath, { recursive: true, force: true });
        cleaned.push(resolvedLancePath);
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runUninstallForCli:remove-lance" });
      }
    }
  }

  const base = { pluginId: PLUGIN_ID, cleaned };
  if (outcome === "config_error") return { ...base, outcome, error };
  return { ...base, outcome } as UninstallCliResult;
}

export async function runUpgradeForCli(ctx: HandlerContext, requestedVersion?: string): Promise<UpgradeCliResult> {
  const { cfg, logger } = ctx;
  const extDir = findPluginRoot(import.meta.url);
  const { spawnSync } = await import("node:child_process");
  const version = requestedVersion?.trim() || "latest";
  try {
    assertSafeRequestedVersionArg(version);
  } catch (e) {
    return { ok: false, error: `Invalid requested version: ${e instanceof Error ? e.message : String(e)}` };
  }

  const manifestPath = join(extDir, "openclaw.plugin.json");
  const pkgPath = join(extDir, "package.json");
  if (!existsSync(manifestPath) || !existsSync(pkgPath)) {
    return { ok: false, error: `Refusing to upgrade: plugin directory does not look valid: ${extDir}` };
  }

  const backupDir = join(dirname(extDir), `${basename(extDir)}.bak-${Date.now()}`);
  try {
    renameSync(extDir, backupDir);
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runUpgradeForCli:move-dir" });
    return {
      ok: false,
      error: `Could not move plugin directory for upgrade: ${e}. Use standalone installer: npx -y openclaw-hybrid-memory-install ${version}`,
    };
  }
  // Use standalone installer so upgrade works even when config is invalid (plugin missing).
  const npxArgs = ["-y", "openclaw-hybrid-memory-install", version];
  const r = spawnSync(npxExecutable(), npxArgs, {
    stdio: "inherit",
    cwd: homedir(),
    shell: false,
  });
  if (r.status !== 0) {
    // Best-effort rollback: restore original plugin directory.
    try {
      if (existsSync(extDir)) {
        // Installer might have created a partial directory; avoid clobbering it.
        const failedDir = join(dirname(extDir), `${basename(extDir)}.failed-${Date.now()}`);
        try {
          renameSync(extDir, failedDir);
        } catch {
          rmSync(extDir, { recursive: true, force: true });
        }
      }
      renameSync(backupDir, extDir);
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runUpgradeForCli:rollback" });
      return {
        ok: false,
        error: `Install failed (exit ${r.status}). Rollback also failed: ${e}. Run manually: npx -y openclaw-hybrid-memory-install ${version}`,
      };
    }
    return {
      ok: false,
      error: `Install failed (exit ${r.status}). Run manually: npx -y openclaw-hybrid-memory-install ${version}`,
    };
  }
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch (e) {
    // Non-fatal; backup cleanup failure shouldn't block upgrade.
    capturePluginError(e as Error, { subsystem: "cli", operation: "runUpgradeForCli:cleanup-backup" });
  }
  let installedVersion = version;
  try {
    const pkgAfterPath = join(extDir, "package.json");
    if (existsSync(pkgAfterPath)) {
      const pkg = JSON.parse(readFileSync(pkgAfterPath, "utf-8")) as { version?: string };
      installedVersion = pkg.version ?? installedVersion;
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:read-version" });
  }
  // Ensure maintenance cron jobs exist (add missing, normalize existing; never re-enable disabled)
  try {
    const openclawDir = join(homedir(), ".openclaw");
    const pluginConfig = getCronModelConfig(cfg);
    const scheduleOverrides: Record<string, string> = {};
    if (typeof cfg.nightlyCycle?.schedule === "string" && cfg.nightlyCycle.schedule.trim().length > 0) {
      scheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}nightly-dream-cycle`] = cfg.nightlyCycle.schedule;
    }
    if (typeof cfg.sensorSweep?.schedule === "string" && cfg.sensorSweep.schedule.trim().length > 0) {
      scheduleOverrides[`${PLUGIN_JOB_ID_PREFIX}sensor-sweep`] = cfg.sensorSweep.schedule;
    }
    const { added, normalized } = ensureMaintenanceCronJobs(openclawDir, pluginConfig, {
      normalizeExisting: true,
      reEnableDisabled: false,
      scheduleOverrides: Object.keys(scheduleOverrides).length > 0 ? scheduleOverrides : undefined,
      featureGates: {
        "sensorSweep.enabled": cfg.sensorSweep?.enabled === true,
        "nightlyCycle.enabled": cfg.nightlyCycle?.enabled === true,
      },
      digestWeeklyDelivery: cfg.digest.weekly.delivery,
    });
    if (added.length > 0 || normalized.length > 0) {
      logger?.info?.(
        `memory-hybrid: upgrade — cron jobs: ${added.length} added, ${normalized.length} normalized (disabled jobs left as-is). Run openclaw hybrid-mem verify to confirm.`,
      );
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:ensure-cron-jobs" });
    // non-fatal: user can run verify --fix later
  }
  let mergedConfig: Record<string, unknown> = {};
  try {
    const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(cfgPath)) {
      mergedConfig = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    }
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runUpgradeForCli:read-config-for-skill" });
  }
  const skillAfterUpgrade = installHybridMemoryWorkspaceSkill({
    mergedOpenclawConfig: mergedConfig,
    pluginRootDir: extDir,
    dryRun: false,
  });
  if (skillAfterUpgrade.error) {
    logger?.warn?.(`memory-hybrid: could not refresh workspace skill: ${skillAfterUpgrade.error}`);
  } else {
    logger?.info?.(`memory-hybrid: workspace skill updated at ${skillAfterUpgrade.path}`);
  }
  const toolsAfterUpgrade = applyHybridMemoryToolsMd({
    mergedOpenclawConfig: mergedConfig,
    pluginRootDir: extDir,
    dryRun: false,
  });
  if (toolsAfterUpgrade.error) {
    logger?.warn?.(`memory-hybrid: could not refresh TOOLS.md block: ${toolsAfterUpgrade.error}`);
  } else if (toolsAfterUpgrade.updated) {
    logger?.info?.(`memory-hybrid: TOOLS.md hybrid block updated at ${toolsAfterUpgrade.path}`);
  }
  return {
    ok: true,
    version: installedVersion,
    pluginDir: extDir,
    workspaceSkillPath: skillAfterUpgrade.path,
    workspaceSkillError: skillAfterUpgrade.error,
    workspaceToolsMdPath: toolsAfterUpgrade.path,
    workspaceToolsMdError: toolsAfterUpgrade.error,
    workspaceToolsMdUpdated: toolsAfterUpgrade.updated,
  };
}
