import { existsSync, readFileSync } from "node:fs";
import type { OffsetCheckpointState } from "./types.js";
import { createOffsetCheckpointStore } from "./offset-checkpoint.js";
import type { MaintenanceJobRun } from "./job-run.js";
import type { ReindexCheckpoint } from "../../cli/commands/manage/storage-stats-helpers.js";

export function importLegacyReindexCheckpoint(
  jobRun: MaintenanceJobRun,
  legacyPath: string,
): OffsetCheckpointState | null {
  if (!existsSync(legacyPath)) return null;
  try {
    const legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as ReindexCheckpoint;
    if (!Number.isFinite(legacy.offset) || !Number.isFinite(legacy.total)) return null;
    const state: OffsetCheckpointState = {
      offset: legacy.offset,
      total: legacy.total,
      migrated: legacy.migrated,
      skipped: legacy.skipped,
      ts: legacy.ts,
    };
    createOffsetCheckpointStore(jobRun.checkpointPath).save(state);
    return state;
  } catch {
    return null;
  }
}

export function offsetCheckpointToReindex(state: OffsetCheckpointState): ReindexCheckpoint {
  return {
    offset: state.offset,
    total: state.total,
    migrated: state.migrated,
    skipped: state.skipped,
    ts: state.ts,
  };
}

export function createReindexJobRunCheckpointAdapter(
  jobRun: MaintenanceJobRun,
  legacyPath?: string,
): {
  load: () => { offset: number } | null;
  save: (state: { offset: number; total: number; migrated: number; skipped: number; ts: number }) => void;
  clear: () => void;
} {
  const store = createOffsetCheckpointStore(jobRun.checkpointPath);
  if (legacyPath) {
    importLegacyReindexCheckpoint(jobRun, legacyPath);
  }
  return {
    load: () => {
      const state = store.load();
      return state ? { offset: state.offset } : null;
    },
    save: (state) => {
      store.save({
        offset: state.offset,
        total: state.total,
        migrated: state.migrated,
        skipped: state.skipped,
        ts: state.ts,
      });
      jobRun.setProgress(state.offset, state.total, "facts");
    },
    clear: () => store.clear(),
  };
}
