/**
 * Exit ledger validation for hybrid-memory cron jobs.
 *
 * Validates that all required maintenance steps completed successfully by checking
 * the HM_EXIT file. This prevents reporting "ok" status when steps fail, are missing,
 * or only partially complete.
 *
 * Issue: hybrid-memory cron jobs report OK despite failed or partial maintenance
 *
 * ## Maintenance result vocabulary
 *
 * `maintenanceStatus` in {@link ExitValidationResult} uses the following values:
 *
 * - `"success"` — All required steps are present in the HM_EXIT ledger and every
 *   step exited 0 (or a permitted skip variant matched). The guard file MAY be
 *   updated after a `"success"` result.
 *
 * - `"skipped"` — The exit ledger is empty AND the HM_LOG contains a recognised
 *   feature-gate phrase (e.g. "reflection.enabled is false"). No hm_step lines ran.
 *   The guard file MUST NOT be updated; the skip is recorded for audit but is not
 *   treated as a failure.
 *
 * - `"partial"` — Some but not all required steps are present in the ledger and the
 *   present steps all exited 0. The guard file MUST NOT be updated; the job should
 *   be requeued or investigated.
 *
 * - `"failed"` — At least one step exited non-zero, or all required steps are absent
 *   and the log does not indicate an intentional feature skip, or an unknown command
 *   was detected in the log. The guard file MUST NOT be updated.
 *
 * ## Guard update rule
 *
 * `guardUpdated` is `true` only when `maintenanceStatus === "success"`.  Callers
 * MUST NOT write a success guard for `"skipped"`, `"partial"`, or `"failed"` runs.
 * This ensures that a shell-exited-0 cron wrapper cannot silently masquerade as a
 * healthy run when the semantic work did not complete.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { extractAuditHealthJsonFromLog } from "./audit-health-json.js";
import type { JobRunSemanticOutcome, OrchestratorRunSummary } from "./maintenance-job-run/types.js";
import {
  jobRunOutcomeToValidatorSemantic,
  parseSemanticTokenFromSummary,
  reflectRulesStepSummaryIndicatesFailure,
  resolveSemanticGuardToken,
  semanticOutcomeBlocksOrchestratorGuard,
  semanticOutcomeIsPartialFailure,
} from "./maintenance-job-run/semantic-outcome.js";

const SKIP_REASON_COOLDOWN = "skipped_cooldown";
const SKIP_REASON_CONCURRENCY = "skipped_concurrency";
const SYNTHETIC_CONTINUOUS_VERIFICATION_TIMESTAMP = "1970-01-01T00:00:00Z";
const LARGE_BACKLOG_THRESHOLD = 1000;
const MAINTENANCE_JOB_SUFFIX_PATTERNS = [
  /-\d{8}T\d{6}Z-\d+$/,
  /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
  /-\d{8}\.cron$/,
];

export interface ExitStep {
  timestamp: string;
  step: string;
  exitCode: number;
  line: string;
  status?: "ok" | "failed" | "skipped";
  reason?: string;
  durationMs?: number;
  failureReason?: string;
  strictFailureReason?: string;
}

export interface ExitValidationResult {
  /** Overall maintenance status */
  maintenanceStatus: "success" | "skipped" | "partial" | "failed";
  /** Semantic interpretation of the run for maintenance telemetry. */
  semanticStatus: "ok" | "degraded" | "semantic_fail" | "unknown";
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
  /** Best-effort grouped maintenance telemetry issues derived from the run. */
  reportableIssues: MaintenanceTelemetryIssue[];
}

export type MaintenanceSemanticStatus = ExitValidationResult["semanticStatus"];

export type MaintenanceFailureCategory =
  | "mechanical_failure"
  | "semantic_failure"
  | "concurrency_storage_failure"
  | "diagnostic_failure";

export interface MaintenanceTelemetryIssue {
  fingerprint: string[];
  jobName: string;
  stepName: string;
  failureCategory: MaintenanceFailureCategory;
  failureClass: string;
  message: string;
  semanticStatus: MaintenanceSemanticStatus;
  exitCode?: number;
  hmLogPath?: string;
  hmExitPath?: string;
  artifactPaths?: string[];
  durationMs?: number;
  factsScanned?: number;
  factsChanged?: number;
  storedCount?: number;
  collapsedCount?: number;
  model?: string;
  fallbacks?: string[];
  guardFile?: string;
  guardStateBefore?: string;
  guardStateAfter?: string;
  lastSuccessAt?: string;
}

export function normalizeExitStepName(rawStep: string): string {
  return rawStep.startsWith("step=") ? rawStep.slice("step=".length) : rawStep;
}

/**
 * Parse an HM_EXIT file line.
 * Format: {ISO_TIMESTAMP} {step_name} exit={exit_code}
 * Example: 2024-05-08T02:15:30Z prune exit=0
 */
export function parseExitLine(line: string): ExitStep | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Legacy format: "<ts> <step> exit=<code>"
  // Extended format: "<ts> step=<step> exit=<code> status=<ok|failed|skipped> reason=<reason> duration_ms=<ms>"
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+((?:step=)?(\S+))\s+exit=(-?\d+)(?:\s+status=(ok|failed|skipped))?(?:\s+reason=(\S+))?(?:\s+duration_ms=(\d+))?\s*$/,
  );
  if (!match) return null;
  const step = normalizeExitStepName(match[2]);

  return {
    timestamp: match[1],
    step,
    exitCode: Number.parseInt(match[4], 10),
    line: trimmed,
    status: (match[5] as ExitStep["status"]) ?? undefined,
    reason: match[6] ?? undefined,
    durationMs: match[7] ? Number.parseInt(match[7], 10) : undefined,
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
  } catch (_err) {
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
function logContentIndicatesIntentionalFeatureSkip(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length === 0) return false;
  if (/\bjob was skipped\b/.test(lower)) return true;
  if (/\bskip(ped|ping)?\b.*\bhybrid[- ]memory\b.*\bconfig\b/.test(lower)) return true;
  if (/\bself[- ]correction\b.*\b(disabled|skipped)\b/.test(lower)) return true;
  if (/\breflection\b.*\b(disabled|skipped|enabled is false)\b/.test(lower)) return true;
  if (/\bnightly\s*cycle\b.*\b(disabled|skipped|enabled is false)\b/.test(lower)) return true;
  if (/\bsensor\s*sweep\b.*\b(disabled|skipped|enabled is false)\b/.test(lower)) return true;
  if (/\bpersona\s*proposals?\b.*\b(disabled|skipped|enabled is false)\b/.test(lower)) return true;
  if (/\bskip the script\b.*\b(disabled|reply)\b/.test(lower)) return true;
  return false;
}

export function logIndicatesIntentionalFeatureSkip(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  try {
    return logContentIndicatesIntentionalFeatureSkip(readFileSync(logPath, "utf-8"));
  } catch {
    return false;
  }
}

function checkUnknownCommandsInContent(content: string): string[] {
  const unknownCommands: string[] = [];
  for (const line of content.split("\n")) {
    // Match patterns like: "error: unknown command 'consolidate-episodes'"
    const match = line.match(/(?:error|Error):\s*unknown command\s+['"]([^'"]+)['"]/);
    if (match) {
      unknownCommands.push(match[1]);
    }
  }
  return unknownCommands;
}

export function checkForUnknownCommands(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  try {
    return checkUnknownCommandsInContent(readFileSync(logPath, "utf-8"));
  } catch {
    return [];
  }
}

interface DegradedVerificationStatus {
  reason?: string;
  machineLine: string;
}

function detectDegradedContinuousVerificationStatus(logContent: string): DegradedVerificationStatus | null {
  for (const line of logContent.split("\n")) {
    const marker = line.match(/Machine status:\s*(status=degraded\b.*)$/i);
    if (!marker) continue;
    const machineLine = marker[1].trim();
    const reasonMatch = machineLine.match(/\breason=([a-z_]+)/i);
    return {
      reason: reasonMatch?.[1]?.toLowerCase(),
      machineLine,
    };
  }
  return null;
}

const DREAM_CYCLE_CORE_STAGE_FAILED_RE = /memory-hybrid:\s*dream-cycle\s*[—-]\s*(?:stage\s+\d+\s+)?failed after \d+s:/i;
const DREAM_CYCLE_FINISHED_WITH_ERRORS_RE = /Dream cycle finished with errors:/i;
const DREAM_CYCLE_CORE_STAGE_FAILURES_RE = /Core stage failures:/i;
const DREAM_CYCLE_FOLLOW_UP_FAILURES_RE = /follow-up-failures=([1-9]\d*)/i;
const DREAM_CYCLE_FOLLOW_UP_FAILURE_LIST_RE = /Dream cycle follow-ups:\s*([1-9]\d*)\s+failure/i;
const DREAM_CYCLE_STATUS_LINE_RE = /Dream cycle status:\s*success=false\b/i;

