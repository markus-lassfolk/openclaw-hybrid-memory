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
  const semantic = summary.match(/\bsemantic=([^\s]+)/)?.[1];
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

/** Whether a semantic token (unified outcome or legacy CLI status) blocks guard advancement. */
export function semanticOutcomeBlocksOrchestratorGuard(semantic: string | undefined): boolean {
  const resolved = resolveSemanticGuardToken(semantic);
  if (!resolved) return false;
  if (resolved === "partial") return true;
  return jobRunOutcomeFailsOrchestratorStep(resolved);
}

/** Whether a resolved semantic outcome represents a partial batch/step failure. */
export function semanticOutcomeIsPartialFailure(semantic: string | undefined): boolean {
  return resolveSemanticGuardToken(semantic) === "partial";
}
