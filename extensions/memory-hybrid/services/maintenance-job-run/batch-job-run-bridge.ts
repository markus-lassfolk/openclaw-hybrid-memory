import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BatchCheckpointState, JobRunSemanticOutcome } from "./types.js";
import { BATCH_CHECKPOINT_VERSION, createBatchCheckpointStore, isBatchResumeCompatible } from "./batch-checkpoint.js";
import type { MaintenanceJobRun } from "./job-run.js";
import { nowIso } from "../../utils/dates.js";

export type LegacyBatchState<TItem> = {
  version: number;
  incidentsHash: string;
  batchSize: number;
  totalBatches: number;
  completedBatchIndexes: number[];
  analysed: TItem[];
  diagnostics: Record<string, number>;
  updatedAt: string;
};

export function legacyBatchStateToCheckpoint<TItem>(legacy: LegacyBatchState<TItem>): BatchCheckpointState<TItem> {
  return {
    version: BATCH_CHECKPOINT_VERSION,
    incidentsHash: legacy.incidentsHash,
    batchSize: legacy.batchSize,
    totalBatches: legacy.totalBatches,
    completedBatchIndexes: legacy.completedBatchIndexes,
    analysed: legacy.analysed,
    diagnostics: legacy.diagnostics,
    updatedAt: legacy.updatedAt,
  };
}

export function loadBatchJobResume<TItem>(
  jobRun: MaintenanceJobRun,
  legacyStatePath: string | null,
  fingerprint: string,
  batchSize: number,
  totalBatches: number,
  legacyVersion = 1,
): BatchCheckpointState<TItem> | null {
  const store = createBatchCheckpointStore<TItem>(jobRun.checkpointPath);
  let state = store.load();
  if (isBatchResumeCompatible(state, fingerprint, batchSize, totalBatches)) {
    return state;
  }

  if (legacyStatePath && existsSync(legacyStatePath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyStatePath, "utf-8")) as LegacyBatchState<TItem>;
      if (
        legacy.version === legacyVersion &&
        legacy.incidentsHash === fingerprint &&
        legacy.batchSize === batchSize &&
        legacy.totalBatches === totalBatches
      ) {
        state = legacyBatchStateToCheckpoint(legacy);
        store.save(state);
        return state;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function persistBatchJobState<TItem>(
  jobRun: MaintenanceJobRun,
  state: Omit<BatchCheckpointState<TItem>, "version" | "updatedAt">,
): void {
  const store = createBatchCheckpointStore<TItem>(jobRun.checkpointPath);
  store.save({
    ...state,
    version: BATCH_CHECKPOINT_VERSION,
    updatedAt: nowIso(),
  });
  jobRun.setProgress(state.completedBatchIndexes.length, state.totalBatches, "batches");
  jobRun.setDiagnostics(state.diagnostics);
}

export function finishBatchJobRun(
  jobRun: MaintenanceJobRun | null,
  outcome: JobRunSemanticOutcome,
  options?: { clearCheckpoint?: boolean; reason?: string },
): string | undefined {
  if (!jobRun) return undefined;
  jobRun.setSemanticOutcome(outcome, options?.reason);
  const clearCheckpoint =
    options?.clearCheckpoint ?? (outcome !== "partial" && outcome !== "failed" && outcome !== "failed_semantic_empty");
  jobRun.finish({ clearCheckpoint });
  return jobRun.jobRunId;
}

export function removeLegacyBatchState(stateDir: string, fingerprint: string, prefix: string): void {
  const legacyPath = join(stateDir, `${prefix}${fingerprint}.json`);
  if (!existsSync(legacyPath)) return;
  try {
    rmSync(legacyPath, { force: true });
  } catch {
    /* best-effort */
  }
}
