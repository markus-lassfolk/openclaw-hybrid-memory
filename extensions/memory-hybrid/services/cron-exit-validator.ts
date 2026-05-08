/**
 * Exit ledger validation for hybrid-memory cron jobs.
 *
 * Validates that all required maintenance steps completed successfully by checking
 * the HM_EXIT file. This prevents reporting "ok" status when steps fail, are missing,
 * or only partially complete.
 *
 * Issue: hybrid-memory cron jobs report OK despite failed or partial maintenance
 */

import { existsSync, readFileSync } from "node:fs";

export interface ExitStep {
  timestamp: string;
  step: string;
  exitCode: number;
  line: string;
}

export interface ExitValidationResult {
  /** Overall maintenance status */
  maintenanceStatus: "success" | "skipped" | "partial" | "failed";
  /** All steps found in exit ledger */
  steps: ExitStep[];
  /** Required steps that are missing from exit ledger */
  missingSteps: string[];
  /** Required steps that failed (non-zero exit) */
  failedSteps: ExitStep[];
  /** Whether guard file should be updated */
  guardUpdated: boolean;
  /** Log file path */
  logPath?: string;
  /** Exit file path */
  exitPath?: string;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Parse an HM_EXIT file line.
 * Format: {ISO_TIMESTAMP} {step_name} exit={exit_code}
 * Example: 2024-05-08T02:15:30Z prune exit=0
 */
export function parseExitLine(line: string): ExitStep | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Match: ISO timestamp, step name, exit code
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\S+)\s+exit=(-?\d+)$/);
  if (!match) return null;

  return {
    timestamp: match[1],
    step: match[2],
    exitCode: parseInt(match[3], 10),
    line: trimmed,
  };
}

/**
 * Read and parse an HM_EXIT file.
 */
export function readExitLedger(exitPath: string): ExitStep[] {
  if (!existsSync(exitPath)) {
    return [];
  }

  try {
    const content = readFileSync(exitPath, "utf-8");
    const lines = content.split("\n");
    const steps: ExitStep[] = [];

    for (const line of lines) {
      const step = parseExitLine(line);
      if (step) {
        steps.push(step);
      }
    }

    return steps;
  } catch (err) {
    return [];
  }
}

/**
 * Check for "unknown command" errors in log file.
 */
export function checkForUnknownCommands(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    const unknownCommands: string[] = [];

    for (const line of lines) {
      // Match patterns like: "error: unknown command 'consolidate-episodes'"
      const match = line.match(/(?:error|Error):\s*unknown command\s+['"]([^'"]+)['"]/);
      if (match) {
        unknownCommands.push(match[1]);
      }
    }

    return unknownCommands;
  } catch {
    return [];
  }
}

/**
 * Validate that all required maintenance steps completed successfully.
 *
 * @param exitPath - Path to HM_EXIT file
 * @param logPath - Path to HM_LOG file
 * @param requiredSteps - List of step names that must complete with exit=0
 * @param allowSkip - If true, treat guard-skip as success (not an error)
 * @returns Validation result with maintenance status
 */
export function validateMaintenanceExecution(
  exitPath: string,
  logPath: string | undefined,
  requiredSteps: string[],
  allowSkip = false,
): ExitValidationResult {
  // Check if files exist
  if (!existsSync(exitPath)) {
    return {
      maintenanceStatus: "failed",
      steps: [],
      missingSteps: requiredSteps,
      failedSteps: [],
      guardUpdated: false,
      exitPath,
      logPath,
      error: `Exit ledger not found: ${exitPath}`,
    };
  }

  // Read exit ledger
  const steps = readExitLedger(exitPath);

  // Check for unknown commands in log
  const unknownCommands = logPath ? checkForUnknownCommands(logPath) : [];
  if (unknownCommands.length > 0) {
    return {
      maintenanceStatus: "failed",
      steps,
      missingSteps: requiredSteps,
      failedSteps: [],
      guardUpdated: false,
      exitPath,
      logPath,
      error: `Unknown command(s) detected: ${unknownCommands.join(", ")}`,
    };
  }

  // Build map of actual steps
  const stepMap = new Map<string, ExitStep>();
  for (const step of steps) {
    stepMap.set(step.step, step);
  }

  // Check for missing required steps
  const missingSteps: string[] = [];
  const failedSteps: ExitStep[] = [];

  for (const required of requiredSteps) {
    const step = stepMap.get(required);
    if (!step) {
      // Check for skip variants (e.g., "distill-skipped" when "distill" is required)
      const skipVariant = stepMap.get(`${required}-skipped`);
      if (skipVariant && skipVariant.exitCode === 0 && allowSkip) {
        // Skip variant found and allowed - this is OK
        continue;
      }
      missingSteps.push(required);
    } else if (step.exitCode !== 0) {
      failedSteps.push(step);
    }
  }

  // Determine overall status
  let maintenanceStatus: "success" | "skipped" | "partial" | "failed";

  if (missingSteps.length === 0 && failedSteps.length === 0) {
    // All required steps present and succeeded
    maintenanceStatus = "success";
  } else if (missingSteps.length === requiredSteps.length) {
    // All steps missing - likely skipped due to guard or config
    maintenanceStatus = "skipped";
  } else if (missingSteps.length > 0 || failedSteps.length > 0) {
    // Some steps missing or failed
    maintenanceStatus = failedSteps.length > 0 ? "failed" : "partial";
  } else {
    maintenanceStatus = "success";
  }

  // Guard should only be updated if status is success
  const guardUpdated = maintenanceStatus === "success";

  // Build error message
  let error: string | undefined;
  if (maintenanceStatus === "failed" || maintenanceStatus === "partial") {
    const parts: string[] = [];
    if (missingSteps.length > 0) {
      parts.push(`Missing steps: ${missingSteps.join(", ")}`);
    }
    if (failedSteps.length > 0) {
      parts.push(`Failed steps: ${failedSteps.map(s => `${s.step} (exit=${s.exitCode})`).join(", ")}`);
    }
    error = parts.join("; ");
  }

  return {
    maintenanceStatus,
    steps,
    missingSteps,
    failedSteps,
    guardUpdated,
    exitPath,
    logPath,
    error,
  };
}

/**
 * Helper to generate a structured JSON report for cron job result.
 * This can be returned by the agent to provide machine-readable status.
 */
export function generateCronStatusReport(validation: ExitValidationResult): string {
  return JSON.stringify(
    {
      maintenanceStatus: validation.maintenanceStatus,
      requiredSteps: validation.steps.map(s => ({
        name: s.step,
        exit: s.exitCode,
      })),
      missingSteps: validation.missingSteps,
      failedSteps: validation.failedSteps.map(s => ({
        name: s.step,
        exit: s.exitCode,
        error: s.exitCode !== 0 ? "Non-zero exit code" : undefined,
      })),
      guardUpdated: validation.guardUpdated,
      logPath: validation.logPath,
      exitPath: validation.exitPath,
      error: validation.error,
    },
    null,
    2,
  );
}
