import type { MaintenanceJobRun } from "./job-run.js";
import { selfCorrectionStatusToJobRunOutcome } from "./semantic-outcome.js";
import {
  finishBatchJobRun,
  loadBatchJobResume,
  persistBatchJobState,
  removeLegacyBatchState,
  type LegacyBatchState,
} from "./batch-job-run-bridge.js";

/** @deprecated Use LegacyBatchState */
export type LegacySelfCorrectionBatchState<TItem> = LegacyBatchState<TItem>;

export const loadSelfCorrectionBatchResume = loadBatchJobResume;
export const persistSelfCorrectionBatchState = persistBatchJobState;
export const removeLegacySelfCorrectionState = removeLegacyBatchState;

export function finishSelfCorrectionJobRun(
  jobRun: MaintenanceJobRun | null,
  status: string | undefined,
  options?: { clearCheckpoint?: boolean },
): string | undefined {
  if (!jobRun) return undefined;
  return finishBatchJobRun(jobRun, selfCorrectionStatusToJobRunOutcome(status), options);
}
