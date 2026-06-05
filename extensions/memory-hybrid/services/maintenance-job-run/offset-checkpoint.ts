import type { CheckpointStore } from "./checkpoint-store.js";
import { createFileCheckpointStore } from "./checkpoint-store.js";
import type { OffsetCheckpointState } from "./types.js";

export function createOffsetCheckpointStore(path: string): CheckpointStore<OffsetCheckpointState> {
  const store = createFileCheckpointStore<OffsetCheckpointState>(path);
  return {
    path,
    load(): OffsetCheckpointState | null {
      const raw = store.load();
      if (!raw) return null;
      if (!Number.isFinite(raw.offset) || !Number.isFinite(raw.total)) return null;
      return raw;
    },
    save(state: OffsetCheckpointState): void {
      store.save({ ...state, ts: Date.now() });
    },
    clear(): void {
      store.clear();
    },
  };
}

export function isOffsetResumeCompatible(
  state: OffsetCheckpointState | null,
  total: number,
): state is OffsetCheckpointState {
  if (!state) return false;
  return state.total === total;
}
