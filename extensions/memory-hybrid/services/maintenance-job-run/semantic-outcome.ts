import type { JobRunSemanticOutcome } from "./types.js";

/** Map self-correction CLI status to unified JobRun outcome. */
export function selfCorrectionStatusToJobRunOutcome(
  status: string | undefined,
): JobRunSemanticOutcome {
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

/** Map JobRun outcome to cron validator semantic class. */
export function jobRunOutcomeToValidatorSemantic(
  outcome: JobRunSemanticOutcome,
): "ok" | "degraded" | "semantic_fail" {
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
  if (!semantic || semantic === "-") return false;
  if (semantic === "partial" || semantic === "failed_partial") return true;
  return jobRunOutcomeFailsOrchestratorStep(semantic as JobRunSemanticOutcome);
}
