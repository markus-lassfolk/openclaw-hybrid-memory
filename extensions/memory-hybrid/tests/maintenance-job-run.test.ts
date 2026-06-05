import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BATCH_CHECKPOINT_VERSION,
  createBatchCheckpointStore,
  createOffsetCheckpointStore,
  isBatchResumeCompatible,
  isOffsetResumeCompatible,
  MaintenanceJobRun,
  parseJobRunEvents,
  selfCorrectionStatusToJobRunOutcome,
  jobRunOutcomeFailsOrchestratorStep,
  semanticOutcomeBlocksOrchestratorGuard,
  resolveLightJobRunOutcome,
} from "../services/maintenance-job-run/index.js";

describe("maintenance-job-run", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and finishes a JobRun with summary and events", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "jobrun-"));
    const run = MaintenanceJobRun.create({
      command: "self-correction-run",
      inputFingerprint: "abc12345",
      logRoot: tmpDir,
      resumeCommand: "openclaw hybrid-mem self-correction run",
    });

    run.startPhase("extract");
    run.endPhase("extract", "completed", "incidents=3");
    run.startPhase("analyze");
    run.setProgress(1, 2, "batches");
    run.recordBatchComplete(0, 2);
    run.setSemanticOutcome("success");
    const record = run.finish({ clearCheckpoint: true });

    expect(record.jobRunId).toMatch(/^job-self-correction-run-/);
    expect(existsSync(run.summaryPath)).toBe(true);
    expect(record.semanticOutcome).toBe("success");
    expect(record.finishedAt).toBeTruthy();

    const events = parseJobRunEvents(readFileSync(run.eventsPath, "utf-8"));
    expect(events.some((e) => e.type === "phase_start" && e.phase === "extract")).toBe(true);
    expect(events.some((e) => e.type === "batch_complete")).toBe(true);
  });

  it("persists and resumes batch checkpoint state", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "jobrun-"));
    const checkpointPath = join(tmpDir, "checkpoint.json");
    const store = createBatchCheckpointStore<{ x: number }>(checkpointPath);

    store.save({
      version: BATCH_CHECKPOINT_VERSION,
      incidentsHash: "deadbeef",
      batchSize: 5,
      totalBatches: 2,
      completedBatchIndexes: [0],
      analysed: [{ x: 1 }],
      diagnostics: { retries: 1 },
      updatedAt: new Date().toISOString(),
    });

    const loaded = store.load();
    expect(isBatchResumeCompatible(loaded, "deadbeef", 5, 2)).toBe(true);
    expect(loaded?.completedBatchIndexes).toEqual([0]);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("offset checkpoint validates total match", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "jobrun-"));
    const store = createOffsetCheckpointStore(join(tmpDir, "offset.json"));
    store.save({ offset: 100, total: 500, migrated: 90, skipped: 10, ts: Date.now() });
    const loaded = store.load();
    expect(isOffsetResumeCompatible(loaded, 500)).toBe(true);
    expect(isOffsetResumeCompatible(loaded, 501)).toBe(false);
  });

  it("maps self-correction statuses to semantic outcomes", () => {
    expect(selfCorrectionStatusToJobRunOutcome("success_analyzed")).toBe("success");
    expect(selfCorrectionStatusToJobRunOutcome("success_no_incidents")).toBe("empty");
    expect(selfCorrectionStatusToJobRunOutcome("failed_partial")).toBe("partial");
    expect(selfCorrectionStatusToJobRunOutcome("failed_suspect_zero_parsed")).toBe("failed_semantic_empty");
    expect(jobRunOutcomeFailsOrchestratorStep("failed_semantic_empty")).toBe(true);
    expect(jobRunOutcomeFailsOrchestratorStep("success")).toBe(false);
    expect(semanticOutcomeBlocksOrchestratorGuard("partial")).toBe(true);
    expect(semanticOutcomeBlocksOrchestratorGuard("failed_partial")).toBe(true);
    expect(semanticOutcomeBlocksOrchestratorGuard("success")).toBe(false);
    expect(semanticOutcomeBlocksOrchestratorGuard(undefined)).toBe(false);
  });

  it("resolves light JobRun semantic outcomes", () => {
    expect(resolveLightJobRunOutcome({ semanticEmpty: true, inputsProcessed: 3 })).toBe("failed_semantic_empty");
    expect(resolveLightJobRunOutcome({ inputsProcessed: 0 })).toBe("empty");
    expect(resolveLightJobRunOutcome({ inputsProcessed: 2, outputsProduced: 1 })).toBe("success");
    expect(resolveLightJobRunOutcome({ skipped: true })).toBe("skipped");
  });

  it("loads JobRun from summary path", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "jobrun-"));
    const created = MaintenanceJobRun.create({
      command: "distill",
      inputFingerprint: "ff00aa11",
      logRoot: tmpDir,
    });
    created.setSemanticOutcome("empty", "no sessions");
    created.finish();

    const loaded = MaintenanceJobRun.load(created.summaryPath);
    expect(loaded?.jobRunId).toBe(created.jobRunId);
    expect(loaded?.record.semanticOutcome).toBe("empty");
  });
});

describe("parseMaintenanceResumeArgv", () => {
  it("parses known resume commands without shell", async () => {
    const { parseMaintenanceResumeArgv } = await import("../cli/commands/manage/register-maintenance-run.js");
    expect(parseMaintenanceResumeArgv("openclaw hybrid-mem self-correction run", "self-correction-run")).toEqual([
      "openclaw",
      "hybrid-mem",
      "self-correction",
      "run",
    ]);
    expect(parseMaintenanceResumeArgv(undefined, "extract-reinforcement")).toEqual([
      "openclaw",
      "hybrid-mem",
      "extract-reinforcement",
    ]);
    expect(parseMaintenanceResumeArgv("openclaw hybrid-mem storage re-index --resume", "storage re-index")).toEqual([
      "openclaw",
      "hybrid-mem",
      "storage",
      "re-index",
      "--resume",
    ]);
  });

  it("rejects shell metacharacters in resumeCommand", async () => {
    const { parseMaintenanceResumeArgv } = await import("../cli/commands/manage/register-maintenance-run.js");
    expect(() => parseMaintenanceResumeArgv("openclaw hybrid-mem distill; rm -rf /", "distill")).toThrow(
      /Unsafe or unsupported resume command/,
    );
  });
});
