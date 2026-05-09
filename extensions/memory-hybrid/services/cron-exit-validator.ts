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
  failureReason?: string;
  strictFailureReason?: string;
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
    exitCode: Number.parseInt(match[3], 10),
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
/**
 * Detect agent/log text that matches hybrid-mem cron preambles for intentional full-job skips
 * when a feature gate is off (no hm_step runs, empty HM_EXIT). Avoids false greens on shell
 * abort before first step — we only match phrases unlikely to appear in generic failures.
 */
export function logIndicatesIntentionalFeatureSkip(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  try {
    const text = readFileSync(logPath, "utf-8").toLowerCase();
    if (text.length === 0) return false;
    if (/\bjob was skipped\b/.test(text)) return true;
    if (/\bskip(ped|ping)?\b.*\bhybrid[- ]memory\b.*\bconfig\b/.test(text)) return true;
    if (/\bself[- ]correction\b.*\b(disabled|skipped)\b/.test(text)) return true;
    if (/\breflection\b.*\b(disabled|skipped|enabled is false)\b/.test(text)) return true;
    if (/\bnightly\s*cycle\b.*\b(disabled|skipped|enabled is false)\b/.test(text)) return true;
    if (/\bsensor\s*sweep\b.*\b(disabled|skipped|enabled is false)\b/.test(text)) return true;
    if (/\bpersona\s*proposals?\b.*\b(disabled|skipped|enabled is false)\b/.test(text)) return true;
    if (/\bskip the script\b.*\b(disabled|reply)\b/.test(text)) return true;
    return false;
  } catch {
    return false;
  }
}

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

  if (logPath && failedSteps.some((s) => s.step === "audit-health")) {
    const logContent = safeReadLog(logPath);
    for (const step of failedSteps) {
      if (step.step !== "audit-health") continue;
      const inferred = inferAuditHealthFailureReason(step.exitCode, logContent);
      step.failureReason = inferred.failureReason;
      step.strictFailureReason = inferred.strictFailureReason;
    }
  }

  // Determine overall status
  let maintenanceStatus: "success" | "skipped" | "partial" | "failed";

  if (missingSteps.length === 0 && failedSteps.length === 0) {
    // All required steps present and succeeded
    maintenanceStatus = "success";
  } else if (missingSteps.length === requiredSteps.length) {
    // Every required step absent — usually a hard failure (shell died before hm_step).
    // Exception: cron preambles that tell the agent to skip the whole script when a feature
    // is disabled leave an empty ledger; corroborate with HM_LOG text.
    if (logPath && steps.length === 0 && failedSteps.length === 0 && logIndicatesIntentionalFeatureSkip(logPath)) {
      maintenanceStatus = "skipped";
    } else {
      maintenanceStatus = "failed";
    }
  } else if (missingSteps.length > 0 || failedSteps.length > 0) {
    // Some steps missing or failed
    maintenanceStatus = failedSteps.length > 0 ? "failed" : "partial";
  } else {
    maintenanceStatus = "success";
  }

  // Guard should only be updated on full success (not feature-gated skips).
  const guardUpdated = maintenanceStatus === "success";

  // Build error message
  let error: string | undefined;
  if (maintenanceStatus === "failed" || maintenanceStatus === "partial") {
    const parts: string[] = [];
    if (missingSteps.length > 0) {
      parts.push(`Missing steps: ${missingSteps.join(", ")}`);
    }
    if (failedSteps.length > 0) {
      parts.push(
        `Failed steps: ${failedSteps
          .map((s) => `${s.step} (exit=${s.exitCode}${s.failureReason ? ` ${s.failureReason}` : ""})`)
          .join(", ")}`,
      );
    }
    error = parts.join("; ");
  } else if (maintenanceStatus === "skipped") {
    error = "Feature-gated skip: no hm_step lines in HM_EXIT; log indicates disabled feature (guard not updated).";
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
      requiredSteps: validation.steps.map((s) => ({
        name: s.step,
        exit: s.exitCode,
      })),
      missingSteps: validation.missingSteps,
      failedSteps: validation.failedSteps.map((s) => ({
        name: s.step,
        exit: s.exitCode,
        reason: s.failureReason,
        strictFailureReason: s.strictFailureReason,
        error:
          s.exitCode !== 0
            ? s.failureReason
              ? `Non-zero exit code (${s.failureReason})`
              : "Non-zero exit code"
            : undefined,
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

function safeReadLog(logPath: string): string {
  try {
    return existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  } catch {
    return "";
  }
}

function inferAuditHealthFailureReason(
  exitCode: number,
  logContent: string,
): { failureReason: string; strictFailureReason?: string } {
  const extracted = extractAuditHealthJsonFromLog(logContent);
  if (extracted.kind === "not_found") return { failureReason: "command_crash" };
  if (extracted.kind === "parse_error") return { failureReason: "json_parse_failure" };

  const exitReason = extracted.value.exitReason;
  if (typeof exitReason === "string" && exitReason.trim()) {
    return {
      failureReason: exitReason.trim(),
      strictFailureReason:
        typeof extracted.value.strictFailureReason === "string" ? extracted.value.strictFailureReason : undefined,
    };
  }

  const warningCount =
    typeof extracted.value.warningCount === "number" ? Math.max(0, extracted.value.warningCount) : 0;
  const errorCount = typeof extracted.value.errorCount === "number" ? Math.max(0, extracted.value.errorCount) : 0;

  if (exitCode === 2) {
    if (errorCount > 0) return { failureReason: "strict_errors" };
    if (warningCount > 0) return { failureReason: "strict_warnings" };
  }
  return { failureReason: "nonzero_exit" };
}

type ExtractedAuditHealthJson =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "parse_error" };

function extractAuditHealthJsonFromLog(logContent: string): ExtractedAuditHealthJson {
  // Attempt to locate the audit-health JSON payload in a mixed cron log. We avoid regex-only
  // extraction because nested JSON contains braces and newlines.
  const candidates = scanJsonObjects(logContent);
  const likelyAuditHealth = /"schemaVersion"\s*:\s*1/.test(logContent) && /"activeFacts"\s*:/.test(logContent);
  if (candidates.length === 0) return likelyAuditHealth ? { kind: "parse_error" } : { kind: "not_found" };

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
        typeof (parsed as { activeFacts?: unknown }).activeFacts === "number" &&
        Array.isArray((parsed as { warnings?: unknown }).warnings) &&
        Array.isArray((parsed as { errors?: unknown }).errors)
      ) {
        return { kind: "ok", value: parsed };
      }
    } catch {
      // Keep scanning; a later JSON block might be the actual audit-health payload.
    }
  }

  return likelyAuditHealth ? { kind: "parse_error" } : { kind: "not_found" };
}

function scanJsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findJsonObjectEnd(text, i);
    if (end == null) continue;
    out.push(text.slice(i, end + 1));
    i = end;
  }
  return out;
}

function findJsonObjectEnd(text: string, startIdx: number): number | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
  }
  return null;
}