function detectDreamCyclePipelineFailures(logContent: string): Array<{ step: string; reason: string; line: string }> {
  const failures: Array<{ step: string; reason: string; line: string }> = [];
  const pushUnique = (failure: { step: string; reason: string; line: string }) => {
    if (!failures.some((f) => f.step === failure.step && f.reason === failure.reason)) {
      failures.push(failure);
    }
  };
  if (
    DREAM_CYCLE_FINISHED_WITH_ERRORS_RE.test(logContent) ||
    DREAM_CYCLE_CORE_STAGE_FAILURES_RE.test(logContent) ||
    DREAM_CYCLE_STATUS_LINE_RE.test(logContent)
  ) {
    pushUnique({
      step: "dream-cycle-core",
      reason: "core_stage_failed",
      line: "Dream cycle core stages reported failures",
    });
  }
  for (const line of logContent.split("\n")) {
    if (DREAM_CYCLE_CORE_STAGE_FAILED_RE.test(line)) {
      pushUnique({
        step: "dream-cycle-core",
        reason: "core_stage_failed",
        line: line.trim(),
      });
      break;
    }
  }
  const followUpMatch = logContent.match(DREAM_CYCLE_FOLLOW_UP_FAILURES_RE);
  const followUpListMatch = logContent.match(DREAM_CYCLE_FOLLOW_UP_FAILURE_LIST_RE);
  if (followUpMatch || followUpListMatch) {
    pushUnique({
      step: "dream-cycle-follow-ups",
      reason: "follow_up_failed",
      line: followUpMatch?.[0] ?? followUpListMatch?.[0] ?? "follow-up failures detected",
    });
  }
  return failures;
}

function extractMaintenanceJobName(path: string | undefined): string {
  if (!path) return "unknown-job";
  const file = basename(path);
  const withoutExitSuffix = file.replace(/\.exit\.txt$/, "").replace(/\.log$/, "");
  return MAINTENANCE_JOB_SUFFIX_PATTERNS.reduce((jobName, pattern) => jobName.replace(pattern, ""), withoutExitSuffix);
}

function buildMaintenanceFingerprint(jobName: string, stepName: string, failureClass: string): string[] {
  return ["hybrid-memory-maintenance", jobName, stepName, failureClass];
}

function parsePositiveMetric(logContent: string, key: string): number | undefined {
  const match = logContent.match(new RegExp(`\\b${key}\\s*[=:]\\s*(\\d+)\\b`, "i"));
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseFallbacks(logContent: string): string[] | undefined {
  const match = logContent.match(/\bfallbacks\s*=\s*\[([^\]]*)\]/i);
  if (!match) return undefined;
  const fallbacks = match[1]
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return fallbacks.length > 0 ? fallbacks : [];
}

function parseModel(logContent: string): string | undefined {
  const modelMatch = logContent.match(/\bmodel\s*[=:]\s*([^\s,;]+)/i);
  if (modelMatch?.[1]) return modelMatch[1];
  const minimaxMatch = logContent.match(/\b(MiniMax-[^\s,;]+)/);
  return minimaxMatch?.[1];
}

function buildMaintenanceIssue(params: Omit<MaintenanceTelemetryIssue, "fingerprint">): MaintenanceTelemetryIssue {
  return {
    ...params,
    fingerprint: buildMaintenanceFingerprint(params.jobName, params.stepName, params.failureClass),
  };
}

function addMaintenanceIssue(issues: Map<string, MaintenanceTelemetryIssue>, issue: MaintenanceTelemetryIssue): void {
  const key = issue.fingerprint.join(":");
  if (!issues.has(key)) {
    issues.set(key, issue);
  }
}

/**
 * Extract log content relevant to a specific step.
 * Attempts to find step-scoped output by searching for the step name in the log.
 * Returns a substring of the log that's likely to contain output from that step.
 */
function extractStepLog(logContent: string, stepName: string): string {
  const lines = logContent.split("\n");
  const relevantLines: string[] = [];
  let foundStepMarker = false;

  for (const line of lines) {
    // Look for lines that mention the step name
    if (line.includes(stepName) || line.includes(stepName.replace(/-/g, "_"))) {
      foundStepMarker = true;
      relevantLines.push(line);
    } else if (foundStepMarker && relevantLines.length > 0) {
      // Collect subsequent lines until we hit another step or exceed reasonable context
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(line)) {
        // Hit a new timestamp line from HM_EXIT, stop collecting
        break;
      }
      relevantLines.push(line);
      if (relevantLines.length > 50) break; // Safety limit
    }
  }

  // Fallback: if we didn't find step-specific content, return full log for pattern matching
  return relevantLines.length > 0 ? relevantLines.join("\n") : logContent;
}

