export {
  loadBatchJobResume as loadReinforcementBatchResume,
  persistBatchJobState as persistReinforcementBatchState,
  finishBatchJobRun as finishReinforcementJobRun,
  removeLegacyBatchState as removeLegacyReinforcementState,
} from "./batch-job-run-bridge.js";

import type { JobRunSemanticOutcome } from "./types.js";

/** Map extract-reinforcement run signals to unified JobRun outcome. */
export function reinforcementRunToJobRunOutcome(opts: {
  skipped?: boolean;
  partialBatchFailure?: boolean;
  llmAnalysisFailed?: boolean;
  incidentsCount: number;
  analysedCount: number;
  annotated?: number;
}): JobRunSemanticOutcome {
  if (opts.skipped) return "skipped";
  if (opts.partialBatchFailure) return "partial";
  if (opts.incidentsCount === 0) return "empty";
  if (opts.llmAnalysisFailed) return "failed";
  if (opts.annotated !== undefined && opts.annotated === 0 && opts.incidentsCount > 0 && opts.analysedCount > 0) {
    return "success_with_review";
  }
  if (opts.incidentsCount > 0 && opts.analysedCount === 0) return "failed_semantic_empty";
  return "success";
}
