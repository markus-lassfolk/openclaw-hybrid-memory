/**
 * CLI command to validate cron exit ledger after maintenance runs.
 *
 * This can be called from within a cron job message to validate that all
 * required steps completed successfully and fail the job if they didn't.
 */

import type { HybridMemoryConfig } from "../../../config.js";
import { reportMaintenanceFailureIssues } from "../../../services/maintenance-failure-reporter.js";
import { type Chainable, withExit } from "../../shared.js";
import {
  validateMaintenanceExecution,
  validateFromSummaryJson,
  generateCronStatusReport,
  type ExitValidationResult,
} from "../../../services/cron-exit-validator.js";

export interface ValidateCronExitContext {
  cfg: Pick<HybridMemoryConfig, "errorReporting" | "maintenance">;
  versionInfo: { pluginVersion: string };
  logger?: Pick<Console, "debug" | "info" | "warn">;
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
    .action(
      withExit(
        async (opts: {
          exitPath: string;
          logPath?: string;
          requiredSteps: string[];
          allowSkip?: boolean;
          summaryPath?: string;
          json?: boolean;
        }) => {
          const result = opts.summaryPath?.trim()
            ? validateFromSummaryJson(
                opts.summaryPath.trim(),
                opts.exitPath,
                opts.logPath,
                opts.requiredSteps,
                !!opts.allowSkip,
              )
            : validateMaintenanceExecution(
                opts.exitPath,
                opts.logPath,
                opts.requiredSteps,
                !!opts.allowSkip,
              );

          if (opts.json) {
            console.log(generateCronStatusReport(result));
          } else {
            printValidationResult(result);
          }

          // Best-effort telemetry runs after output so one-shot cron validation still
          // emits JSON/status promptly; reportMaintenanceFailureIssues no-ops when no
          // normalized issues were derived from the run.
          if (context) {
            await reportMaintenanceFailureIssues(result.reportableIssues, {
              cfg: context.cfg,
              pluginVersion: context.versionInfo.pluginVersion,
              logger: context.logger,
            });
          }

          if (
            result.maintenanceStatus === "failed" ||
            result.maintenanceStatus === "partial" ||
            result.semanticStatus === "semantic_fail" ||
            (result.maintenanceStatus === "success" && !result.guardUpdated && result.semanticStatus !== "ok")
          ) {
            process.exitCode = 1;
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

  console.log(`\nGuard file update: ${result.guardUpdated ? "YES" : "NO"}`);
  console.log("==============================\n");
}
