import type { JobRunSemanticOutcome } from "./types.js";
import type { MaintenanceJobRun } from "./job-run.js";
import { MaintenanceJobRun as JobRunClass } from "./job-run.js";
import { finishBatchJobRun } from "./batch-job-run-bridge.js";

export type LightJobRunParams = {
  skipped?: boolean;
  dryRun?: boolean;
  semanticEmpty?: boolean;
  partialFailure?: boolean;
  inputsProcessed?: number;
  outputsProduced?: number;
  /** Concrete failure cause persisted into the job-run summary's semanticReason (#2024). */
  reason?: string;
};

export function resolveLightJobRunOutcome(params: LightJobRunParams): JobRunSemanticOutcome {
  if (params.skipped) return "skipped";
  if (params.dryRun) return "skipped";
  if (params.partialFailure) return "partial";
  if (params.semanticEmpty) return "failed_semantic_empty";
  const inputs = params.inputsProcessed ?? 0;
  const outputs = params.outputsProduced ?? 0;
  if (inputs === 0) return "empty";
  if (outputs === 0) return "empty";
  return "success";
}

export function createLightJobRun(command: string, inputFingerprint: string): MaintenanceJobRun {
  const jobRun = JobRunClass.create({ command, inputFingerprint });
  jobRun.startPhase("run");
  return jobRun;
}

export function finishLightJobRun(
  jobRun: MaintenanceJobRun | null,
  params: LightJobRunParams,
): { jobRunId?: string; semanticOutcome: JobRunSemanticOutcome } {
  const semanticOutcome = resolveLightJobRunOutcome(params);
  if (!jobRun) return { semanticOutcome };
  const phaseOk =
    semanticOutcome === "success" ||
    semanticOutcome === "empty" ||
    semanticOutcome === "skipped" ||
    semanticOutcome === "success_with_review";
  jobRun.endPhase("run", phaseOk ? "completed" : "failed");
  const jobRunId = finishBatchJobRun(jobRun, semanticOutcome, { clearCheckpoint: true, reason: params.reason });
  return { jobRunId, semanticOutcome };
}
