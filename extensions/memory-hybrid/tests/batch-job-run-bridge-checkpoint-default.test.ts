/**
 * loop iteration 98 regression: finishBatchJobRun's default checkpoint-clear rule must delegate
 * to MaintenanceJobRun.finish()'s own default (an allowlist: clear only on success/empty/skipped)
 * instead of re-deriving its own, divergent denylist (clear unless partial/failed/
 * failed_semantic_empty). The two disagreed for "monitoring"/"success_with_review" -- the
 * denylist would discard resumable progress that finish()'s own default preserves.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BATCH_CHECKPOINT_VERSION,
  createBatchCheckpointStore,
} from "../services/maintenance-job-run/batch-checkpoint.js";
import { finishBatchJobRun } from "../services/maintenance-job-run/batch-job-run-bridge.js";
import { MaintenanceJobRun } from "../services/maintenance-job-run/job-run.js";

describe("finishBatchJobRun checkpoint-clear default (loop iteration 98 regression)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedJobRunWithCheckpoint(command: string): MaintenanceJobRun {
    tmpDir = mkdtempSync(join(tmpdir(), "batch-job-run-checkpoint-default-"));
    const jobRun = MaintenanceJobRun.create({
      command,
      inputFingerprint: "abc12345",
      logRoot: tmpDir,
      resumeCommand: `openclaw hybrid-mem ${command} --resume`,
    });
    createBatchCheckpointStore<{ x: number }>(jobRun.checkpointPath).save({
      version: BATCH_CHECKPOINT_VERSION,
      incidentsHash: "deadbeef",
      batchSize: 5,
      totalBatches: 2,
      completedBatchIndexes: [0],
      analysed: [{ x: 1 }],
      diagnostics: {},
      updatedAt: new Date().toISOString(),
    });
    expect(existsSync(jobRun.checkpointPath)).toBe(true);
    return jobRun;
  }

  it("preserves the checkpoint for a 'monitoring' outcome when clearCheckpoint is omitted", () => {
    const jobRun = seedJobRunWithCheckpoint("test-monitoring");
    finishBatchJobRun(jobRun, "monitoring");
    expect(existsSync(jobRun.checkpointPath)).toBe(true);
  });

  it("preserves the checkpoint for a 'success_with_review' outcome when clearCheckpoint is omitted", () => {
    const jobRun = seedJobRunWithCheckpoint("test-success-with-review");
    finishBatchJobRun(jobRun, "success_with_review");
    expect(existsSync(jobRun.checkpointPath)).toBe(true);
  });

  it("still clears the checkpoint for a plain 'success' outcome (no regression)", () => {
    const jobRun = seedJobRunWithCheckpoint("test-success");
    finishBatchJobRun(jobRun, "success");
    expect(existsSync(jobRun.checkpointPath)).toBe(false);
  });

  it("still preserves the checkpoint for a 'partial' outcome (no regression)", () => {
    const jobRun = seedJobRunWithCheckpoint("test-partial");
    finishBatchJobRun(jobRun, "partial");
    expect(existsSync(jobRun.checkpointPath)).toBe(true);
  });

  it("an explicit clearCheckpoint still wins over both defaults", () => {
    const jobRun = seedJobRunWithCheckpoint("test-explicit-clear");
    finishBatchJobRun(jobRun, "monitoring", { clearCheckpoint: true });
    expect(existsSync(jobRun.checkpointPath)).toBe(false);
  });
});
