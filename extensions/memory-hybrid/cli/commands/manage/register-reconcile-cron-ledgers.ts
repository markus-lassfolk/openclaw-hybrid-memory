/**
 * CLI command to reconcile cron run ledgers by validating maintenance artifacts
 * and correcting false-OK entries.
 *
 * Issue: Maintenance cron runs can be recorded as status:"ok" even when validation
 * shows missing required steps or failures.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ReconciliationResult,
  reconcileAllCronRunLedgers,
  reconcileCronRunLedger,
} from "../../../services/cron-maintenance-reconciler.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../../../services/hybrid-mem-cron-default-job-steps.js";
import { type Chainable, withExit } from "../../shared.js";

export function registerReconcileCronLedgers(hybrid: Chainable): void {
  hybrid
    .command("reconcile-cron-ledgers")
    .description("Reconcile cron run ledgers by validating maintenance artifacts and correcting false-OK entries")
    .option("--cron-runs-dir <path>", "Directory containing *.jsonl ledger files")
    .option("--log-dir <path>", "Directory containing HM_EXIT and HM_LOG files")
    .option("--job-id <id>", "Only reconcile this specific job ID")
    .option("--required-steps <steps...>", "Required steps for the job (space-separated)")
    .option("--dry-run", "Don't modify ledger files, just report what would be changed")
    .option("--json", "Output JSON result")
    .action(
      withExit(
        async (opts: {
          cronRunsDir?: string;
          logDir?: string;
          jobId?: string;
          requiredSteps?: string[];
          dryRun?: boolean;
          json?: boolean;
        }) => {
          // Determine directories
          const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
          const cronRunsDir = opts.cronRunsDir || join(openclawHome, "cron", "runs");
          const logDir = opts.logDir || join(openclawHome, "logs", "cron-hybrid-mem");

          // Validate directories exist
          if (!existsSync(cronRunsDir)) {
            console.error(`Error: Cron runs directory not found: ${cronRunsDir}`);
            process.exitCode = 1;
            return;
          }

          if (!existsSync(logDir)) {
            console.error(`Error: Log directory not found: ${logDir}`);
            process.exitCode = 1;
            return;
          }

          let result: ReconciliationResult;

          if (opts.jobId) {
            // Reconcile a single job
            const ledgerPath = join(cronRunsDir, `${opts.jobId}.jsonl`);
            if (!existsSync(ledgerPath)) {
              console.error(`Error: Ledger file not found: ${ledgerPath}`);
              process.exitCode = 1;
              return;
            }

            const requiredSteps = opts.requiredSteps || HYBRID_MEM_CRON_DEFAULT_JOB_STEPS[opts.jobId];
            if (!requiredSteps || requiredSteps.length === 0) {
              console.error(
                `Error: No required steps provided for job ${opts.jobId}. Use --required-steps or ensure job is in default mappings.`,
              );
              process.exitCode = 1;
              return;
            }

            result = reconcileCronRunLedger(ledgerPath, logDir, requiredSteps, !!opts.dryRun);
          } else {
            // Reconcile all jobs
            result = reconcileAllCronRunLedgers(cronRunsDir, logDir, HYBRID_MEM_CRON_DEFAULT_JOB_STEPS, !!opts.dryRun);
          }

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printReconciliationResult(result, !!opts.dryRun);
          }
        },
      ),
    );
}

function printReconciliationResult(result: ReconciliationResult, dryRun: boolean): void {
  console.log("\n=== Cron Run Ledger Reconciliation ===");
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes made)" : "LIVE (ledgers updated)"}`);
  console.log(`\nRuns examined: ${result.examined}`);
  console.log(`False-OK runs found: ${result.falseOk}`);
  console.log(`Runs corrected: ${result.corrected}`);

  if (result.corrections.length > 0) {
    console.log("\nCorrections made:");
    for (const correction of result.corrections) {
      console.log(`\n  Job: ${correction.jobId}`);
      console.log(`  Timestamp: ${new Date(correction.timestamp).toISOString()}`);
      console.log(`  Status: ${correction.originalStatus} → ${correction.newStatus}`);
      console.log(`  Validation: ${correction.validationResult.maintenanceStatus}`);
      if (correction.validationResult.error) {
        console.log(`  Error: ${correction.validationResult.error}`);
      }
      if (correction.validationResult.missingSteps.length > 0) {
        console.log(`  Missing steps: ${correction.validationResult.missingSteps.join(", ")}`);
      }
      if (correction.validationResult.failedSteps.length > 0) {
        console.log(`  Failed steps: ${correction.validationResult.failedSteps.map((s) => s.step).join(", ")}`);
      }
    }
  }

  console.log("\n==============================\n");

  if (result.falseOk > 0 && dryRun) {
    console.log("ℹ️  Run without --dry-run to apply corrections");
  } else if (result.corrected > 0) {
    console.log("✅ Corrections applied successfully");
  } else if (result.examined > 0) {
    console.log("✅ All examined runs are correctly recorded");
  } else {
    console.log("ℹ️  No runs found to examine");
  }
}