function collectMaintenanceTelemetryIssues(params: {
  exitPath: string;
  logPath?: string;
  requiredSteps: string[];
  logContent: string;
  failedSteps: ExitStep[];
  missingSteps: string[];
  unknownCommands: string[];
  maintenanceStatus: ExitValidationResult["maintenanceStatus"];
}): MaintenanceTelemetryIssue[] {
  const {
    exitPath,
    logPath,
    requiredSteps,
    logContent,
    failedSteps,
    missingSteps,
    unknownCommands,
    maintenanceStatus,
  } = params;
  const issues = new Map<string, MaintenanceTelemetryIssue>();
  const jobName = extractMaintenanceJobName(exitPath || logPath);
  const commonFields = {
    hmExitPath: exitPath,
    hmLogPath: logPath,
    guardStateAfter: maintenanceStatus === "success" ? "updated" : "not_updated",
  };

  for (const step of failedSteps) {
    // Extract step-scoped log output for better pattern matching
    const stepLog = extractStepLog(logContent, step.step);
    const lowerReason = (step.failureReason ?? step.reason ?? "").toLowerCase();
    const lowerStepLog = stepLog.toLowerCase();

    // Check log content for storage/concurrency patterns
    if (
      (lowerReason.includes("lancedb") && /commit|conflict|concurrent|vacuum|optimi/.test(lowerReason)) ||
      /concurrent maintenance mutation conflict/.test(lowerReason) ||
      (lowerStepLog.includes("lancedb") &&
        /commit.*conflict|concurrent.*mutation|vacuum.*conflict|optimi.*fail/i.test(stepLog)) ||
      /concurrent maintenance mutation conflict/i.test(stepLog)
    ) {
      addMaintenanceIssue(
        issues,
        buildMaintenanceIssue({
          ...commonFields,
          jobName,
          stepName: step.step,
          failureCategory: "concurrency_storage_failure",
          failureClass: "lancedb_commit_conflict",
          message: `${jobName}:${step.step} encountered a LanceDB maintenance conflict`,
          semanticStatus: "unknown",
          exitCode: step.exitCode,
          durationMs: step.durationMs,
        }),
      );
      continue;
    }
    if (
      /database is locked|sqlite_busy|db lock|lock timeout|timed out waiting for lock/.test(lowerReason) ||
      /database is locked|sqlite[_ ]busy|db[_ ]lock[_ ]timeout|timed out waiting for.*lock/i.test(stepLog)
    ) {
      addMaintenanceIssue(
        issues,
        buildMaintenanceIssue({
          ...commonFields,
          jobName,
          stepName: step.step,
          failureCategory: "concurrency_storage_failure",
          failureClass: "db_lock_timeout",
          message: `${jobName}:${step.step} hit a database lock or timeout`,
          semanticStatus: "unknown",
          exitCode: step.exitCode,
          durationMs: step.durationMs,
        }),
      );
      continue;
    }
    if (step.exitCode === 124 || /\btimeout\b/.test(lowerReason)) {
      addMaintenanceIssue(
        issues,
        buildMaintenanceIssue({
          ...commonFields,
          jobName,
          stepName: step.step,
          failureCategory: "mechanical_failure",
          failureClass: "timeout",
          message: `${jobName}:${step.step} timed out`,
          semanticStatus: "unknown",
          exitCode: step.exitCode,
          durationMs: step.durationMs,
        }),
      );
      continue;
    }
    if (step.exitCode === 137 || step.exitCode === 143 || /\boom\b|out of memory|sigkill|killed\b/.test(lowerReason)) {
      addMaintenanceIssue(
        issues,
        buildMaintenanceIssue({
          ...commonFields,
          jobName,
          stepName: step.step,
          failureCategory: "mechanical_failure",
          failureClass: "sigkill_or_oom",
          message: `${jobName}:${step.step} was killed or ran out of memory`,
          semanticStatus: "unknown",
          exitCode: step.exitCode,
          durationMs: step.durationMs,
        }),
      );
      continue;
    }
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: step.step,
        failureCategory: "mechanical_failure",
        failureClass: "nonzero_exit",
        message: `${jobName}:${step.step} exited non-zero`,
        semanticStatus: "unknown",
        exitCode: step.exitCode,
        durationMs: step.durationMs,
      }),
    );
  }

  for (const missingStep of missingSteps) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: missingStep,
        failureCategory: "mechanical_failure",
        failureClass: "missing_required_step",
        message: `${jobName}:${missingStep} was required but missing from the exit ledger`,
        semanticStatus: "unknown",
      }),
    );
  }

  for (const unknownCommand of unknownCommands) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "validate-cron-exit",
        failureCategory: "mechanical_failure",
        failureClass: "unknown_maintenance_command",
        message: `${jobName} invoked unknown maintenance command ${unknownCommand}`,
        semanticStatus: "unknown",
      }),
    );
  }

  const reflectRulesDetected =
    requiredSteps.includes("reflect-rules") ||
    /\breflect-rules\b/i.test(logContent) ||
    /\bparse_success\b/i.test(logContent);
  const reflectParseFailed = /\bparse[_\s-]?success\s*[=:]\s*(false|0)\b/i.test(logContent);
  const reflectStored = parsePositiveMetric(logContent, "stored");
  const reflectInsufficientPatterns = /\bzero_rules_reason\s*[=:]\s*insufficient_patterns\b/i.test(logContent);
  const reflectDegradedFlake =
    /\bzero_rules_reason\s*[=:]\s*invalid_response_format\b/i.test(logContent) &&
    /\bstatus\s*[=:]\s*degraded\b/i.test(logContent) &&
    (parsePositiveMetric(logContent, "model_response_chars") ?? 0) > 0;
  if (
    reflectRulesDetected &&
    (reflectParseFailed || reflectStored === 0) &&
    !reflectInsufficientPatterns &&
    !reflectDegradedFlake
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "reflect-rules",
        failureCategory: "semantic_failure",
        failureClass:
          reflectParseFailed && reflectStored === 0
            ? "invalid_response_format_zero_stored"
            : reflectParseFailed
              ? "reflect_rules_parse_failure"
              : "reflect_rules_zero_stored",
        message: `${jobName}:reflect-rules produced no usable rules despite a mechanically successful run`,
        semanticStatus: "semantic_fail",
        storedCount: reflectStored,
      }),
    );
  }

  const selfCorrectionDetected =
    requiredSteps.includes("self-correction-run") ||
    /\bself-correction-run\b/i.test(logContent) ||
    /\bfailed_suspect_zero_parsed\b/i.test(logContent);
  const selfCorrectionSuspect =
    /\bstatus=failed_suspect_zero_parsed\b/i.test(logContent) ||
    /\bzero parsed\/analysed remediation items\b/i.test(logContent);
  const selfCorrectionAnalysisFailed = /\bstatus=failed\b/i.test(logContent);
  const selfCorrectionParseFailed =
    /\bstatus=failed_parse\b/i.test(logContent) ||
    /\bstatus=failed_partial\b/i.test(logContent) ||
    (/\bparse_success=false\b/i.test(logContent) && /\bself-correction-run\b/i.test(logContent));
  const selfCorrectionIncidents = parsePositiveMetric(logContent, "incidents found");
  const selfCorrectionParsed =
    parsePositiveMetric(logContent, "parsed_candidates") ?? parsePositiveMetric(logContent, "analysed");
  if (
    selfCorrectionDetected &&
    (selfCorrectionSuspect ||
      selfCorrectionAnalysisFailed ||
      selfCorrectionParseFailed ||
      (typeof selfCorrectionIncidents === "number" && selfCorrectionIncidents > 0 && selfCorrectionParsed === 0))
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "self-correction-run",
        failureCategory: "semantic_failure",
        failureClass: /\bstatus=failed_partial\b/i.test(logContent)
          ? "self_correction_partial_batch_failure"
          : selfCorrectionAnalysisFailed
            ? "self_correction_analysis_failure"
            : /\bstatus=failed_parse\b/i.test(logContent) ||
                (/\bparse_success=false\b/i.test(logContent) && /\bself-correction-run\b/i.test(logContent))
              ? "self_correction_parse_failure"
              : "self_correction_zero_parsed",
        message: selfCorrectionAnalysisFailed
          ? `${jobName}:self-correction-run analysis failed before completing batches`
          : `${jobName}:self-correction-run found incidents but produced no parsed analysed items`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const generateProposalsDetected =
    requiredSteps.includes("generate-proposals") || /\bgenerate-proposals\b/i.test(logContent);
  const generateProposalsSemanticEmpty =
    /\bgenerate-proposals.*semantic_empty\b/i.test(logContent) ||
    (/\bgenerate-proposals\b/i.test(logContent) &&
      /\binsights?\b/i.test(logContent) &&
      /\bcreated:\s*0\b/i.test(logContent) &&
      /\bparse_success=false\b/i.test(logContent));
  if (generateProposalsDetected && generateProposalsSemanticEmpty) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "generate-proposals",
        failureCategory: "semantic_failure",
        failureClass: "generate_proposals_zero_created",
        message: `${jobName}:generate-proposals had insight input but created zero proposals`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const reinforcementDetected =
    requiredSteps.includes("extract-reinforcement") || /\bextract-reinforcement\b/i.test(logContent);
  const reinforcementDegraded =
    /\bdegraded_model_or_parser\b/i.test(logContent) || /\bstatus=degraded_model_or_parser\b/i.test(logContent);
  if (reinforcementDetected && reinforcementDegraded) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "extract-reinforcement",
        failureCategory: "semantic_failure",
        failureClass: "extract_reinforcement_parser_degraded",
        message: `${jobName}:extract-reinforcement LLM analysis degraded due to parser/model output issues`,
        semanticStatus: "degraded",
      }),
    );
  }

  const extractDailyDetected =
    requiredSteps.includes("extract-daily") || /\bextract-daily\b/i.test(logContent);
  const extractDailyVectorFailures = parsePositiveMetric(logContent, "vector_failures");
  if (extractDailyDetected && typeof extractDailyVectorFailures === "number" && extractDailyVectorFailures > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "extract-daily",
        failureCategory: "semantic_failure",
        failureClass: "extract_daily_vector_partial",
        message: `${jobName}:extract-daily stored facts but had ${extractDailyVectorFailures} vector failure(s)`,
        semanticStatus: "degraded",
      }),
    );
  }

  const extractProceduresDetected =
    requiredSteps.includes("extract-procedures") || /\bextract-procedures\b/i.test(logContent);
  const extractProceduresReadFailures = parsePositiveMetric(logContent, "readFailures");
  const extractProceduresReadFailureLog = /\bsession read failure\(s\)/i.test(logContent);
  if (
    extractProceduresDetected &&
    ((typeof extractProceduresReadFailures === "number" && extractProceduresReadFailures > 0) ||
      extractProceduresReadFailureLog)
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "extract-procedures",
        failureCategory: "semantic_failure",
        failureClass: "extract_procedures_read_failures",
        message: `${jobName}:extract-procedures had session read failure(s) and did not advance cursor safely`,
        semanticStatus: "degraded",
      }),
    );
  }

  const reflectDetected =
    requiredSteps.includes("reflect") ||
    (/\breflect\b/i.test(logContent) && /\bpatternsStored=\d+/i.test(logContent));
  const reflectEmbedFailuresMatch = logContent.match(/(\d+)\s+new-pattern embed failure\(s\)/i);
  const reflectEmbedFailures =
    reflectEmbedFailuresMatch != null ? Number.parseInt(reflectEmbedFailuresMatch[1] ?? "0", 10) : 0;
  const reflectSemanticPartial =
    /\breflect\b[\s\S]{0,120}\bsemantic=partial\b/i.test(logContent) ||
    (/\bpatternsStored=\d+/i.test(logContent) && /\bsemantic=partial\b/i.test(logContent));
  if (reflectDetected && (reflectEmbedFailures > 0 || reflectSemanticPartial)) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "reflect",
        failureCategory: "semantic_failure",
        failureClass: "reflect_embed_partial",
        message: `${jobName}:reflect had partial pattern embed failure(s) despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const reflectMetaDetected =
    requiredSteps.includes("reflect-meta") || /\breflect-meta\b/i.test(logContent);
  const reflectMetaStatusPartial =
    /\breflect-meta\b[\s\S]{0,120}\bstatus=(partial|degraded)\b/i.test(logContent) ||
    (/\bmetaStored=\d+/i.test(logContent) && /\bstatus=(partial|degraded)\b/i.test(logContent));
  const reflectMetaEmbedFailuresMatch = logContent.match(/reflect-meta — finished:[\s\S]*?(\d+) embed failure\(s\)/i);
  const reflectMetaEmbedFailures =
    reflectMetaEmbedFailuresMatch != null ? Number.parseInt(reflectMetaEmbedFailuresMatch[1] ?? "0", 10) : 0;
  const reflectMetaValidSkip =
    /\bzero_metas_reason\s*[=:]\s*valid_no_actionable_metas\b/i.test(logContent) ||
    /\bzero_metas_reason\s*[=:]\s*insufficient_patterns\b/i.test(logContent);
  if (
    reflectMetaDetected &&
    !reflectMetaValidSkip &&
    (reflectMetaStatusPartial || reflectMetaEmbedFailures > 0)
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "reflect-meta",
        failureCategory: "semantic_failure",
        failureClass: reflectMetaStatusPartial ? "reflect_meta_degraded" : "reflect_meta_embed_partial",
        message: `${jobName}:reflect-meta had partial meta-pattern storage despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const enrichEntitiesDetected =
    requiredSteps.includes("enrich-entities") ||
    requiredSteps.includes("enrich-entities-deep") ||
    /\benrich-entities(?:-deep)?\b/i.test(logContent);
  const enrichLlmFailures = parsePositiveMetric(logContent, "llmFailures");
  const enrichRemaining = parsePositiveMetric(logContent, "remaining");
  const enrichStopReasonIncomplete = /\bstopReason=(exhausted|time_budget|provider_budget)\b/i.test(logContent);
  const enrichSemanticPartial =
    /\benrich-entities\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    (/\bllmFailures=\d+/i.test(logContent) && /\bsemantic=partial\b/i.test(logContent));
  if (
    enrichEntitiesDetected &&
    ((typeof enrichLlmFailures === "number" && enrichLlmFailures > 0) ||
      enrichSemanticPartial ||
      (enrichStopReasonIncomplete && (enrichRemaining ?? 0) > 0))
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "enrich-entities",
        failureCategory: "semantic_failure",
        failureClass:
          typeof enrichLlmFailures === "number" && enrichLlmFailures > 0
            ? "enrich_entities_llm_failures"
            : "enrich_entities_incomplete_catchup",
        message: `${jobName}:enrich-entities had partial LLM enrichment or incomplete catch-up despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const consolidateDetected =
    requiredSteps.includes("consolidate") || /\bconsolidate\b/i.test(logContent);
  const consolidateClustersFailed = parsePositiveMetric(logContent, "clustersFailed");
  const consolidateVectorFailures = parsePositiveMetric(logContent, "vector_failures");
  const consolidateSemanticPartial =
    /\bconsolidate\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    (/\bclustersFailed=\d+/i.test(logContent) && /\bsemantic=partial\b/i.test(logContent));
  const consolidatePartialLog =
    /\bconsolidate LLM failed\b/i.test(logContent) ||
    /\bconsolidate embed failed\b/i.test(logContent) ||
    /\bconsolidate vector store failed\b/i.test(logContent);
  if (
    consolidateDetected &&
    ((typeof consolidateClustersFailed === "number" && consolidateClustersFailed > 0) ||
      (typeof consolidateVectorFailures === "number" && consolidateVectorFailures > 0) ||
      consolidateSemanticPartial ||
      consolidatePartialLog)
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "consolidate",
        failureCategory: "semantic_failure",
        failureClass:
          typeof consolidateClustersFailed === "number" && consolidateClustersFailed > 0
            ? "consolidate_cluster_failures"
            : "consolidate_vector_partial",
        message: `${jobName}:consolidate had partial cluster merge or vector failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const reflectIdentityDetected =
    requiredSteps.includes("reflect-identity") || /\breflect-identity\b/i.test(logContent);
  const reflectIdentitySemanticFailed =
    /\breflect-identity\b[\s\S]{0,160}\bsemantic=failed\b/i.test(logContent) ||
    (/\binsightsStored=\d+/i.test(logContent) && /\bsemantic=failed\b/i.test(logContent));
  const reflectIdentityLlmFailed = /\breflect-identity LLM failed\b/i.test(logContent);
  if (reflectIdentityDetected && (reflectIdentitySemanticFailed || reflectIdentityLlmFailed)) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "reflect-identity",
        failureCategory: "semantic_failure",
        failureClass: reflectIdentityLlmFailed ? "reflect_identity_llm_failure" : "reflect_identity_semantic_failed",
        message: `${jobName}:reflect-identity failed to produce usable identity insights despite a mechanically successful run`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const resolveContradictionsDetected =
    requiredSteps.includes("resolve-contradictions") || /\bresolve-contradictions\b/i.test(logContent);
  const resolveDegraded =
    /\bresolve-contradictions summary\b/i.test(logContent) &&
    /\bdegraded=1\b/i.test(logContent) &&
    /\bno_progress=1\b/i.test(logContent);
  if (resolveContradictionsDetected && resolveDegraded) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "resolve-contradictions",
        failureCategory: "semantic_failure",
        failureClass: "resolve_contradictions_degraded_backlog",
        message: `${jobName}:resolve-contradictions hit degraded ambiguous backlog with no auto-resolution progress`,
        semanticStatus: "degraded",
      }),
    );
  }

  const generateAutoSkillsDetected =
    requiredSteps.includes("generate-auto-skills") || /\bgenerate-auto-skills\b/i.test(logContent);
  const generateAutoSkillsFailedValidation = parsePositiveMetric(logContent, "failedValidation");
  const generateAutoSkillsFailedEval = parsePositiveMetric(logContent, "failedEval");
  if (
    generateAutoSkillsDetected &&
    ((typeof generateAutoSkillsFailedValidation === "number" && generateAutoSkillsFailedValidation > 0) ||
      (typeof generateAutoSkillsFailedEval === "number" && generateAutoSkillsFailedEval > 0))
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "generate-auto-skills",
        failureCategory: "semantic_failure",
        failureClass: "generate_auto_skills_validation_failures",
        message: `${jobName}:generate-auto-skills had skill validation or eval failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const scopePromoteDetected =
    requiredSteps.includes("scope-promote") ||
    /\bscope-promote\b/i.test(logContent) ||
    /\bscope promote\b/i.test(logContent);
  const scopePromoteFailed = parsePositiveMetric(logContent, "failed");
  const scopePromotePartial =
    /\bscope-promote\b[\s\S]{0,120}\bsemantic=partial\b/i.test(logContent) ||
    (/\bpromoted=\d+/i.test(logContent) && /\bfailed=\d+/i.test(logContent));
  if (
    scopePromoteDetected &&
    ((typeof scopePromoteFailed === "number" && scopePromoteFailed > 0) || scopePromotePartial)
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "scope-promote",
        failureCategory: "semantic_failure",
        failureClass: "scope_promote_partial",
        message: `${jobName}:scope-promote failed to promote one or more session facts`,
        semanticStatus: "degraded",
      }),
    );
  }

  const repairVectorsDetected =
    requiredSteps.includes("repair-vectors") || /\brepair-vectors\b/i.test(logContent);
  const repairOrphanCleanupFailed = parsePositiveMetric(logContent, "orphan_cleanup_failed");
  const repairVectorsPartial =
    /\brepair-vectors\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    (typeof repairOrphanCleanupFailed === "number" && repairOrphanCleanupFailed > 0);
  if (repairVectorsDetected && repairVectorsPartial) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "repair-vectors",
        failureCategory: "semantic_failure",
        failureClass: "repair_vectors_partial",
        message: `${jobName}:repair-vectors had re-embed or orphan cleanup failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const pruneDetected = requiredSteps.includes("prune") || /\bprune\b/i.test(logContent);
  const pruneVectorFailures = parsePositiveMetric(logContent, "vector_failures");
  if (pruneDetected && typeof pruneVectorFailures === "number" && pruneVectorFailures > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "prune",
        failureCategory: "semantic_failure",
        failureClass: "prune_vector_cleanup_partial",
        message: `${jobName}:prune had vector cleanup failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const extractDirectivesDetected =
    requiredSteps.includes("extract-directives") || /\bextract-directives\b/i.test(logContent);
  const extractDirectivesPartial =
    /\bextract-directives\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    /\bcursorBlockedReason=/i.test(logContent);
  if (extractDirectivesDetected && extractDirectivesPartial) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "extract-directives",
        failureCategory: "semantic_failure",
        failureClass: "extract_directives_partial",
        message: `${jobName}:extract-directives blocked cursor advance or had dedupe degradation`,
        semanticStatus: "degraded",
      }),
    );
  }

  const reembedVectorlessDetected =
    requiredSteps.includes("reembed-vectorless") || /\breembed-vectorless\b/i.test(logContent);
  const reembedStoreFailures = parsePositiveMetric(logContent, "storeFailures");
  const reembedPartial =
    /\breembed-vectorless\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    (typeof reembedStoreFailures === "number" && reembedStoreFailures > 0);
  if (reembedVectorlessDetected && reembedPartial) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "reembed-vectorless",
        failureCategory: "semantic_failure",
        failureClass: "reembed_vectorless_partial",
        message: `${jobName}:reembed-vectorless had vector store failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const distillDetected = requiredSteps.includes("distill") || /\bdistill\b/i.test(logContent);
  const distillBatchFailures = parsePositiveMetric(logContent, "batchFailures");
  const distillSemanticPartial =
    /\bdistill\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent) ||
    (typeof distillBatchFailures === "number" && distillBatchFailures > 0);
  if (distillDetected && distillSemanticPartial) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "distill",
        failureCategory: "semantic_failure",
        failureClass: "distill_partial_batch_failures",
        message: `${jobName}:distill had partial batch failures despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const extractImplicitDetected =
    requiredSteps.includes("extract-implicit") || /\bextract-implicit\b/i.test(logContent);
  const extractImplicitPartial = /\bextract-implicit\b[\s\S]{0,160}\bsemantic=partial\b/i.test(logContent);
  if (extractImplicitDetected && extractImplicitPartial) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "extract-implicit",
        failureCategory: "semantic_failure",
        failureClass: "extract_implicit_partial",
        message: `${jobName}:extract-implicit ended with partial session processing`,
        semanticStatus: "degraded",
      }),
    );
  }

  const continuousVerificationDetected =
    requiredSteps.includes("continuous-verification") || /\bcontinuous-verification\b/i.test(logContent);
  const continuousVerificationDegraded = detectDegradedContinuousVerificationStatus(logContent);
  if (continuousVerificationDetected && continuousVerificationDegraded) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "continuous-verification",
        failureCategory: "semantic_failure",
        failureClass: `continuous_verification_${continuousVerificationDegraded.reason ?? "degraded"}`,
        message: `${jobName}:continuous-verification reported degraded machine status`,
        semanticStatus: "degraded",
      }),
    );
  }

  const lifecycleSyncDetected =
    requiredSteps.includes("lifecycle-sync") || /\blifecycle-sync\b/i.test(logContent);
  const lifecycleSyncErrors = parsePositiveMetric(logContent, "sync_errors");
  if (lifecycleSyncDetected && typeof lifecycleSyncErrors === "number" && lifecycleSyncErrors > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "lifecycle-sync",
        failureCategory: "semantic_failure",
        failureClass: "lifecycle_sync_errors",
        message: `${jobName}:lifecycle-sync had ${lifecycleSyncErrors} sync error(s)`,
        semanticStatus: "degraded",
      }),
    );
  }

  const autoClassifyDetected =
    requiredSteps.includes("auto-classify") || /\bauto-classify\b/i.test(logContent);
  const autoClassifyBatchFailures = parsePositiveMetric(logContent, "batchFailures");
  if (autoClassifyDetected && typeof autoClassifyBatchFailures === "number" && autoClassifyBatchFailures > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "auto-classify",
        failureCategory: "semantic_failure",
        failureClass: "auto_classify_batch_failures",
        message: `${jobName}:auto-classify had ${autoClassifyBatchFailures} batch failure(s)`,
        semanticStatus: "degraded",
      }),
    );
  }

  const generateProposalsSemanticFail =
    /\bgenerate-proposals\b[\s\S]{0,120}\bsemantic=(failed|semantic_empty|partial)\b/i.test(logContent);
  if (generateProposalsDetected && generateProposalsSemanticFail) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "generate-proposals",
        failureCategory: "semantic_failure",
        failureClass: "generate_proposals_semantic_failure",
        message: `${jobName}:generate-proposals reported semantic failure despite a mechanically successful run`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const recordStorageDetected =
    requiredSteps.includes("record-storage-sample") || /\brecord-storage-sample\b/i.test(logContent);
  const recordStorageUnavailable =
    /\breason=storage_unavailable\b/i.test(logContent) ||
    /\bstatus=skipped_storage_unavailable\b/i.test(logContent);
  if (recordStorageDetected && recordStorageUnavailable) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "record-storage-sample",
        failureCategory: "semantic_failure",
        failureClass: "record_storage_unavailable",
        message: `${jobName}:record-storage-sample skipped because storage database was unavailable`,
        semanticStatus: "degraded",
      }),
    );
  }

  const analyzeLogsDetected =
    requiredSteps.includes("analyze-maintenance-logs") || /\banalyze-maintenance-logs\b/i.test(logContent);
  if (analyzeLogsDetected && /\bstrict=fail\b/i.test(logContent)) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "analyze-maintenance-logs",
        failureCategory: "semantic_failure",
        failureClass: "analyze_maintenance_logs_strict_fail",
        message: `${jobName}:analyze-maintenance-logs reported strict findings despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const passiveObserverDetected =
    requiredSteps.includes("passive-observer") || /\bpassive-observer\b/i.test(logContent);
  const passiveObserverErrors = parsePositiveMetric(logContent, "errors");
  if (
    passiveObserverDetected &&
    typeof passiveObserverErrors === "number" &&
    passiveObserverErrors > 0
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "passive-observer",
        failureCategory: "semantic_failure",
        failureClass: "passive_observer_errors",
        message: `${jobName}:passive-observer reported errors despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const closedLoopDetected =
    requiredSteps.includes("closed-loop-analysis") ||
    /\bclosed-loop-analysis\b/i.test(logContent) ||
    /memory-hybrid:\s*closed-loop\b/i.test(logContent);
  const closedLoopInterrupted =
    /\bclosed-loop-analysis interrupted\b/i.test(logContent) ||
    /memory-hybrid:\s*closed-loop\s*—\s*interrupted\b/i.test(logContent) ||
    (closedLoopDetected &&
      /\binterrupted\b/i.test(logContent) &&
      /\bsemantic=partial\b/i.test(logContent));
  if (closedLoopDetected && closedLoopInterrupted) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "closed-loop-analysis",
        failureCategory: "semantic_failure",
        failureClass: "closed_loop_analysis_interrupted",
        message: `${jobName}:closed-loop-analysis was interrupted despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const crossAgentDetected =
    requiredSteps.includes("cross-agent-learning") || /\bcross-agent-learning\b/i.test(logContent);
  const crossAgentLog = crossAgentDetected ? extractStepLog(logContent, "cross-agent-learning") : "";
  const crossAgentErrors =
    parsePositiveMetric(crossAgentLog, "errors") ??
    (() => {
      const match = crossAgentLog.match(/\bErrors:\s*(\d+)\b/);
      if (!match) return undefined;
      const value = Number.parseInt(match[1], 10);
      return Number.isFinite(value) ? value : undefined;
    })();
  if (crossAgentDetected && typeof crossAgentErrors === "number" && crossAgentErrors > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "cross-agent-learning",
        failureCategory: "semantic_failure",
        failureClass: "cross_agent_learning_errors",
        message: `${jobName}:cross-agent-learning reported batch errors despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const toolEffectivenessDetected =
    requiredSteps.includes("tool-effectiveness") || /\btool-effectiveness\b/i.test(logContent);
  if (toolEffectivenessDetected && /\bunexpected empty output\b/i.test(logContent)) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "tool-effectiveness",
        failureCategory: "semantic_failure",
        failureClass: "tool_effectiveness_empty_output",
        message: `${jobName}:tool-effectiveness produced no usable output despite a mechanically successful run`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const digestAutopilotDetected =
    requiredSteps.includes("digest-autopilot") ||
    /\bdigest-autopilot\b/i.test(logContent) ||
    /\bpending digest autopilot cron\b/i.test(logContent);
  const digestAutopilotSemanticFail =
    /\bdigest-autopilot\b[^\n]*\bstatus=(failed|partial)\b/i.test(logContent) ||
    /\bpending digest autopilot cron (failed|partial)\b/i.test(logContent) ||
    (digestAutopilotDetected &&
      /\bStatus:\s*(failed|partial)\b/i.test(logContent) &&
      /\bPending digest autopilot cron\b/i.test(logContent));
  if (digestAutopilotDetected && digestAutopilotSemanticFail) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "digest-autopilot",
        failureCategory: "semantic_failure",
        failureClass: "digest_autopilot_failed_status",
        message: `${jobName}:digest-autopilot reported failed or partial status despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const auditHealthDetected =
    requiredSteps.includes("audit-health") ||
    /\baudit-health\b/i.test(logContent) ||
    /\baudit health\b/i.test(logContent);
  const auditHealthSucceededInLedger = !failedSteps.some((s) => s.step === "audit-health");
  if (auditHealthDetected && auditHealthSucceededInLedger) {
    const extracted = extractAuditHealthJsonFromLog(logContent);
    if (extracted.kind === "ok") {
      const report = extracted.value;
      const warningCount =
        typeof report.warningCount === "number" ? Math.max(0, report.warningCount) : 0;
      const errorCount = typeof report.errorCount === "number" ? Math.max(0, report.errorCount) : 0;
      const reportExitCode = typeof report.exitCode === "number" ? report.exitCode : 0;
      const exitReason = typeof report.exitReason === "string" ? report.exitReason.trim() : "";
      if (
        warningCount > 0 ||
        errorCount > 0 ||
        report.ok === false ||
        reportExitCode !== 0 ||
        exitReason.startsWith("strict_")
      ) {
        addMaintenanceIssue(
          issues,
          buildMaintenanceIssue({
            ...commonFields,
            jobName,
            stepName: "audit-health",
            failureCategory: "semantic_failure",
            failureClass:
              exitReason === "strict_warnings" || exitReason === "strict_errors"
                ? exitReason
                : "audit_health_degraded_despite_success_exit",
            message: `${jobName}:audit-health reported degraded health despite a mechanically successful run`,
            semanticStatus: errorCount > 0 ? "semantic_fail" : "degraded",
          }),
        );
      }
    }
  }

  const sensorSweepDetected =
    requiredSteps.includes("sensor-sweep") || /\bsensor-sweep\b/i.test(logContent);
  const sensorSweepLog = sensorSweepDetected ? extractStepLog(logContent, "sensor-sweep") : "";
  const sensorSweepErrors = parsePositiveMetric(sensorSweepLog, "errors");
  if (sensorSweepDetected && typeof sensorSweepErrors === "number" && sensorSweepErrors > 0) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "sensor-sweep",
        failureCategory: "semantic_failure",
        failureClass: "sensor_sweep_errors",
        message: `${jobName}:sensor-sweep reported errors despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const crystallizationProposalsDetected =
    requiredSteps.includes("crystallization-proposals") || /\bcrystallization-proposals\b/i.test(logContent);
  const crystallizationStoresUnavailable =
    /\bcrystallization-proposals\b[\s\S]{0,200}\bstores unavailable\b/i.test(logContent) ||
    (crystallizationProposalsDetected && /\bstores-unavailable\b/i.test(logContent));
  if (crystallizationProposalsDetected && crystallizationStoresUnavailable) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "crystallization-proposals",
        failureCategory: "semantic_failure",
        failureClass: "crystallization_proposals_stores_unavailable",
        message: `${jobName}:crystallization-proposals could not access required stores despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const crystallizationRescanDetected =
    requiredSteps.includes("crystallization-rescan") || /\bcrystallization-rescan\b/i.test(logContent);
  const crystallizationRescanErrors = crystallizationRescanDetected
    ? parsePositiveMetric(extractStepLog(logContent, "crystallization-rescan"), "errors")
    : undefined;
  if (
    crystallizationRescanDetected &&
    typeof crystallizationRescanErrors === "number" &&
    crystallizationRescanErrors > 0
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "crystallization-rescan",
        failureCategory: "semantic_failure",
        failureClass: "crystallization_rescan_errors",
        message: `${jobName}:crystallization-rescan reported errors despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }

  const collapseScanned = parsePositiveMetric(logContent, "scanned") ?? parsePositiveMetric(logContent, "rows");
  const collapseCount = parsePositiveMetric(logContent, "collapsed") ?? parsePositiveMetric(logContent, "changed");
  const collapseDetected =
    /\bimplicit-feedback-collapse\b/i.test(logContent) ||
    /\bweekly-implicit-feedback-collapse\b/i.test(logContent);
  const collapseInterrupted =
    collapseDetected &&
    /\bimplicit-feedback-collapse interrupted\b/i.test(logContent) &&
    /\binterrupted=true\b/i.test(logContent);
  if (collapseInterrupted) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "implicit-feedback-collapse",
        failureCategory: "semantic_failure",
        failureClass: "implicit_feedback_collapse_interrupted",
        message: `${jobName}:implicit-feedback-collapse was interrupted despite a mechanically successful run`,
        semanticStatus: "degraded",
      }),
    );
  }
  if (
    collapseDetected &&
    typeof collapseScanned === "number" &&
    collapseScanned >= LARGE_BACKLOG_THRESHOLD &&
    collapseCount === 0
  ) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "implicit-feedback-collapse",
        failureCategory: "semantic_failure",
        failureClass: "implicit_feedback_large_backlog_zero_changes",
        message: `${jobName}:implicit-feedback-collapse scanned a large backlog but changed nothing`,
        semanticStatus: "degraded",
        factsScanned: collapseScanned,
        collapsedCount: 0,
        factsChanged: 0,
      }),
    );
  }

  const hiddenLlmFailure =
    /(?:llm call failed|failed its llm call|provider call failed|model request failed)/i.test(logContent) &&
    failedSteps.length === 0;
  if (hiddenLlmFailure) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: /persona-proposals/i.test(logContent) ? "persona-proposals" : "maintenance",
        failureCategory: "semantic_failure",
        failureClass: "hidden_llm_failure",
        message: `${jobName} logged an LLM failure without a matching non-zero exit`,
        semanticStatus: "semantic_fail",
        model: parseModel(logContent),
        fallbacks: parseFallbacks(logContent),
      }),
    );
  }

  if (/\bcursor(?:[_ ]advanced\s*=\s*false|\s+(?:did not|not)\s+advance)\b/i.test(logContent)) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "cursor",
        failureCategory: "semantic_failure",
        failureClass: "cursor_not_advanced",
        message: `${jobName} completed mechanically but did not advance its maintenance cursor`,
        semanticStatus: "semantic_fail",
      }),
    );
  }

  const finalAuditZeroByte =
    /(?:final-audit\.json|final audit)[^\n]*(?:0 bytes|0-byte|size=0|empty)/i.test(logContent) ||
    /final-audit\.json[^\n]*malformed/i.test(logContent);
  if (finalAuditZeroByte) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "audit",
        failureCategory: "mechanical_failure",
        failureClass: "missing_or_empty_required_artifact",
        message: `${jobName}:audit produced a missing, empty, or malformed final-audit.json artifact`,
        semanticStatus: "unknown",
        artifactPaths: ["final-audit.json"],
      }),
    );
  }

  const diagnosticsZeroByte =
    /memory-diagnostics-live\.json[^\n]*(?:0 bytes|0-byte|size=0|empty|malformed)/i.test(logContent) &&
    /incident bundle|vm memory incident/i.test(logContent);
  if (diagnosticsZeroByte) {
    addMaintenanceIssue(
      issues,
      buildMaintenanceIssue({
        ...commonFields,
        jobName,
        stepName: "diagnostics",
        failureCategory: "diagnostic_failure",
        failureClass: "zero_byte_memory_diagnostics",
        message: `${jobName}:diagnostics produced an incident bundle with unusable memory-diagnostics-live.json`,
        semanticStatus: "unknown",
        artifactPaths: ["memory-diagnostics-live.json"],
      }),
    );
  }

  return [...issues.values()];
}

function deriveSemanticStatus(
  maintenanceStatus: ExitValidationResult["maintenanceStatus"],
  issues: MaintenanceTelemetryIssue[],
): MaintenanceSemanticStatus {
  if (issues.some((issue) => issue.semanticStatus === "semantic_fail")) return "semantic_fail";
  if (issues.some((issue) => issue.semanticStatus === "degraded")) return "degraded";
  if (maintenanceStatus === "success" || maintenanceStatus === "skipped") return "ok";
  return issues.length > 0 ? "unknown" : "ok";
}

function combineSemanticStatus(
  summarySemantic: ExitValidationResult["semanticStatus"],
  maintenanceStatus: ExitValidationResult["maintenanceStatus"],
  issues: MaintenanceTelemetryIssue[],
): ExitValidationResult["semanticStatus"] {
  const derived = deriveSemanticStatus(maintenanceStatus, issues);
  const rank = (status: ExitValidationResult["semanticStatus"]) =>
    status === "semantic_fail" ? 3 : status === "degraded" ? 2 : status === "ok" ? 1 : 0;
  return rank(summarySemantic) >= rank(derived) ? summarySemantic : derived;
}

function isGuardBlockingSemanticIssue(issue: MaintenanceTelemetryIssue): boolean {
  if (issue.failureCategory !== "semantic_failure") return false;
  if (issue.failureClass === "hidden_llm_failure" || issue.failureClass === "cursor_not_advanced") {
    return true;
  }
  return (
    issue.stepName === "reflect-rules" ||
    issue.stepName === "self-correction-run" ||
    issue.stepName === "generate-proposals" ||
    issue.stepName === "extract-reinforcement" ||
    issue.stepName === "extract-daily" ||
    issue.stepName === "extract-procedures" ||
    issue.stepName === "reflect" ||
    issue.stepName === "reflect-meta" ||
    issue.stepName === "enrich-entities" ||
    issue.stepName === "enrich-entities-deep" ||
    issue.stepName === "consolidate" ||
    issue.stepName === "reflect-identity" ||
    issue.stepName === "resolve-contradictions" ||
    issue.stepName === "generate-auto-skills" ||
    issue.stepName === "scope-promote" ||
    issue.stepName === "repair-vectors" ||
    issue.stepName === "prune" ||
    issue.stepName === "extract-directives" ||
    issue.stepName === "reembed-vectorless" ||
    issue.stepName === "distill" ||
    issue.stepName === "extract-implicit" ||
    issue.stepName === "continuous-verification" ||
    issue.stepName === "lifecycle-sync" ||
    issue.stepName === "auto-classify" ||
    issue.stepName === "implicit-feedback-collapse" ||
    issue.stepName === "record-storage-sample" ||
    issue.stepName === "analyze-maintenance-logs" ||
    issue.stepName === "passive-observer" ||
    issue.stepName === "active-tasks-maintain" ||
    issue.stepName === "closed-loop-analysis" ||
    issue.stepName === "cross-agent-learning" ||
    issue.stepName === "tool-effectiveness" ||
    issue.stepName === "digest-autopilot" ||
    issue.stepName === "audit-health" ||
    issue.stepName === "crystallization-proposals" ||
    issue.stepName === "crystallization-rescan" ||
    issue.stepName === "sensor-sweep" ||
    issue.stepName === "maintenance" ||
    issue.stepName === "cursor" ||
    issue.stepName === "persona-proposals"
  );
}

function requiredStepsIncludeDreamPipeline(requiredSteps: string[]): boolean {
  return requiredSteps.some(
    (step) => step === "dream-cycle" || step === "dream-cycle-core" || step.startsWith("dream-cycle-"),
  );
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
    const reportableIssues = [
      buildMaintenanceIssue({
        jobName: extractMaintenanceJobName(exitPath),
        stepName: "validate-cron-exit",
        failureCategory: "mechanical_failure",
        failureClass: "missing_exit_ledger",
        message: `${extractMaintenanceJobName(exitPath)} is missing its HM_EXIT ledger`,
        semanticStatus: "unknown",
        hmExitPath: exitPath,
        hmLogPath: logPath,
        guardStateAfter: "not_updated",
      }),
    ];
    return {
      maintenanceStatus: "failed",
      semanticStatus: "unknown",
      steps: [],
      missingSteps: requiredSteps,
      failedSteps: [],
      guardUpdated: false,
      exitPath,
      logPath,
      error: `Exit ledger not found: ${exitPath}`,
      reportableIssues,
    };
  }

  // Read exit ledger
  const steps = readExitLedger(exitPath);

  // Read log content once for all log-based checks
  const logContent = logPath ? safeReadLog(logPath) : "";

  // Check for unknown commands in log
  const unknownCommands = logPath ? checkUnknownCommandsInContent(logContent) : [];
  if (unknownCommands.length > 0) {
    const reportableIssues = collectMaintenanceTelemetryIssues({
      exitPath,
      logPath,
      requiredSteps,
      logContent,
      failedSteps: [],
      missingSteps: requiredSteps,
      unknownCommands,
      maintenanceStatus: "failed",
    });
    return {
      maintenanceStatus: "failed",
      semanticStatus: deriveSemanticStatus("failed", reportableIssues),
      steps,
      missingSteps: requiredSteps,
      failedSteps: [],
      guardUpdated: false,
      exitPath,
      logPath,
      error: `Unknown command(s) detected: ${unknownCommands.join(", ")}`,
      reportableIssues,
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
  const skippedSteps: ExitStep[] = [];

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
    } else if (step.exitCode !== 0 || step.status === "failed") {
      failedSteps.push(step);
    } else if (
      allowSkip &&
      (step.status === "skipped" || step.reason === SKIP_REASON_COOLDOWN || step.reason === SKIP_REASON_CONCURRENCY)
    ) {
      skippedSteps.push(step);
    }
  }

  for (const step of failedSteps) {
    if (!step.failureReason && step.reason) step.failureReason = step.reason;
  }

  if (logPath && failedSteps.some((s) => s.step === "audit-health")) {
    for (const step of failedSteps) {
      if (step.step !== "audit-health") continue;
      const inferred = inferAuditHealthFailureReason(step.exitCode, logContent);
      step.failureReason = inferred.failureReason;
      step.strictFailureReason = inferred.strictFailureReason;
    }
  }

  if (logPath && requiredStepsIncludeDreamPipeline(requiredSteps)) {
    const dreamCycleTimestamp =
      stepMap.get("dream-cycle")?.timestamp ??
      stepMap.get("dream-cycle-core")?.timestamp ??
      SYNTHETIC_CONTINUOUS_VERIFICATION_TIMESTAMP;
    const degradedVerification = detectDegradedContinuousVerificationStatus(logContent);
    if (degradedVerification) {
      failedSteps.push({
        timestamp: dreamCycleTimestamp,
        step: "continuous-verification",
        exitCode: 2,
        line: degradedVerification.machineLine,
        failureReason: degradedVerification.reason ?? "degraded",
      });
    }
    const dreamCycleFailures = detectDreamCyclePipelineFailures(logContent);
    if (dreamCycleFailures.length > 0) {
      for (const failure of dreamCycleFailures) {
        failedSteps.push({
          timestamp: dreamCycleTimestamp,
          step: failure.step,
          exitCode: 2,
          line: failure.line,
          failureReason: failure.reason,
        });
      }
    }
  }

  // Determine overall status
  let maintenanceStatus: "success" | "skipped" | "partial" | "failed";

  if (missingSteps.length === 0 && failedSteps.length === 0) {
    // All required steps present and succeeded (exit=0).
    // Only mark as "skipped" if ALL required steps were skipped; otherwise treat as "success".
    // This prevents wasteful re-runs when only a subset of steps are skipped (e.g., cooldown).
    maintenanceStatus = skippedSteps.length > 0 && skippedSteps.length === requiredSteps.length ? "skipped" : "success";
  } else if (missingSteps.length === requiredSteps.length) {
    // Every required step absent — usually a hard failure (shell died before hm_step).
    // Exception: cron preambles that tell the agent to skip the whole script when a feature
    // is disabled leave an empty ledger; corroborate with HM_LOG text.
    if (
      logPath &&
      steps.length === 0 &&
      failedSteps.length === 0 &&
      logContentIndicatesIntentionalFeatureSkip(logContent)
    ) {
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

  let reportableIssues = collectMaintenanceTelemetryIssues({
    exitPath,
    logPath,
    requiredSteps,
    logContent,
    failedSteps,
    missingSteps,
    unknownCommands,
    maintenanceStatus,
  });
  if (maintenanceStatus === "success" && reportableIssues.some(isGuardBlockingSemanticIssue)) {
    maintenanceStatus = "failed";
    reportableIssues = collectMaintenanceTelemetryIssues({
      exitPath,
      logPath,
      requiredSteps,
      logContent,
      failedSteps,
      missingSteps,
      unknownCommands,
      maintenanceStatus,
    });
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
    const blockingSemanticIssues = reportableIssues.filter(isGuardBlockingSemanticIssue);
    if (blockingSemanticIssues.length > 0) {
      parts.push(
        `Semantic failures: ${blockingSemanticIssues
          .map((issue) => `${issue.stepName} (${issue.failureClass})`)
          .join(", ")}`,
      );
    }
    error = parts.join("; ");
  } else if (maintenanceStatus === "skipped") {
    error =
      skippedSteps.length > 0
        ? `Skipped steps: ${skippedSteps.map((s) => `${s.step}${s.reason ? ` (${s.reason})` : ""}`).join(", ")}`
        : "Feature-gated skip: no hm_step lines in HM_EXIT; log indicates disabled feature (guard not updated).";
  }

  return {
    maintenanceStatus,
    semanticStatus: deriveSemanticStatus(maintenanceStatus, reportableIssues),
    steps,
    missingSteps,
    failedSteps,
    guardUpdated,
    exitPath,
    logPath,
    error,
    reportableIssues,
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
      semanticStatus: validation.semanticStatus,
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
      reportableIssues: validation.reportableIssues.map((issue) => ({
        fingerprint: issue.fingerprint.join(":"),
        jobName: issue.jobName,
        stepName: issue.stepName,
        failureCategory: issue.failureCategory,
        failureClass: issue.failureClass,
        semanticStatus: issue.semanticStatus,
      })),
    },
    null,
    2,
  );
}

function buildValidationErrorMessage(
  maintenanceStatus: ExitValidationResult["maintenanceStatus"],
  missingSteps: string[],
  failedSteps: ExitStep[],
  reportableIssues: MaintenanceTelemetryIssue[],
): string | undefined {
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
    const blockingSemanticIssues = reportableIssues.filter(isGuardBlockingSemanticIssue);
    if (blockingSemanticIssues.length > 0) {
      parts.push(
        `Semantic failures: ${blockingSemanticIssues
          .map((issue) => `${issue.stepName} (${issue.failureClass})`)
          .join(", ")}`,
      );
    }
    return parts.join("; ");
  }
  return undefined;
}

/** Merge orchestrator summary validation with HM_EXIT ledger + HM_LOG pattern checks. */
function mergeSummaryWithLedgerChecks(
  summaryResult: Omit<ExitValidationResult, "error">,
  exitPath: string,
  logPath: string | undefined,
  requiredSteps: string[],
  allowSkip: boolean,
  isConsolidatedMode: boolean,
  summary: OrchestratorRunSummary,
): ExitValidationResult {
  let {
    maintenanceStatus,
    semanticStatus,
    steps,
    missingSteps,
    failedSteps,
    guardUpdated,
    reportableIssues = [],
  } = summaryResult;

  const logContent = logPath ? safeReadLog(logPath) : "";
  const unknownCommands = logPath ? checkUnknownCommandsInContent(logContent) : [];
  if (unknownCommands.length > 0) {
    const issues = collectMaintenanceTelemetryIssues({
      exitPath,
      logPath,
      requiredSteps,
      logContent,
      failedSteps,
      missingSteps,
      unknownCommands,
      maintenanceStatus: "failed",
    });
    return {
      maintenanceStatus: "failed",
      semanticStatus: deriveSemanticStatus("failed", issues),
      steps,
      missingSteps,
      failedSteps,
      guardUpdated: false,
      exitPath,
      logPath,
      error: `Unknown command(s) detected: ${unknownCommands.join(", ")}`,
      reportableIssues: issues,
    };
  }

  if (isConsolidatedMode && existsSync(exitPath)) {
    const ledgerSteps = readExitLedger(exitPath);
    const ledgerMap = new Map(ledgerSteps.map((s) => [s.step, s]));
    const wrapperMissing: string[] = [];
    const wrapperFailures: ExitStep[] = [];

    for (const required of requiredSteps) {
      const wrapper = ledgerMap.get(required);
      if (!wrapper) {
        wrapperMissing.push(required);
        continue;
      }
      if (
        wrapper.exitCode === 1 ||
        (wrapper.exitCode === 2 && !allowSkip) ||
        wrapper.status === "failed"
      ) {
        wrapperFailures.push(wrapper);
      }
      if ((wrapper.exitCode !== 0 || wrapper.status === "failed") && summary.exitCode === 0) {
        maintenanceStatus = "failed";
      }
    }

    if (wrapperFailures.length > 0) {
      maintenanceStatus = "failed";
      failedSteps = [...failedSteps, ...wrapperFailures.filter((s) => !failedSteps.some((f) => f.step === s.step))];
    } else if (wrapperMissing.length > 0 && maintenanceStatus === "success") {
      maintenanceStatus =
        wrapperMissing.length === requiredSteps.length
          ? "failed"
          : wrapperMissing.length > 0
            ? "partial"
            : maintenanceStatus;
      missingSteps = [...missingSteps, ...wrapperMissing.filter((m) => !missingSteps.includes(m))];
    }
  }

  const issueMap = new Map<string, MaintenanceTelemetryIssue>();
  for (const issue of reportableIssues) {
    addMaintenanceIssue(issueMap, issue);
  }
  const telemetryIssues = collectMaintenanceTelemetryIssues({
    exitPath,
    logPath,
    requiredSteps,
    logContent,
    failedSteps,
    missingSteps,
    unknownCommands: [],
    maintenanceStatus,
  });
  for (const issue of telemetryIssues) {
    addMaintenanceIssue(issueMap, issue);
  }
  reportableIssues = [...issueMap.values()];

  if (maintenanceStatus === "success" && reportableIssues.some(isGuardBlockingSemanticIssue)) {
    maintenanceStatus = "failed";
  }

  semanticStatus = combineSemanticStatus(semanticStatus, maintenanceStatus, reportableIssues);
  guardUpdated = maintenanceStatus === "success" && semanticStatus === "ok";

  return {
    maintenanceStatus,
    semanticStatus,
    steps,
    missingSteps,
    failedSteps,
    guardUpdated,
    exitPath,
    logPath,
    error: buildValidationErrorMessage(maintenanceStatus, missingSteps, failedSteps, reportableIssues),
    reportableIssues,
  };
}

/**
 * Validate maintenance run using orchestrator summary.json when available (#1877).
 * Falls back to HM_EXIT validation when summary is missing or invalid.
 */
export function validateFromSummaryJson(
  summaryPath: string,
  exitPath: string,
  logPath: string | undefined,
  requiredSteps: string[],
  allowSkip = false,
): ExitValidationResult {
  try {
    if (!existsSync(summaryPath)) {
      return validateMaintenanceExecution(exitPath, logPath, requiredSteps, allowSkip);
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as OrchestratorRunSummary;
    if (summary.schemaVersion !== 1 || !Array.isArray(summary.steps)) {
      return validateMaintenanceExecution(exitPath, logPath, requiredSteps, allowSkip);
    }

    const presentEarly = new Set(summary.steps.map((s) => s.name));
    const isConsolidatedEarly = requiredSteps.length > 0 && requiredSteps.every((name) => !presentEarly.has(name));
    if (isConsolidatedEarly && summary.steps.length === 0) {
      return validateMaintenanceExecution(exitPath, logPath, requiredSteps, allowSkip);
    }

    const resolveSummaryStepSemantic = (s: OrchestratorRunSummary["steps"][number]): string | undefined =>
      s.semanticOutcome ?? parseSemanticTokenFromSummary(s.summary);

    const stepFailed = (s: OrchestratorRunSummary["steps"][number]): boolean => {
      const semantic = resolveSummaryStepSemantic(s);
      if (s.name === "reflect-rules" && reflectRulesStepSummaryIndicatesFailure(s.summary)) return true;
      return s.status === "failed" || (semantic != null && semanticOutcomeBlocksOrchestratorGuard(semantic));
    };

    const stepExitCode = (s: OrchestratorRunSummary["steps"][number], failed: boolean): number => {
      if (failed) return 1;
      if (s.status === "deferred" || s.status === "rate_limited") return 2;
      return 0;
    };

    const stepExitStatus = (s: OrchestratorRunSummary["steps"][number], failed: boolean): ExitStep["status"] => {
      if (failed) return "failed";
      if (s.status === "ok") return "ok";
      if (s.status.startsWith("skipped")) return "skipped";
      if (s.status === "deferred" || s.status === "rate_limited") return "ok";
      return "failed";
    };

    const steps: ExitStep[] = summary.steps.map((s) => {
      const failed = stepFailed(s);
      const exitCode = stepExitCode(s, failed);
      return {
        timestamp: summary.finishedAt,
        step: s.name,
        exitCode,
        line: `${s.name} exit=${exitCode} status=${s.status} summary=${s.summary}`,
        status: stepExitStatus(s, failed),
        reason:
          s.name === "reflect-rules" && reflectRulesStepSummaryIndicatesFailure(s.summary)
            ? "failed"
            : (resolveSummaryStepSemantic(s) ?? s.status),
      };
    });

    const present = new Set(steps.map((s) => s.step));

    // Consolidated cron: requiredSteps are wrapper names (e.g., "maintenance-nightly")
    // while summary.steps are inner orchestrator steps (e.g., "distill", "prune").
    // Skip missing-step check when requiredSteps don't match any summary step names.
    const isConsolidatedMode = requiredSteps.length > 0 && requiredSteps.every((name) => !present.has(name));
    const missingSteps = isConsolidatedMode ? [] : requiredSteps.filter((name) => !present.has(name));
    const failedSteps = steps.filter(
      (s) =>
        (isConsolidatedMode || requiredSteps.includes(s.step)) &&
        (s.exitCode !== 0 || s.status === "failed"),
    );

    const semanticOutcomes = summary.steps
      .map((s) => resolveSemanticGuardToken(s.semanticOutcome ?? parseSemanticTokenFromSummary(s.summary)))
      .filter(Boolean) as JobRunSemanticOutcome[];
    let semanticStatus: ExitValidationResult["semanticStatus"] = "ok";
    if (semanticOutcomes.some((o) => jobRunOutcomeToValidatorSemantic(o) === "semantic_fail")) {
      semanticStatus = "semantic_fail";
    } else if (semanticOutcomes.some((o) => jobRunOutcomeToValidatorSemantic(o) === "degraded")) {
      semanticStatus = "degraded";
    }

    let maintenanceStatus: ExitValidationResult["maintenanceStatus"] = "success";
    if (missingSteps.length === requiredSteps.length && steps.length === 0) {
      maintenanceStatus = allowSkip ? "skipped" : "failed";
    } else if (failedSteps.length > 0 || summary.exitCode === 1) {
      maintenanceStatus = "failed";
    } else if (missingSteps.length > 0) {
      maintenanceStatus = "partial";
    } else if (summary.exitCode === 2) {
      maintenanceStatus = "success";
      semanticStatus = semanticStatus === "ok" ? "degraded" : semanticStatus;
    }

    if (maintenanceStatus === "success" && semanticStatus !== "ok") {
      const guardBlockingSemantic = summary.steps.some((s) => {
        const semantic = resolveSummaryStepSemantic(s);
        return (
          (isConsolidatedMode || requiredSteps.includes(s.name)) &&
          semantic != null &&
          semanticOutcomeBlocksOrchestratorGuard(semantic) &&
          !semanticOutcomeIsPartialFailure(semantic) &&
          isGuardBlockingSemanticIssue(
            buildMaintenanceIssue({
              jobName: summary.job ?? extractMaintenanceJobName(exitPath),
              stepName: s.name,
              failureCategory: "semantic_failure",
              failureClass: "orchestrator_step_failed",
              message: s.summary,
              semanticStatus: "semantic_fail",
              hmExitPath: exitPath,
              hmLogPath: logPath,
              guardStateAfter: "not_updated",
            }),
          )
        );
      });
      if (guardBlockingSemantic || failedSteps.length > 0) {
        maintenanceStatus = "failed";
      }
    }

    const guardBlockingDeferred = summary.steps.some(
      (s) =>
        (s.status === "deferred" || s.status === "rate_limited") &&
        (isConsolidatedMode || requiredSteps.includes(s.name)) &&
        isGuardBlockingSemanticIssue(
          buildMaintenanceIssue({
            jobName: summary.job ?? extractMaintenanceJobName(exitPath),
            stepName: s.name,
            failureCategory: "semantic_failure",
            failureClass: "orchestrator_step_deferred",
            message: s.summary,
            semanticStatus: "degraded",
            hmExitPath: exitPath,
            hmLogPath: logPath,
            guardStateAfter: "not_updated",
          }),
        ),
    );
    if (guardBlockingDeferred) {
      maintenanceStatus = "failed";
      semanticStatus = semanticStatus === "ok" ? "degraded" : semanticStatus;
    }

    return mergeSummaryWithLedgerChecks(
      {
        maintenanceStatus,
        semanticStatus,
        steps,
        missingSteps,
        failedSteps,
        guardUpdated: maintenanceStatus === "success" && semanticStatus === "ok",
        exitPath,
        logPath,
        reportableIssues: failedSteps.map((s) =>
          buildMaintenanceIssue({
            jobName: summary.job ?? extractMaintenanceJobName(exitPath),
            stepName: s.step,
            failureCategory: "semantic_failure",
            failureClass: "orchestrator_step_failed",
            message: s.line,
            semanticStatus: semanticStatus === "semantic_fail" ? "semantic_fail" : "degraded",
            hmExitPath: exitPath,
            hmLogPath: logPath,
            guardStateAfter: "not_updated",
          }),
        ),
      },
      exitPath,
      logPath,
      requiredSteps,
      allowSkip,
      isConsolidatedMode,
      summary,
    );
  } catch {
    return validateMaintenanceExecution(exitPath, logPath, requiredSteps, allowSkip);
  }
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

  const warningCount = typeof extracted.value.warningCount === "number" ? Math.max(0, extracted.value.warningCount) : 0;
  const errorCount = typeof extracted.value.errorCount === "number" ? Math.max(0, extracted.value.errorCount) : 0;

  if (exitCode === 2) {
    if (errorCount > 0) return { failureReason: "strict_errors" };
    if (warningCount > 0) return { failureReason: "strict_warnings" };
  }
  return { failureReason: "nonzero_exit" };
}
