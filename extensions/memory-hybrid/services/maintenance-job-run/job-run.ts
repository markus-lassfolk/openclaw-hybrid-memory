import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import { nowIso } from "../../utils/dates.js";
import {
  buildJobRunId,
  resolveJobRunArtifactDir,
  resolveOrchestratorRunIdFromEnv,
} from "./artifact-paths.js";
import { appendJobRunEvent } from "./event-log.js";
import { createFileCheckpointStore, type CheckpointStore } from "./checkpoint-store.js";
import type {
  JobRunEvent,
  JobRunPhaseStatus,
  JobRunSemanticOutcome,
  MaintenanceJobRunRecord,
} from "./types.js";
import { JOB_RUN_SCHEMA_VERSION } from "./types.js";

export interface CreateJobRunOptions {
  command: string;
  inputFingerprint: string;
  orchestratorRunId?: string;
  openclawDir?: string;
  logRoot?: string;
  modelPolicy?: { model: string; fallbacks: string[] };
  resumeCommand?: string;
  startedAt?: Date;
}

export class MaintenanceJobRun {
  readonly record: MaintenanceJobRunRecord;
  readonly eventsPath: string;
  readonly summaryPath: string;
  readonly checkpointPath: string;
  private finished = false;

  private constructor(record: MaintenanceJobRunRecord, eventsPath: string, checkpointPath: string) {
    this.record = record;
    this.eventsPath = eventsPath;
    this.summaryPath = record.artifactPaths.summary;
    this.checkpointPath = checkpointPath;
  }

  static create(opts: CreateJobRunOptions): MaintenanceJobRun {
    const orchestratorRunId = opts.orchestratorRunId ?? resolveOrchestratorRunIdFromEnv();
    const jobRunId = buildJobRunId(opts.command, opts.inputFingerprint);
    const { jobRunDir } = resolveJobRunArtifactDir({
      logRoot: opts.logRoot,
      openclawDir: opts.openclawDir,
      jobRunId,
      orchestratorRunId,
      startedAt: opts.startedAt,
    });
    const summaryPath = `${jobRunDir}/summary.json`;
    const eventsPath = `${jobRunDir}/events.jsonl`;
    const checkpointPath = `${jobRunDir}/checkpoint.json`;

    const record: MaintenanceJobRunRecord = {
      schemaVersion: JOB_RUN_SCHEMA_VERSION,
      jobRunId,
      command: opts.command,
      orchestratorRunId,
      inputFingerprint: opts.inputFingerprint,
      modelPolicy: opts.modelPolicy,
      startedAt: (opts.startedAt ?? new Date()).toISOString(),
      phases: [],
      semanticOutcome: "success",
      artifactPaths: {
        summary: summaryPath,
        events: eventsPath,
        checkpoint: checkpointPath,
      },
      resumeCommand: opts.resumeCommand,
    };

    const run = new MaintenanceJobRun(record, eventsPath, checkpointPath);
    run.persistSummary();
    return run;
  }

  static load(summaryPath: string): MaintenanceJobRun | null {
    try {
      if (!existsSync(summaryPath)) return null;
      const record = JSON.parse(readFileSync(summaryPath, "utf-8")) as MaintenanceJobRunRecord;
      if (record.schemaVersion !== JOB_RUN_SCHEMA_VERSION) return null;
      const eventsPath = record.artifactPaths.events;
      const checkpointPath = record.artifactPaths.checkpoint ?? `${summaryPath.replace(/summary\.json$/, "")}checkpoint.json`;
      return new MaintenanceJobRun(record, eventsPath, checkpointPath);
    } catch {
      return null;
    }
  }

  get jobRunId(): string {
    return this.record.jobRunId;
  }

  createCheckpointStore<T>(): CheckpointStore<T> {
    return createFileCheckpointStore<T>(this.checkpointPath);
  }

  startPhase(name: string): void {
    const existing = this.record.phases.find((p) => p.name === name);
    if (existing) {
      existing.status = "running";
      existing.startedAt = nowIso();
    } else {
      this.record.phases.push({ name, status: "running", startedAt: nowIso() });
    }
    this.emit({ type: "phase_start", phase: name, ts: nowIso() });
    this.persistSummary();
  }

  endPhase(name: string, status: JobRunPhaseStatus, summary?: string): void {
    const phase = this.record.phases.find((p) => p.name === name);
    if (phase) {
      phase.status = status;
      phase.finishedAt = nowIso();
      if (summary) phase.summary = summary;
    } else {
      this.record.phases.push({ name, status, summary, finishedAt: nowIso() });
    }
    this.emit({ type: "phase_end", phase: name, status, ts: nowIso(), summary });
    this.persistSummary();
  }

  setProgress(completedUnits: number, totalUnits: number, unitLabel: string): void {
    this.record.progress = { completedUnits, totalUnits, unitLabel };
    this.persistSummary();
  }

  setDiagnostics(diagnostics: Record<string, number>): void {
    this.record.diagnostics = { ...diagnostics };
    this.persistSummary();
  }

  recordBatchComplete(index: number, parsed?: number): void {
    this.emit({ type: "batch_complete", index, ts: nowIso(), parsed });
  }

  recordRetry(kind: string, attempt: number, model?: string): void {
    this.emit({ type: "retry", kind, attempt, ts: nowIso(), model });
    this.record.diagnostics = {
      ...this.record.diagnostics,
      retries: (this.record.diagnostics?.retries ?? 0) + 1,
    };
  }

  recordFallback(from: string, to: string): void {
    this.emit({ type: "fallback", from, to, ts: nowIso() });
    this.record.diagnostics = {
      ...this.record.diagnostics,
      fallbacks: (this.record.diagnostics?.fallbacks ?? 0) + 1,
    };
  }

  setSemanticOutcome(outcome: JobRunSemanticOutcome, reason?: string): void {
    this.record.semanticOutcome = outcome;
    if (reason) this.record.semanticReason = reason;
    this.emit({ type: "semantic_gate", outcome, reason: reason ?? outcome, ts: nowIso() });
    this.persistSummary();
  }

  finish(options?: { clearCheckpoint?: boolean; clearEvents?: boolean }): MaintenanceJobRunRecord {
    if (this.finished) return this.record;
    this.finished = true;
    this.record.finishedAt = nowIso();
    const clearCheckpoint =
      options?.clearCheckpoint ??
      (this.record.semanticOutcome === "success" ||
        this.record.semanticOutcome === "empty" ||
        this.record.semanticOutcome === "skipped");
    if (clearCheckpoint) {
      this.clearCheckpoint();
    }
    if (options?.clearEvents && existsSync(this.eventsPath)) {
      try {
        unlinkSync(this.eventsPath);
      } catch {
        /* best-effort */
      }
    }
    this.persistSummary();
    return { ...this.record };
  }

  emit(event: JobRunEvent): void {
    appendJobRunEvent(this.eventsPath, event);
  }

  persistSummary(): void {
    atomicWriteFile(this.summaryPath, `${JSON.stringify(this.record, null, 2)}\n`);
  }

  clearCheckpoint(): void {
    if (!existsSync(this.checkpointPath)) return;
    try {
      unlinkSync(this.checkpointPath);
    } catch {
      /* best-effort */
    }
  }
}
