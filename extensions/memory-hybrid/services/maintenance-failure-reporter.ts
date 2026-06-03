import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError, flushErrorReporter, initErrorReporter, isErrorReporterActive } from "./error-reporter.js";
import type { MaintenanceTelemetryIssue } from "./cron-exit-validator.js";
import { getEnv } from "../utils/env-manager.js";
import type { MaintenanceFailureReportingConfig } from "../config/types/maintenance.js";

export const MAINTENANCE_FAILURE_REPORTING_DISABLE_ENV = "HYBRID_MEMORY_DISABLE_MAINTENANCE_ERROR_REPORTING";
const MAINTENANCE_REPORTER_FLUSH_TIMEOUT_MS = 750;

type MaintenanceReporterContext = {
  cfg: {
    errorReporting: HybridMemoryConfig["errorReporting"];
    maintenance: {
      failureReporting: MaintenanceFailureReportingConfig;
    };
  };
  pluginVersion: string;
  logger?: Pick<Console, "debug" | "info" | "warn">;
};

function envDisablesMaintenanceFailureReporting(env?: Record<string, string | undefined>): boolean {
  const value = env
    ? env[MAINTENANCE_FAILURE_REPORTING_DISABLE_ENV]
    : getEnv(MAINTENANCE_FAILURE_REPORTING_DISABLE_ENV);
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export function shouldReportMaintenanceFailures(
  cfg: MaintenanceReporterContext["cfg"],
  env?: Record<string, string | undefined>,
): boolean {
  if (envDisablesMaintenanceFailureReporting(env)) return false;
  if (cfg.maintenance.failureReporting.enabled === false) return false;
  return cfg.errorReporting.enabled === true && cfg.errorReporting.consent === true;
}

async function ensureMaintenanceReporterReady(context: MaintenanceReporterContext): Promise<boolean> {
  if (isErrorReporterActive()) return true;
  await initErrorReporter(
    {
      enabled: context.cfg.errorReporting.enabled,
      dsn: context.cfg.errorReporting.dsn,
      mode: context.cfg.errorReporting.mode,
      environment: context.cfg.errorReporting.environment,
      maxBreadcrumbs: 10,
      sampleRate: context.cfg.errorReporting.sampleRate ?? 1.0,
      consent: context.cfg.errorReporting.consent,
      botId: context.cfg.errorReporting.botId,
      botName: context.cfg.errorReporting.botName,
      resolvedIssues: context.cfg.errorReporting.resolvedIssues,
    },
    context.pluginVersion,
    context.logger,
  );
  return isErrorReporterActive();
}

export async function reportMaintenanceFailureIssues(
  issues: MaintenanceTelemetryIssue[],
  context: MaintenanceReporterContext,
): Promise<void> {
  if (issues.length === 0 || !shouldReportMaintenanceFailures(context.cfg)) {
    return;
  }

  try {
    const active = await ensureMaintenanceReporterReady(context);
    if (!active) return;

    const uniqueIssues = new Map<string, MaintenanceTelemetryIssue>();
    for (const issue of issues) {
      const key = issue.fingerprint.join(":");
      if (!uniqueIssues.has(key)) uniqueIssues.set(key, issue);
    }

    for (const issue of uniqueIssues.values()) {
      const error = new Error(issue.message);
      error.name = "HybridMemoryMaintenanceFailure";
      capturePluginError(error, {
        subsystem: "maintenance",
        operation: issue.stepName,
        phase: issue.failureCategory,
        fingerprint: issue.fingerprint,
        tags: {
          component: "hybrid-memory",
          job_name: issue.jobName,
          step_name: issue.stepName,
          failure_class: issue.failureClass,
          exit_code: issue.exitCode === undefined ? undefined : String(issue.exitCode),
          semantic_status: issue.semanticStatus,
        },
        contexts: {
          maintenance: {
            job_name: issue.jobName,
            step_name: issue.stepName,
            failure_category: issue.failureCategory,
            failure_class: issue.failureClass,
            guard_file: issue.guardFile,
            guard_state_before: issue.guardStateBefore,
            guard_state_after: issue.guardStateAfter,
            hm_log_path: issue.hmLogPath,
            hm_exit_path: issue.hmExitPath,
            artifact_paths: issue.artifactPaths,
            last_success_at: issue.lastSuccessAt,
            duration_ms: issue.durationMs,
            facts_scanned: issue.factsScanned,
            facts_changed: issue.factsChanged,
            stored_count: issue.storedCount,
            collapsed_count: issue.collapsedCount,
            model: issue.model,
            fallbacks: issue.fallbacks,
          },
        },
      });
    }

    await flushErrorReporter(MAINTENANCE_REPORTER_FLUSH_TIMEOUT_MS);
  } catch (err) {
    const firstFingerprint = issues[0]?.fingerprint.join(":");
    const message = `memory-hybrid: maintenance failure reporting skipped after reporter error: ${err instanceof Error ? err.message : String(err)} (issues=${issues.length}${firstFingerprint ? ` first=${firstFingerprint}` : ""})`;
    if (context.logger?.warn) {
      context.logger.warn(message);
    } else if (context.logger?.debug) {
      context.logger.debug(message);
    }
  }
}
