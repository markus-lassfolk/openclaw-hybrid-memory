/**
 * CLI command to validate cron exit ledger after maintenance runs.
 *
 * This can be called from within a cron job message to validate that all
 * required steps completed successfully and fail the job if they didn't.
 */

import { existsSync } from "node:fs";
import type { Chainable } from "../../shared.js";
import {
  validateMaintenanceExecution,
  generateCronStatusReport,
  type ExitValidationResult,
} from "../../../services/cron-exit-validator.js";

export function registerValidateCronExit(hybrid: Chainable): void {
  hybrid
    .command("validate-cron-exit")
    .description("Validate cron exit ledger (internal use by cron jobs)")
    .requiredOption("--exit-path <path>", "Path to HM_EXIT file")
    .option("--log-path <path>", "Path to HM_LOG file")
    .requiredOption("--required-steps <steps...>", "Required step names (space-separated)")
    .option("--allow-skip", "Allow skip variants (e.g., distill-skipped) to count as success")
    .option("--json", "Output JSON result")
    .action(async (opts: {
      exitPath: string;
      logPath?: string;
      requiredSteps: string[];
      allowSkip?: boolean;
      json?: boolean;
    }) => {
      const result = validateMaintenanceExecution(
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

      // Exit with non-zero if maintenance failed
      if (result.maintenanceStatus === "failed" || result.maintenanceStatus === "partial") {
        process.exitCode = 1;
      }
    });
}

function printValidationResult(result: ExitValidationResult): void {
  console.log(`\n=== Maintenance Validation ===`);
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
    console.log(`\nFailed steps:`);
    for (const step of result.failedSteps) {
      console.log(`  ✗ ${step.step} (exit=${step.exitCode})`);
    }
  }

  if (result.error) {
    console.log(`\nError: ${result.error}`);
  }

  console.log(`\nGuard file update: ${result.guardUpdated ? "YES" : "NO"}`);
  console.log(`==============================\n`);
}
