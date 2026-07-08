/**
 * loop iteration 94 regression: createReindexJobRunCheckpointAdapter must never let a stale
 * legacy-format checkpoint file silently overwrite a fresh job-run's own native checkpoint
 * state. The fix removed the `legacyPath` auto-import entirely from the adapter's constructor
 * (the caller, `storage re-index` in register-storage-maintenance.ts, already reads and
 * validates that same legacy file itself via its own --resume-gated `resumeCheckpoint` logic).
 *
 * Calling the adapter with a 2nd `legacyPath` argument (via a permissive cast) exercises the
 * pre-fix call shape at runtime -- extra JS call arguments are simply ignored by a function that
 * no longer declares that parameter, so this same test call reproduces the bug against the
 * pre-fix implementation (git-stash) and demonstrates the fix against the current one.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOffsetCheckpointStore, MaintenanceJobRun } from "../services/maintenance-job-run/index.js";
import { createReindexJobRunCheckpointAdapter } from "../services/maintenance-job-run/reindex-bridge.js";

describe("createReindexJobRunCheckpointAdapter (loop iteration 94 regression)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not let a stale legacy checkpoint file silently overwrite a fresh job-run's own native checkpoint", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reindex-bridge-"));
    const jobRun = MaintenanceJobRun.create({
      command: "storage-re-index",
      inputFingerprint: "500-50-0.95",
      logRoot: tmpDir,
      resumeCommand: "openclaw hybrid-mem storage re-index --resume",
    });

    // The job-run's own native checkpoint already has valid, freshly-saved progress from an
    // earlier interrupted run under this exact fingerprint.
    createOffsetCheckpointStore(jobRun.checkpointPath).save({
      offset: 10,
      total: 500,
      migrated: 10,
      skipped: 0,
      ts: Date.now(),
    });

    // A stale, incompatible legacy-format checkpoint (different total entirely) sits at a
    // separate path -- mirroring what register-storage-maintenance.ts used to also pass in as
    // `legacyPath` before the fix removed that parameter.
    const legacyPath = join(tmpDir, ".reindex_checkpoint.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({ offset: 999, total: 999_999, migrated: 999, skipped: 0, ts: Date.now() }),
    );

    const legacyAdapterCall = createReindexJobRunCheckpointAdapter as unknown as (
      jobRun: MaintenanceJobRun,
      legacyPath?: string,
    ) => ReturnType<typeof createReindexJobRunCheckpointAdapter>;
    const adapter = legacyAdapterCall(jobRun, legacyPath);

    expect(adapter.load()).toEqual({ offset: 10 });
  });
});
