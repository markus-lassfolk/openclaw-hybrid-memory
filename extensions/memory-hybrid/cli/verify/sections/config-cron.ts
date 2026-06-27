/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CredentialType, HybridMemoryConfig } from "../../../config.js";
import { readGuardTimestampMs } from "../../../services/cron-guard.js";
import { listMaintenanceSteps } from "../../../services/maintenance-orchestrator.js";
import {
  HYBRID_MEM_CRON_ENV_SANITIZER_MARKER,
  maintenanceCronExpectsSummaryArtifact,
} from "../../../services/cron-job-bash-harness.js";
import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
  findDeprecatedTokensInWrapperScripts,
} from "../../../services/deprecated-cron-commands.js";
import { resolveMaintenanceSummaryPath } from "../../../services/maintenance-artifact-paths.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { describeCronStoreLocation, readOpenClawCronStore } from "../../../services/openclaw-cron-store.js";
import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  getHeartbeatMatchersForVerify,
} from "../../../services/goal-stewardship-verify-cron.js";
import { PLUGIN_ID, getRestartPendingPath } from "../../../utils/constants.js";
import { formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { inferModelProviderPrefix } from "../../../utils/model-provider-family.js";
import {
  extractCronStoreJobModel,
  readEffectiveAgentChatPrimaryFromOpenclawJsonRoot,
} from "../../../utils/openclaw-agent-defaults.js";
import {
  getConsolidatedSupersededLegacyCronJobKeys,
  getMaintenanceCronJobKeys,
  isConsolidatedMaintenanceCronEnabled,
  readConsolidatedCronJobsFlag,
} from "../../install/cron-jobs.js";
import type { VerifyRunState } from "../verify-run-state.js";

import { approxIntervalMs, relativeTime } from "../../shared.js";

/** Former standalone cron jobs — now config-gated orchestrator modules (not separate cron entries). */
const CONSOLIDATED_FORMER_STANDALONE_MODULES: Array<{
  step: string;
  label: string;
  configHint: string;
  isEnabled: (cfg: HybridMemoryConfig) => boolean;
  runsIn: string;
}> = [
  {
    step: "dream-cycle-core",
    label: "dream cycle",
    configHint: "nightlyCycle.enabled",
    isEnabled: (cfg) => cfg.nightlyCycle?.enabled === true,
    runsIn: "maintenance nightly orchestrator",
  },
  {
    step: "sensor-sweep",
    label: "sensor sweep",
    configHint: "sensorSweep.enabled",
    isEnabled: (cfg) => cfg.sensorSweep?.enabled === true,
    runsIn: "cycle tier (gateway background tick, not maintenance-nightly)",
  },
];

function logConsolidatedOrchestratorModules(
  cfg: HybridMemoryConfig,
  log: (msg: string) => void,
  noEmoji: boolean,
): void {
  const nightlyStepCount = listMaintenanceSteps({ tier: "nightly" }).length;
  const ON = noEmoji ? "on" : "✅ on";
  const OFF = noEmoji ? "off" : "○ off";

  log(
    `\n  Orchestrator: \`maintenance nightly\` runs ${nightlyStepCount} steps with staggered per-step guards (e.g. ~20h / ~44h / ~68h / ~5d / ~25d).`,
  );
  log("  No separate per-task cron jobs are required in consolidated mode.");
  log("\n  Config-gated modules (formerly standalone cron jobs):");
  for (const mod of CONSOLIDATED_FORMER_STANDALONE_MODULES) {
    const enabled = mod.isEnabled(cfg);
    const status = enabled ? ON : OFF;
    log(`    ${status.padEnd(8)} ${mod.step.padEnd(22)} (${mod.configHint}; ${mod.runsIn})`);
  }
  log("  Full step list: `openclaw hybrid-mem maintenance steps`");
}

export async function runVerifyConfigCronSection(state: VerifyRunState): Promise<void> {
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

  const restartPending = existsSync(getRestartPendingPath());
  const modeLabel = cfg.mode
    ? cfg.mode === "custom"
      ? "Custom"
      : cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)
    : "Custom";
  log("\n───── Config ─────");
  log(`  Config source: ${defaultConfigPath} (plugins.entries["${PLUGIN_ID}"].config)`);
  log(`  Mode: ${modeLabel}${restartPending ? " (restart pending)" : ""}`);
  log(`  Run 'openclaw hybrid-mem config' to view or change settings.`);

  state.credentialsOk = true;
  if (cfg.credentials.enabled) {
    if (credentialsDb) {
      try {
        const items = credentialsDb.list();
        if (items.length > 0) {
          const first = items[0];
          credentialsDb.get(first.service, first.type as CredentialType);
        }
        const st = credentialsDb.getVaultStatus();
        const stateLabel = st.encryptedAtRest
          ? `encrypted (kdf_version=${st.kdfVersion})`
          : `plaintext (kdf_version=${st.kdfVersion})`;
        log(`\nCredentials (vault): OK (${items.length} stored) [${stateLabel}]`);
        log(
          `Credentials (vault): encryption_key_configured=${st.configuredKeyPresent ? "yes" : "no"}; migration_required=${
            st.migrationRequired ? "yes" : "no"
          }`,
        );
        if (st.migrationRequired) {
          const WARN = noEmoji ? "[WARN]" : "⚠️";
          log(
            `${WARN} Credentials (vault): encryption key is configured but ignored until the existing vault is encrypted at rest.`,
          );
          log("Fix: run `openclaw hybrid-mem credentials encrypt-vault --yes` (see docs/CREDENTIALS.md).");
        }
      } catch (e) {
        state.issues.push(`Credentials vault: ${String(e)}`);
        const hasKey = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
        if (hasKey) {
          state.fixes.push(
            "Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the key used when credentials were stored, or use a new vault path for plaintext. See docs/CREDENTIALS.md.",
          );
        } else {
          state.fixes.push(
            `Credentials vault: ${String(e)}. If this vault was created with encryption, set credentials.encryptionKey. See docs/CREDENTIALS.md.`,
          );
        }
        state.credentialsOk = false;
        log(`\nCredentials (vault): FAIL — ${String(e)}`);
        capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:credentials-check" });
      }
    } else {
      log("\nCredentials (vault): enabled (vault not opened in this process)");
    }
  }

  const memoryDir = dirname(resolvedSqlitePath);
  const distillLastRunPath = join(memoryDir, ".distill_last_run");
  if (existsSync(distillLastRunPath)) {
    try {
      const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
      log(`\nSession distillation: last run recorded ${line ? `— ${line}` : "(empty file)"}`);
    } catch (e) {
      log("\nSession distillation: last run file present but unreadable");
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-distill-marker" });
    }
  } else {
    log("\nSession distillation: last run not recorded (optional).");
    log(
      "  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill",
    );
    log(
      "  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.",
    );
    log("  If you don't use it, ignore this.");
  }

  // Job name regex patterns for matching (use normalized name so "Weekly Reflection" etc. match)
  let cronStoreSnapshot;
  try {
    cronStoreSnapshot = readOpenClawCronStore(openclawDir);
  } catch (err) {
    const FAIL = noEmoji ? "[FAIL]" : "❌";
    log(`\n${FAIL} Cron store read failed: ${err instanceof Error ? err.message : String(err)}`);
    state.issues.push(`Cron store read error: ${err instanceof Error ? err.message : String(err)}`);
    state.fixes.push(
      "Fix corrupt cron JSON: restore from backup or delete the file to start fresh. See docs/TROUBLESHOOTING.md.",
    );
    return;
  }
  const cronStoreLabel = describeCronStoreLocation(openclawDir, cronStoreSnapshot.backend);
  const cronStoreHasJobs = (cronStoreSnapshot.store.jobs?.length ?? 0) > 0;
  const nightlyMemorySweepRe = /nightly[- ]?memory[- ]?sweep|memory distillation.*nightly|nightly.*memory.*distill/i;
  const weeklyReflectionRe = /weekly[- ]?reflection|memory reflection|pattern synthesis/i;
  const extractProceduresRe = /extract[- ]?procedures|weekly[- ]?extract[- ]?procedures|procedural memory/i;
  const selfCorrectionRe = /self[- ]?correction[- ]?analysis|self[- ]?correction\b/i;
  const weeklyDeepMaintenanceRe = /weekly[- ]?deep[- ]?maintenance|deep maintenance/i;
  const weeklyPersonaProposalsRe = /weekly[- ]?persona[- ]?proposals|persona proposals/i;
  const monthlyConsolidationRe = /monthly[- ]?consolidation/i;

  // Goal stewardship — heartbeat patterns vs cron job messages (issue #1094)
  if (cfg.goalStewardship.enabled) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    const gs = cfg.goalStewardship;
    log("\n───── Goal stewardship (heartbeat) ─────");
    log(
      `${OK} Enabled — heartbeatStewardship: ${gs.heartbeatStewardship ? "on" : "off"} (plugin does not schedule LLM turns; OpenClaw/cron delivers messages)`,
    );
    const matchers = getHeartbeatMatchersForVerify(gs);
    const patternsPreview = (gs.heartbeatPatterns ?? []).slice(0, 3);
    const patternsTail =
      (gs.heartbeatPatterns?.length ?? 0) > patternsPreview.length
        ? `, … (${(gs.heartbeatPatterns?.length ?? 0) - patternsPreview.length} more)`
        : "";
    const patternsHint = patternsPreview.length > 0 ? `: ${patternsPreview.join(" | ")}${patternsTail}` : "";
    log(`  Heartbeat patterns compiled: ${matchers.length} matcher(s)${patternsHint}.`);
    log("  See docs/GOAL-STEWARDSHIP-OPERATOR.md (Heartbeat scheduling checklist).");
    try {
      if (!cronStoreHasJobs) {
        log(
          `${WARN} Cannot confirm heartbeat cron: no jobs in OpenClaw cron store (${cronStoreLabel}). Run \`openclaw hybrid-mem verify --fix\` to seed maintenance jobs, then add a small heartbeat job whose message matches one of the patterns above.`,
        );
      } else {
        const entries = extractCronJobMessageEntries(cronStoreSnapshot.store);
        const h = analyzeCronJobsAgainstHeartbeatPatterns(matchers, entries);
        const withText = entries.filter((e) => e.text.length > 0).length;
        if (entries.length === 0) {
          log(`${WARN} Cron store has no jobs — cannot confirm a heartbeat-shaped message will be delivered.`);
        } else if (withText === 0) {
          log(
            `${WARN} No job message text found in cron store (payload.message / message empty). Stewardship prepends only run when the agent sees a user message matching heartbeat patterns.`,
          );
        } else if (h.matchingJobIds.length === 0) {
          const enabledSample = entries
            .filter((e) => e.enabled && e.text.length > 0)
            .slice(0, 3)
            .map((e) => e.id);
          log(
            `${WARN} No enabled cron job message matches current heartbeat patterns (${withText} job(s) with text${
              h.disabledMatchingJobIds.length > 0 ? `; ${h.disabledMatchingJobIds.length} disabled job(s) match` : ""
            }).`,
          );
          if (enabledSample.length > 0) {
            log(`         Checked enabled jobs (sample): ${enabledSample.join(", ")}`);
          }
          log(
            "         Fix: either (a) add a small dedicated heartbeat job whose payload.message contains one of the patterns above (recommended), or (b) extend goalStewardship.heartbeatPatterns to match an existing job message. Maintenance jobs are intentionally not heartbeat-shaped.",
          );
          state.warnings.push("goal stewardship: no enabled cron job message matches heartbeat patterns");
        } else {
          log(`${OK} Cron jobs with heartbeat-matching message: ${h.matchingJobIds.join(", ")}`);
          if (h.disabledMatchingJobIds.length > 0) {
            log(`ℹ (Disabled jobs also matched — excluded from delivery: ${h.disabledMatchingJobIds.join(", ")})`);
          }
        }
      }
    } catch (e) {
      log(`${WARN} Cannot read or parse cron store for heartbeat check: ${e instanceof Error ? e.message : String(e)}`);
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "cli",
        operation: "runVerifyForCli:goal-stewardship-heartbeat",
      });
    }
  }

  const useConsolidatedCron = isConsolidatedMaintenanceCronEnabled({
    consolidatedCronJobs: readConsolidatedCronJobsFlag(cfg),
  });

  const legacyCronJobKeys = getConsolidatedSupersededLegacyCronJobKeys();
  const maintenanceCronJobKeys = getMaintenanceCronJobKeys();

  const knownJobSlugs = new Set(["maintenance-nightly", ...maintenanceCronJobKeys]);
  const maintenanceNightlyRe = /maintenance[- ]?nightly|orchestrator.*maintenance/i;
  const nightlyDreamCycleRe = /nightly[- ]?dream[- ]?cycle|dream[- ]?cycle/i;
  const sensorSweepRe = /sensor[- ]?sweep/i;

  /** Normalize job name to slug for matching: lowercase, spaces to single hyphen. */
  function nameToSlug(n: string): string {
    return n.toLowerCase().trim().replace(/\s+/g, "-").replace(/-+/g, "-");
  }

  // Helper function to map job names to canonical keys
  function getCanonicalJobKey(name: string, msg?: string): string | null {
    const nameLower = name.toLowerCase();
    const normalized = nameToSlug(name);
    if (
      nightlyMemorySweepRe.test(nameLower) ||
      (msg && /nightly memory distillation|memory distillation pipeline/i.test(msg))
    ) {
      return "nightly-memory-sweep";
    }
    if (weeklyReflectionRe.test(nameLower)) {
      return "weekly-reflection";
    }
    if (extractProceduresRe.test(nameLower)) {
      return "weekly-extract-procedures";
    }
    if (selfCorrectionRe.test(nameLower)) {
      return "self-correction-analysis";
    }
    if (weeklyDeepMaintenanceRe.test(nameLower)) {
      return "weekly-deep-maintenance";
    }
    if (weeklyPersonaProposalsRe.test(nameLower)) {
      return "weekly-persona-proposals";
    }
    if (monthlyConsolidationRe.test(nameLower)) {
      return "monthly-consolidation";
    }
    if (
      maintenanceNightlyRe.test(nameLower) ||
      (msg && /hybrid-mem maintenance nightly|maintenance nightly --verbose/i.test(msg))
    ) {
      return "maintenance-nightly";
    }
    if (nightlyDreamCycleRe.test(nameLower)) {
      return "nightly-dream-cycle";
    }
    if (sensorSweepRe.test(nameLower)) {
      return "sensor-sweep";
    }
    if (knownJobSlugs.has(normalized)) {
      return normalized;
    }
    if (name) {
      return name;
    }
    return null;
  }

  /** Prefer the newer of runner state and persistent guard file (state can lag after restart). */
  function effectiveCronLastRunMs(job: {
    state?: { lastRunAtMs?: number };
    lastRunGuardMs?: number | null;
  }): number | null {
    const stateMs = typeof job.state?.lastRunAtMs === "number" ? job.state.lastRunAtMs : null;
    const guardMs = typeof job.lastRunGuardMs === "number" ? job.lastRunGuardMs : null;
    if (stateMs != null && guardMs != null) return Math.max(stateMs, guardMs);
    return stateMs ?? guardMs;
  }

  // Helper function to format job status display
  function formatJobStatus(job: JobInfo, label: string, indent: string, log: (msg: string) => void): void {
    const isFeatureGated = job.featureGateDisabled === true;
    const statusIcon = job.enabled ? OK : isFeatureGated ? "○" : PAUSE;
    const statusText = job.enabled ? "enabled " : isFeatureGated ? "gated   " : "disabled";

    const parts: string[] = [];

    if (job.scheduleExpr) parts.push(job.scheduleExpr);

    const stateMs = typeof job.state?.lastRunAtMs === "number" ? job.state.lastRunAtMs : null;
    const lastMs = effectiveCronLastRunMs(job);
    if (lastMs != null) {
      if (stateMs != null && lastMs === stateMs) {
        parts.push(`last: ${relativeTime(lastMs)} (${job.state?.lastStatus ?? "unknown"})`);
      } else {
        parts.push(`last: ${relativeTime(lastMs)} (guard)`);
      }
    } else {
      parts.push("last: never");
    }

    if (job.state?.nextRunAtMs) {
      parts.push(`next: ${relativeTime(job.state.nextRunAtMs)}`);
    }
    const interval = approxIntervalMs(job.scheduleExpr ?? null);
    let stale = false;
    if (job.enabled && interval) {
      if (lastMs == null || Date.now() - lastMs > interval * 1.5) stale = true;
    }

    const note = isFeatureGated
      ? "  (disabled by feature gate; will re-enable when feature turns on)"
      : stale
        ? `  ${WARN_LINE} overdue`
        : "";

    log(`${indent}${statusIcon} ${label.padEnd(30)} ${statusText}  ${parts.join("  ")}${note}`);

    if (job.state?.lastError && job.state.lastStatus === "error") {
      const errorPreview = job.state.lastError.slice(0, 100);
      log(`${indent}   └─ error: ${errorPreview}${job.state.lastError.length > 100 ? "..." : ""}`);
    }
  }

  interface JobInfo {
    name: string;
    pluginJobId?: string;
    message?: string;
    enabled: boolean;
    /** Set by ensureMaintenanceCronJobs when a feature gate disabled the job. */
    featureGateDisabled?: boolean;
    /** Cron expression (string or { expr }) so verify can show schedule + flag overdue. */
    scheduleExpr?: string | null;
    /** Lifted from `~/.openclaw/cron/guard/<job>.ms` when the runner has not written `state.lastRunAtMs` yet. */
    lastRunGuardMs?: number | null;
    /** Set when the job carries a `pluginJobId` starting with `hybrid-mem:` (treat the `Other` list as truly external). */
    isHybridMem?: boolean;
    deprecatedCronTokens?: string[];
    state?: {
      nextRunAtMs?: number;
      lastRunAtMs?: number;
      lastStatus?: string;
      lastError?: string;
    };
  }

  const allJobs = new Map<string, JobInfo>();

  function hybridMemCronMessageSanitizerStatus(message: string): "ok" | "partial" | "missing" {
    if (message.includes(HYBRID_MEM_CRON_ENV_SANITIZER_MARKER)) return "ok";
    const required = [
      "OPENCLAW_SKIP_HYBRID_MEMORY_CLI",
      "OPENCLAW_HOME",
      "OPENCLAW_CLI",
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_MARKER",
    ];
    const present = required.filter((v) => message.includes(`-u ${v}`));
    if (present.length > 0 && present.length < required.length) return "partial";
    const mentionsHybridMem = /openclaw\s+hybrid-mem\b/.test(message);
    const hasAnyUnsets =
      message.includes("-u OPENCLAW_HOME") ||
      message.includes("-u OPENCLAW_CLI") ||
      message.includes("-u OPENCLAW_SERVICE_KIND") ||
      message.includes("-u OPENCLAW_SERVICE_MARKER");
    if (mentionsHybridMem && !hasAnyUnsets) return "missing";
    return "ok";
  }

  if (cronStoreHasJobs) {
    try {
      const store = cronStoreSnapshot.store as Record<string, unknown>;
      const jobs = store.jobs;
      if (Array.isArray(jobs)) {
        for (const j of jobs) {
          if (typeof j !== "object" || j === null) continue;
          const job = j as Record<string, unknown>;
          const name = String(job.name ?? "");
          const enabled = job.enabled !== false;
          const featureGateDisabled = job.featureGateDisabled === true;
          const state = job.state as
            | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string }
            | undefined;

          const payload = job.payload as Record<string, unknown> | undefined;
          const msg = String((payload?.message ?? job.message) || "");
          const sched = job.schedule as { expr?: string } | string | undefined;
          const scheduleExpr = typeof sched === "string" ? sched : typeof sched?.expr === "string" ? sched.expr : null;

          const pid = String(job.pluginJobId ?? "");
          const isHybridMem = pid.startsWith("hybrid-mem:");
          const guardName = name.replace(/\s+/g, "-");
          const lastRunGuardMs = isHybridMem ? readGuardTimestampMs(guardName, openclawDir) : null;

          const canonicalKey = getCanonicalJobKey(name, msg);
          if (canonicalKey) {
            const deprecatedCronTokens = findDeprecatedHybridMemCronTokens(msg).map((t) => t.token);
            allJobs.set(canonicalKey, {
              name,
              pluginJobId: pid || undefined,
              message: msg || undefined,
              enabled,
              featureGateDisabled,
              scheduleExpr,
              lastRunGuardMs,
              isHybridMem,
              deprecatedCronTokens: deprecatedCronTokens.length > 0 ? deprecatedCronTokens : undefined,
              state,
            });
          }
        }
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-job-state" });
    }
  }

  // Issue #1205: hybrid-mem cron jobs can fail in service/cron-like envs when OPENCLAW_HOME or service marker vars leak
  // into the execution shell, preventing plugin CLI metadata discovery ("Unknown command: openclaw hybrid-mem").
  const cronEnvLeakPartial: string[] = [];
  const cronEnvLeakMissing: string[] = [];
  for (const [key, job] of allJobs.entries()) {
    if (!job.isHybridMem || !job.message) continue;
    const status = hybridMemCronMessageSanitizerStatus(job.message);
    if (status === "partial") cronEnvLeakPartial.push(key);
    if (status === "missing") cronEnvLeakMissing.push(key);
  }

  // Also check default config for jobs not found in cron store
  if (openclawConfigRead.root) {
    const jobs = openclawConfigRead.root.jobs;
    if (Array.isArray(jobs)) {
      for (const j of jobs) {
        if (typeof j !== "object" || j === null) continue;
        const job = j as Record<string, unknown>;
        const name = String(job.name ?? "");
        const enabled = job.enabled !== false;

        // Only add if not already found in cron store
        const canonicalKey = getCanonicalJobKey(name);
        if (canonicalKey && !allJobs.has(canonicalKey)) {
          allJobs.set(canonicalKey, { name, enabled });
        }
      }
    } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
      const keyed = jobs as Record<string, unknown>;
      for (const [key, value] of Object.entries(keyed)) {
        if (typeof value !== "object" || value === null) continue;
        const job = value as Record<string, unknown>;
        const enabled = job.enabled !== false;

        // Only add if not already found in cron store
        const canonicalKey = getCanonicalJobKey(key);
        if (canonicalKey && !allJobs.has(canonicalKey)) {
          allJobs.set(canonicalKey, { name: key, enabled });
        }
      }
    }
  }

  const optionalFeatureGatedJobs = [
    {
      key: "nightly-dream-cycle",
      description: "dream cycle",
      docsPath: null,
      featureEnabled: cfg.nightlyCycle?.enabled === true,
    },
    {
      key: "sensor-sweep",
      description: "sensor sweep",
      docsPath: null,
      featureEnabled: cfg.sensorSweep?.enabled === true,
    },
  ] as const;

  const legacyJobsToDisplay = [
    {
      key: "nightly-memory-sweep",
      description: "session distillation",
      docsPath: "docs/SESSION-DISTILLATION.md § Nightly Cron Setup",
    },
    { key: "weekly-reflection", description: "pattern synthesis", docsPath: "docs/REFLECTION.md § Scheduled Job" },
    { key: "weekly-extract-procedures", description: "procedural memory", docsPath: "docs/PROCEDURAL-MEMORY.md" },
    { key: "self-correction-analysis", description: "self-correction", docsPath: "docs/SELF-CORRECTION-PIPELINE.md" },
    { key: "weekly-deep-maintenance", description: "deep maintenance", docsPath: null },
    { key: "monthly-consolidation", description: "monthly consolidation", docsPath: null },
    { key: "weekly-persona-proposals", description: "persona proposals", docsPath: null },
  ] as const;

  const jobsToDisplay = useConsolidatedCron
    ? [
        {
          key: "maintenance-nightly",
          description: "maintenance orchestrator",
          docsPath: "docs/SESSION-DISTILLATION.md § Maintenance orchestrator",
        },
      ]
    : [...legacyJobsToDisplay, ...optionalFeatureGatedJobs];

  /** Compact verify mode suppresses indented lines; always show consolidated orchestrator details. */
  const cronLog = useConsolidatedCron ? tableLog : log;

  cronLog(
    useConsolidatedCron
      ? `\nScheduled maintenance (consolidated orchestrator — ${cronStoreLabel}):`
      : `\nScheduled jobs (OpenClaw cron store at ${cronStoreLabel}):`,
  );
  if (useConsolidatedCron) {
    cronLog(
      "  Mode: one gateway cron → `openclaw hybrid-mem maintenance nightly` → orchestrator (legacy per-task jobs superseded).",
    );
  }

  if (useConsolidatedCron) {
    const enabledLegacy = legacyCronJobKeys.filter((key) => allJobs.get(key)?.enabled);
    if (enabledLegacy.length > 0) {
      const WARN = noEmoji ? "[WARN]" : "⚠️";
      cronLog(
        `\n${WARN} Legacy per-task cron jobs still enabled under consolidated orchestrator mode: ${enabledLegacy.join(", ")}. Run \`openclaw hybrid-mem verify --fix\` to disable superseded maintenance jobs and normalize maintenance-nightly.`,
      );
      state.warnings.push(
        `legacy cron jobs still enabled under consolidated orchestrator: ${enabledLegacy.join(", ")}`,
      );
      state.fixes.push(
        "Run 'openclaw hybrid-mem verify --fix' to disable superseded legacy maintenance jobs and ensure maintenance-nightly is installed.",
      );
    }
  }

  if (useConsolidatedCron) {
    cronLog("\n  Gateway cron:");
  }

  for (const entry of jobsToDisplay) {
    const { key, description, docsPath } = entry;
    const featureEnabled = (entry as { featureEnabled?: boolean }).featureEnabled;
    const job = allJobs.get(key);
    const lineLog = useConsolidatedCron ? cronLog : log;

    if (!job) {
      if (featureEnabled === false) {
        lineLog(`  ○ ${key.padEnd(30)} not installed (feature off in config)`);
        continue;
      }
      lineLog(`  ${FAIL} ${key.padEnd(30)} missing`);
      const fixMsg = docsPath
        ? `Optional: Set up ${description} via jobs. See ${docsPath}. Run 'openclaw hybrid-mem verify --fix' to add.`
        : `Optional: Set up ${description} via jobs. Run 'openclaw hybrid-mem verify --fix' to add.`;
      state.fixes.push(fixMsg);
      continue;
    }

    formatJobStatus(job, key, "  ", lineLog);
  }

  if (useConsolidatedCron) {
    logConsolidatedOrchestratorModules(cfg, cronLog, noEmoji);
  }

  if (cronEnvLeakPartial.length > 0 || cronEnvLeakMissing.length > 0) {
    const WARN = noEmoji ? "[WARN]" : "⚠️";
    const list = [
      cronEnvLeakMissing.length > 0 ? `missing sanitizer: ${cronEnvLeakMissing.join(", ")}` : null,
      cronEnvLeakPartial.length > 0 ? `partial sanitizer: ${cronEnvLeakPartial.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    log(
      `\n${WARN} Cron payload env sanitizer (issue #1205): ${list}. Service/cron environments can leak OPENCLAW_HOME / service marker vars and make \`openclaw hybrid-mem\` unavailable. Fix: run \`openclaw hybrid-mem verify --fix\` to inject a robust sanitizer (unsets OPENCLAW_HOME, OPENCLAW_CLI, OPENCLAW_SERVICE_KIND, OPENCLAW_SERVICE_MARKER, OPENCLAW_SKIP_HYBRID_MEMORY_CLI).`,
    );
    state.warnings.push(
      `hybrid-mem cron payloads are missing/partial env sanitizer (issue #1205); run 'openclaw hybrid-mem verify --fix'`,
    );
    state.fixes.push(
      "Run 'openclaw hybrid-mem verify --fix' to update managed cron job messages with an env sanitizer for OPENCLAW_HOME/service markers.",
    );
  }

  // Truly external jobs: those not in the hybrid-mem canonical list AND not pluginJobId hybrid-mem:*
  const knownKeys = new Set(
    useConsolidatedCron ? ["maintenance-nightly", ...maintenanceCronJobKeys] : jobsToDisplay.map((j) => j.key),
  );
  const otherJobs = Array.from(allJobs.entries()).filter(([key, job]) => !knownKeys.has(key) && !job.isHybridMem);

  if (otherJobs.length > 0) {
    log("\n  Other custom jobs (not managed by hybrid-mem):");
    for (const [_key, job] of otherJobs) {
      formatJobStatus(job, job.name, "    ", log);
    }
  }

  // Warn if the stored cron messages or recent exit logs reference deprecated CLI commands/steps.
  const deprecatedCronJobs = Array.from(allJobs.values()).filter(
    (j) => (j.deprecatedCronTokens?.length ?? 0) > 0 && j.featureGateDisabled !== true,
  );
  if (deprecatedCronJobs.length > 0) {
    const affected = deprecatedCronJobs
      .slice(0, 5)
      .map((j) => `${j.pluginJobId ?? j.name} (${(j.deprecatedCronTokens ?? []).join(", ")})`)
      .join("; ");
    state.warnings.push(
      `cron store contains deprecated hybrid-mem command references: ${affected}${
        deprecatedCronJobs.length > 5 ? `; … (${deprecatedCronJobs.length - 5} more)` : ""
      }`,
    );
    log(
      `\n${WARN_LINE} Stale cron payload detected: job messages reference deprecated command(s)/step(s). Run \`openclaw hybrid-mem verify --fix\` to normalize managed job messages.`,
    );
  }

  const wrapperHits = findDeprecatedTokensInWrapperScripts([join(openclawDir, "scripts")]);
  if (wrapperHits.length > 0) {
    const sample = wrapperHits
      .slice(0, 5)
      .map((h) => `${h.path} → ${h.token.token}${h.token.replacement ? ` (use: ${h.token.replacement})` : ""}`)
      .join("; ");
    state.warnings.push(`deprecated hybrid-mem CLI in wrapper scripts: ${sample}`);
    log(
      `\n${WARN_LINE} Wrapper scripts reference deprecated hybrid-mem command(s): ${sample}${
        wrapperHits.length > 5 ? `; … (${wrapperHits.length - 5} more)` : ""
      }`,
    );
  }

  // Also scan recent HM_EXIT logs (these can reveal stale commands even when the top-level cron payload looks correct).
  try {
    const logsRoot = join(openclawDir, "logs", "cron-hybrid-mem");
    if (existsSync(logsRoot)) {
      const cutoffMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const exitFiles = collectRecentHmExitLedgerPaths(logsRoot, cutoffMs);

      const exitHits: Array<{ file: string; hit: ReturnType<typeof findDeprecatedTokensInHmExitContent>[number] }> = [];
      for (const full of exitFiles) {
        try {
          const content = readFileSync(full, "utf-8");
          const hits = findDeprecatedTokensInHmExitContent(content);
          for (const hit of hits) {
            exitHits.push({ file: full, hit });
            if (exitHits.length >= 5) break;
          }
        } catch {
          /* skip unreadable or partial files */
        }
        if (exitHits.length >= 5) break;
      }

      if (exitHits.length > 0) {
        const sample = exitHits
          .map((h) => `${h.hit.token.token} in ${h.file}${h.hit.iso ? ` @ ${h.hit.iso}` : ""}`)
          .slice(0, 3)
          .join("; ");
        state.warnings.push(`recent cron-hybrid-mem exit logs reference deprecated step(s): ${sample}`);
        log(
          `${WARN_LINE} Recent maintenance logs reference deprecated command(s)/step(s). This can happen even when cron jobs appear updated. Normalize with \`openclaw hybrid-mem verify --fix\`.`,
        );
      }
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:scan-cron-exit-logs" });
  }

  // #1877 — warn when the most recent maintenance-nightly run lacks orchestrator summary.json.
  try {
    const logsRoot = join(openclawDir, "logs", "cron-hybrid-mem");
    const nightlyJob = allJobs.get("maintenance-nightly");
    const nightlyMessage = nightlyJob?.message ?? "";
    if (existsSync(logsRoot) && maintenanceCronExpectsSummaryArtifact(nightlyMessage)) {
      const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const exitFiles = collectRecentHmExitLedgerPaths(logsRoot, cutoffMs)
        .filter((exitPath) => /maintenance-nightly/i.test(exitPath))
        .sort((a, b) => {
          try {
            return statSync(b).mtimeMs - statSync(a).mtimeMs;
          } catch {
            return 0;
          }
        });
      const mostRecentExit = exitFiles[0];
      if (mostRecentExit && resolveMaintenanceSummaryPath(mostRecentExit) == null) {
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        cronLog(
          `\n${WARN} Most recent maintenance-nightly run is missing .summary.json; upgrade plugin and use maintenance nightly --summary-out or see docs/maintenance-job-runs.md`,
        );
        state.warnings.push(
          "most recent maintenance-nightly run missing .summary.json; should clear after one successful post-upgrade nightly with HM_SUMMARY harness",
        );
      }
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:scan-summary-json" });
  }

  // Issue #965 — isolated hybrid-mem cron runs must not request a different provider family than
  // agents.defaults.model.primary or OpenClaw may throw LiveSessionModelSwitchError.
  try {
    if (openclawConfigRead.root && cronStoreHasJobs) {
      const root = openclawConfigRead.root;
      const agentPrimary = readEffectiveAgentChatPrimaryFromOpenclawJsonRoot(root);
      if (agentPrimary) {
        const agentFam = inferModelProviderPrefix(agentPrimary);
        const jobs = Array.isArray(cronStoreSnapshot.store.jobs) ? cronStoreSnapshot.store.jobs : [];
        const WARN = noEmoji ? "[WARN]" : "⚠️";
        for (const j of jobs) {
          if (typeof j !== "object" || j === null) continue;
          const job = j as Record<string, unknown>;
          const pid = String(job.pluginJobId ?? job.id ?? "");
          if (!pid.startsWith("hybrid-mem:")) continue;
          const jobModel = extractCronStoreJobModel(job);
          if (!jobModel) continue;
          const jobFam = inferModelProviderPrefix(jobModel);
          if (jobFam && agentFam && jobFam !== agentFam) {
            log(
              `\n${WARN} Cron vs agent model (issues #963, #965): ${pid} uses "${jobModel}" (${jobFam}) but effective chat primary (agents.list id=main, else agents.defaults.model.primary) is "${agentPrimary}" (${agentFam}). Isolated jobs can fail with LiveSessionModelSwitchError. Align provider families, or run \`openclaw hybrid-mem verify --fix\` after changing the agent default to refresh job models. See docs/SESSION-DISTILLATION.md (Maintenance cron session isolation and model alignment).`,
            );
          }
        }
        const llm = cfg.llm as { _source?: string; default?: string[] } | undefined;
        if (
          llm &&
          llm._source !== "gateway" &&
          Array.isArray(llm.default) &&
          llm.default.length > 0 &&
          typeof llm.default[0] === "string"
        ) {
          const first = llm.default[0];
          if (inferModelProviderPrefix(first) !== agentFam) {
            log(
              `\n${WARN} Plugin llm.default[0] ("${first}") differs from effective chat primary ("${agentPrimary}") by provider family. Consider aligning them so maintenance and chat use consistent routing.`,
            );
          }
        }
      }
    }
  } catch (e) {
    capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:cron-model-alignment" });
  }

  log(
    "\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.",
  );

  if (opts.logFile && existsSync(opts.logFile)) {
    try {
      const content = readFileSync(opts.logFile, "utf-8");
      const lines = content.split("\n").filter((l) => /memory-hybrid|prune|auto-classify|periodic|failed/.test(l));
      const errLines = lines.filter((l) => /error|fail|warn/i.test(l));
      if (errLines.length > 0) {
        log(`\nRecent log lines mentioning memory-hybrid/errors (last ${errLines.length}):`);
        errLines.slice(-10).forEach((l) => {
          log(`  ${l.slice(0, 120)}`);
        });
      } else if (lines.length > 0) {
        log(`\nLog file: ${lines.length} relevant lines (no errors in sample)`);
      }
    } catch (e) {
      capturePluginError(e as Error, { subsystem: "cli", operation: "runVerifyForCli:read-log-file" });
    }
  } else if (opts.logFile) {
    log(`\nLog file not found: ${opts.logFile}`);
  }

  state.allOk =
    state.configOk &&
    state.sqliteOk &&
    state.lanceOk &&
    state.embeddingOk &&
    state.embeddingAlignmentOk &&
    (!cfg.credentials.enabled || state.credentialsOk);

  // Surface overdue / never-run cron jobs as warnings so the summary mentions them even when health checks pass.
  for (const [key, job] of allJobs) {
    if (!job.enabled) continue;
    const lastMs = effectiveCronLastRunMs(job);
    const interval = approxIntervalMs(job.scheduleExpr ?? null);
    if (interval && (lastMs == null || Date.now() - lastMs > interval * 1.5)) {
      state.warnings.push(
        `cron job ${key} is overdue: last=${lastMs ? formatTimestampUtcFromMs(lastMs) : "never"}, schedule=${job.scheduleExpr ?? "?"}`,
      );
    }
  }

  if (state.allOk) {
    if (state.warnings.length === 0) {
      log("\nAll checks passed.");
    } else {
      log(`\nAll critical checks passed, but ${state.warnings.length} warning(s):`);
      for (const w of state.warnings) log(`  ${WARN_LINE} ${w}`);
      log(
        "  Tip: re-run after the next scheduled window. If 'last: never' persists, confirm the OpenClaw gateway is running and that ~/.openclaw/cron/guard/<job>.ms is being written.",
      );
    }
    if (restartPending) {
      process.exitCode = 2;
    }
    log(
      "Note: If you see 'plugins.allow is empty' above, it is from OpenClaw. Optional: set plugins.allow to [\"openclaw-hybrid-memory\"] in openclaw.json for an explicit allow-list.",
    );
    if (useConsolidatedCron) {
      if (!allJobs.has("maintenance-nightly")) {
        log(
          "Optional: Set up consolidated maintenance via OpenClaw scheduled jobs. Run 'openclaw hybrid-mem verify --fix' to add maintenance-nightly. See docs/SESSION-DISTILLATION.md.",
        );
      }
    } else if (!allJobs.has("nightly-memory-sweep")) {
      log(
        "Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.",
      );
    }
    log(`Mission Control: ${dashboardUrl} (run \`openclaw hybrid-mem status\` for a one-screen summary).`);
  } else {
    log("\n--- Issues ---");
    if (state.loadBlocking.length > 0) {
      log("Load-blocking (prevent OpenClaw / plugin from loading):");
      state.loadBlocking.forEach((i) => {
        log(`  - ${i}`);
      });
    }
    const other = state.issues.filter((i) => !state.loadBlocking.includes(i));
    if (other.length > 0) {
      log(other.length > 0 && state.loadBlocking.length > 0 ? "Other:" : "Issues:");
      other.forEach((i) => {
        log(`  - ${i}`);
      });
    }
    log("\n--- Fixes for detected issues ---");
    state.fixes.forEach((f) => {
      log(`  • ${f}`);
    });
    log(
      `\nEdit config: ${defaultConfigPath} (resolved via OPENCLAW_CONFIG/OPENCLAW_CONFIG_PATH/OPENCLAW_HOME). Restart gateway after changing plugin config.`,
    );
    log(
      `Suggested embedding path right now: ${recommendedEmbedding.provider}/${recommendedEmbedding.model} (${recommendedEmbedding.reason})`,
    );
    log(`Mission Control: ${dashboardUrl}`);
  }
}
