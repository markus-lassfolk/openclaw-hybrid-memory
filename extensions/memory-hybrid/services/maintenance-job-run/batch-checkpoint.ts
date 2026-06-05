import type { CheckpointStore } from "./checkpoint-store.js";
import { createFileCheckpointStore } from "./checkpoint-store.js";
import type { BatchCheckpointState } from "./types.js";
import { nowIso } from "../../utils/dates.js";

export const BATCH_CHECKPOINT_VERSION = 1;

export function createBatchCheckpointStore<TItem>(path: string): CheckpointStore<BatchCheckpointState<TItem>> {
  const store = createFileCheckpointStore<BatchCheckpointState<TItem>>(path);
  return {
    path,
    load(): BatchCheckpointState<TItem> | null {
      const raw = store.load();
      if (!raw) return null;
      if (raw.version !== BATCH_CHECKPOINT_VERSION) return null;
      if (typeof raw.incidentsHash !== "string") return null;
      if (!Array.isArray(raw.completedBatchIndexes) || !Array.isArray(raw.analysed)) return null;
      return raw;
    },
    save(state: BatchCheckpointState<TItem>): void {
      store.save({ ...state, version: BATCH_CHECKPOINT_VERSION, updatedAt: nowIso() });
    },
    clear(): void {
      store.clear();
    },
  };
}

export function isBatchResumeCompatible<TItem>(
  state: BatchCheckpointState<TItem> | null,
  fingerprint: string,
  batchSize: number,
  totalBatches: number,
): state is BatchCheckpointState<TItem> {
  if (!state) return false;
  return state.incidentsHash === fingerprint && state.batchSize === batchSize && state.totalBatches === totalBatches;
}
