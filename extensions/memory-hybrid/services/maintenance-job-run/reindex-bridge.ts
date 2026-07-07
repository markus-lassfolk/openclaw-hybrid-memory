import { existsSync, readFileSync } from "node:fs";
import type { ReindexCheckpoint } from "../../cli/commands/manage/storage-stats-helpers.js";
import type { MaintenanceJobRun } from "./job-run.js";
import { createOffsetCheckpointStore } from "./offset-checkpoint.js";
import type { OffsetCheckpointState } from "./types.js";

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

/**
 * `legacyPath` is intentionally NOT auto-imported here (see #reindex-bridge deferred note): the
 * sole caller (`storage re-index`) already reads and validates that same legacy file itself
 * (total match, `--resume` gating, offset-vs-fresh-shadow-table safety) via its own
 * `resumeCheckpoint` fallback in `checkpoint.load()`. Auto-importing it into this job-run's own
 * checkpoint store unconditionally would silently overwrite a fresh/native checkpoint with a
 * stale, unvalidated one and short-circuit that caller-side validation entirely.
 */
export function createReindexJobRunCheckpointAdapter(jobRun: MaintenanceJobRun): {
  load: () => { offset: number } | null;
  save: (state: { offset: number; total: number; migrated: number; skipped: number; ts: number }) => void;
  clear: () => void;
} {
  const store = createOffsetCheckpointStore(jobRun.checkpointPath);
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
