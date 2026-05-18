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
export * from "./install/workspace.js";
export * from "./install/cron-jobs.js";
export * from "./install/config-merge.js";
export * from "./install/embedding-detect.js";
export * from "./install/run-install.js";
