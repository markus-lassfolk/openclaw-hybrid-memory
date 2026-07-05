import type { JobRunSemanticOutcome } from "./types.js";

/** Raw self-correction CLI status tokens that may appear in orchestrator summary strings. */
const SELF_CORRECTION_CLI_STATUSES = new Set<string>([
  "success_analyzed",
  "success_no_incidents",
  "skipped_cooldown",
  "skipped_concurrency",
  "failed_partial",
  "failed_suspect_zero_parsed",
  "failed_parse",
  "failed",
]);

/** Map self-correction CLI status to unified JobRun outcome. */
export function selfCorrectionStatusToJobRunOutcome(status: string | undefined): JobRunSemanticOutcome {
  switch (status) {
    case "success_analyzed":
      return "success";
    case "success_no_incidents":
      return "empty";
    case "skipped_cooldown":
    case "skipped_concurrency":
      return "skipped";
    case "failed_partial":
      return "partial";
    case "failed_suspect_zero_parsed":
      return "failed_semantic_empty";
    case "failed_parse":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

/** Parse `semantic=` token from orchestrator step summary text. */
export function parseSemanticTokenFromSummary(summary: string): string | undefined {
  const semantic = summary.match(/\bsemantic=([\w_-]+)/)?.[1];
  return semantic && semantic !== "-" ? semantic : undefined;
}

/** Normalize unified outcomes and legacy CLI status tokens for guard/validation checks. */
export function resolveSemanticGuardToken(semantic: string | undefined): JobRunSemanticOutcome | undefined {
  if (!semantic || semantic === "-") return undefined;
  if (SELF_CORRECTION_CLI_STATUSES.has(semantic)) {
    return selfCorrectionStatusToJobRunOutcome(semantic);
  }
  return semantic as JobRunSemanticOutcome;
}

/** Map JobRun outcome to cron validator semantic class. */
export function jobRunOutcomeToValidatorSemantic(outcome: JobRunSemanticOutcome): "ok" | "degraded" | "semantic_fail" {
  switch (outcome) {
    case "success":
    case "empty":
    case "skipped":
      return "ok";
    case "success_with_review":
    case "partial":
    case "monitoring":
      return "degraded";
    case "failed":
    case "failed_semantic_empty":
      return "semantic_fail";
  }
}

/** Whether orchestrator step should be treated as failed based on nested JobRun outcome. */
export function jobRunOutcomeFailsOrchestratorStep(outcome: JobRunSemanticOutcome): boolean {
  return outcome === "failed" || outcome === "failed_semantic_empty";
}

/** Operational monitoring signals that should surface in telemetry but not abort nightly maintenance. */
export function semanticOutcomeIsMonitoringSignal(semantic: string | undefined): boolean {
  return resolveSemanticGuardToken(semantic) === "monitoring";
}

/** Whether a semantic token (unified outcome or legacy CLI status) blocks guard advancement. */
export function semanticOutcomeBlocksOrchestratorGuard(semantic: string | undefined): boolean {
  const resolved = resolveSemanticGuardToken(semantic);
  if (!resolved) return false;
  if (semanticOutcomeIsMonitoringSignal(semantic)) return false;
  if (resolved === "partial") return true;
  return jobRunOutcomeFailsOrchestratorStep(resolved);
}

/** Whether a resolved semantic outcome represents a partial batch/step failure. */
export function semanticOutcomeIsPartialFailure(semantic: string | undefined): boolean {
  return resolveSemanticGuardToken(semantic) === "partial";
}

function parseMetricFromMaintenanceSummary(summary: string, key: string): number | undefined {
  const match = summary.match(new RegExp(`\\b${key}=(-?\\d+)\\b`, "i"));
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Whether a reflect-rules orchestrator step summary indicates a semantic failure (mirrors HM_LOG checks). */
export function reflectRulesStepSummaryIndicatesFailure(summary: string): boolean {
  if (/\bzero_rules_reason=valid_no_actionable_rules\b/i.test(summary)) return false;
  if (/\bzero_rules_reason=insufficient_patterns\b/i.test(summary)) return false;
  // invalid_response_format is a genuine parse failure (the model responded but its output couldn't
  // be parsed), not a benign "nothing to extract" case — it must not be waved through as success (#2043).
  if (/\bstatus=ok\b/i.test(summary) && !/\bparse_success=false\b/i.test(summary)) return false;
  const parseFailed = /\bparse_success=false\b/i.test(summary);
  const rulesStored =
    parseMetricFromMaintenanceSummary(summary, "rulesStored") ?? parseMetricFromMaintenanceSummary(summary, "stored");
  return parseFailed || rulesStored === 0;
}
