/**
 * CLI command to validate cron exit ledger after maintenance runs.
 *
 * This can be called from within a cron job message to validate that all
 * required steps completed successfully and fail the job if they didn't.
 */

import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { HybridMemoryConfig } from "../../../config.js";
import {
  type ExitValidationResult,
  extractMaintenanceJobName,
  generateCronStatusReport,
  resolveValidateCronExitCode,
  validateFromSummaryJson,
  validateMaintenanceExecution,
} from "../../../services/cron-exit-validator.js";
import { recordMaintenanceCronRunOutcome } from "../../../services/maintenance-audit-journal.js";
import { reportMaintenanceFailureIssues } from "../../../services/maintenance-failure-reporter.js";
import { type Chainable, withExit } from "../../shared.js";

export interface ValidateCronExitContext {
  cfg: Pick<HybridMemoryConfig, "errorReporting" | "maintenance">;
  versionInfo: { pluginVersion: string };
  logger?: Pick<Console, "debug" | "info" | "warn">;
  /** Enables a durable on-disk retry queue for reportMaintenanceFailureIssues (see there for why). */
  resolvedSqlitePath?: string;
  /**
   * Enables local, telemetry-consent-independent persistence of this run's structured outcome
   * (issue #2231) — one `maintenance_runs` row per cron-lane invocation, success or failure, so
   * `maintenance status` can report last-scheduled-run / last-successful-run per job even when
   * error reporting is disabled or unreachable.
   */
  journalDb?: DatabaseSync;
}

export function registerValidateCronExit(hybrid: Chainable, context?: ValidateCronExitContext): void {
  hybrid
    .command("validate-cron-exit")
    .description("Validate cron exit ledger (internal use by cron jobs)")
    .requiredOption("--exit-path <path>", "Path to HM_EXIT file")
    .option("--log-path <path>", "Path to HM_LOG file")
    .requiredOption("--required-steps <steps...>", "Required step names (space-separated)")
    .option("--allow-skip", "Allow skip variants (e.g., distill-skipped) to count as success")
    .option("--summary-path <path>", "Orchestrator summary.json (preferred when present)")
    .option("--json", "Output JSON result")
    .option(
      "--output-json <path>",
      "Write JSON result directly to this file via fs, bypassing stdout entirely. Immune to " +
        "host/plugin bootstrap logs that print to stdout before this command runs, unlike --json " +
        "(#2133); cron harnesses should prefer this over parsing stdout.",
    )
    .action(
      withExit(
        async (opts: {
          exitPath: string;
          logPath?: string;
          requiredSteps: string[];
          allowSkip?: boolean;
          summaryPath?: string;
          json?: boolean;
          outputJson?: string;
        }) => {
          const result = opts.summaryPath?.trim()
            ? validateFromSummaryJson(
                opts.summaryPath.trim(),
                opts.exitPath,
                opts.logPath,
                opts.requiredSteps,
                !!opts.allowSkip,
              )
            : validateMaintenanceExecution(opts.exitPath, opts.logPath, opts.requiredSteps, !!opts.allowSkip);

          if (opts.outputJson?.trim()) {
            // A write failure here (e.g. ENOSPC, permissions) must not skip the console output,
            // telemetry reporting, and exit-code resolution below — the validation result was
            // already computed and is still worth surfacing even if this artifact can't be written
            // (#2134 QA follow-up).
            try {
              writeFileSync(opts.outputJson.trim(), generateCronStatusReport(result), "utf8");
            } catch (err) {
              console.error(
                `Failed to write --output-json to ${opts.outputJson.trim()}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          if (opts.json) {
            console.log(generateCronStatusReport(result));
          } else {
            printValidationResult(result);
          }

          // Local structured outcome persistence (#2231) — unconditional on telemetry consent, so
          // `maintenance status` has a durable last-scheduled/last-successful-run record per cron
          // lane even when GlitchTip reporting is disabled or unreachable. Runs before the
          // telemetry call below so a reporting failure can never suppress this local write.
          if (context?.journalDb) {
            const primaryIssue = result.reportableIssues[0];
            recordMaintenanceCronRunOutcome(context.journalDb, {
              jobName: extractMaintenanceJobName(opts.exitPath || opts.logPath),
              maintenanceStatus: result.maintenanceStatus,
              primaryFailure: primaryIssue
                ? {
                    stepName: primaryIssue.stepName,
                    failureClass: primaryIssue.failureClass,
                    message: primaryIssue.message,
                  }
                : undefined,
              failingStepNames: result.reportableIssues.map((issue) => issue.stepName),
            });
          }

          // Best-effort telemetry runs after output so one-shot cron validation still
          // emits JSON/status promptly; reportMaintenanceFailureIssues no-ops when no
          // normalized issues were derived from the run.
          if (context) {
            await reportMaintenanceFailureIssues(result.reportableIssues, {
              cfg: context.cfg,
              pluginVersion: context.versionInfo.pluginVersion,
              logger: context.logger,
              resolvedSqlitePath: context.resolvedSqlitePath,
            });
          }

          const exitCode = resolveValidateCronExitCode(result);
          if (exitCode !== 0) {
            process.exitCode = exitCode;
          }
        },
      ),
    );
}

function printValidationResult(result: ExitValidationResult): void {
  console.log("\n=== Maintenance Validation ===");
  console.log(`Status: ${result.maintenanceStatus.toUpperCase()}`);

  if (result.exitPath) {
    console.log(`Exit ledger: ${result.exitPath}`);
  }
  if (result.logPath) {
    console.log(`Log file: ${result.logPath}`);
  }

  console.log(`\nSteps executed: ${result.steps.length}`);
  for (const step of result.steps) {
    const status = step.exitCode === 0 ? "✓" : "✗";
    console.log(`  ${status} ${step.step} (exit=${step.exitCode})`);
  }

  if (result.missingSteps.length > 0) {
    console.log(`\nMissing steps: ${result.missingSteps.join(", ")}`);
  }

  if (result.failedSteps.length > 0) {
    console.log("\nFailed steps:");
    for (const step of result.failedSteps) {
      console.log(`  ✗ ${step.step} (exit=${step.exitCode})`);
    }
  }

  if (result.error) {
    console.log(`\nError: ${result.error}`);
  }
  if (result.failureClass) {
    console.log(`Failure class: ${result.failureClass}`);
  }
  if (result.wrapperExitCode != null) {
    console.log(`Wrapper exit: ${result.wrapperExitCode}`);
  }

  console.log(`\nGuard file update: ${result.guardUpdated ? "YES" : "NO"}`);
  console.log("==============================\n");
}
