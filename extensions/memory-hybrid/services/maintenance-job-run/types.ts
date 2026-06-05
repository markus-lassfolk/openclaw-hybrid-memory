/**
 * Maintenance JobRun types — resumable command execution substrate (#1877).
 */

export const JOB_RUN_SCHEMA_VERSION = 1;
export const ORCHESTRATOR_RUN_SCHEMA_VERSION = 1;

export type JobRunSemanticOutcome =
  | "success"
  | "success_with_review"
  | "partial"
  | "failed"
  | "skipped"
  | "empty"
  | "failed_semantic_empty";

export type JobRunPhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface JobRunPhaseRecord {
  name: string;
  status: JobRunPhaseStatus;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobRunProgress {
  completedUnits: number;
  totalUnits: number;
  unitLabel: string;
}

export interface JobRunArtifactPaths {
  summary: string;
  events: string;
  checkpoint?: string;
  report?: string;
}

export interface MaintenanceJobRunRecord {
  schemaVersion: number;
  jobRunId: string;
  command: string;
  orchestratorRunId?: string;
  inputFingerprint: string;
  modelPolicy?: { model: string; fallbacks: string[] };
  startedAt: string;
  finishedAt?: string;
  phases: JobRunPhaseRecord[];
  semanticOutcome: JobRunSemanticOutcome;
  semanticReason?: string;
  progress?: JobRunProgress;
  diagnostics?: Record<string, number>;
  artifactPaths: JobRunArtifactPaths;
  resumeCommand?: string;
}

export type JobRunEvent =
  | { type: "phase_start"; phase: string; ts: string }
  | { type: "phase_end"; phase: string; status: JobRunPhaseStatus; ts: string; summary?: string }
  | { type: "batch_complete"; index: number; ts: string; parsed?: number }
  | { type: "retry"; kind: string; attempt: number; ts: string; model?: string }
  | { type: "fallback"; from: string; to: string; ts: string }
  | { type: "semantic_gate"; outcome: JobRunSemanticOutcome; reason: string; ts: string };

export interface BatchCheckpointState<TItem = unknown> {
  version: number;
  incidentsHash: string;
  batchSize: number;
  totalBatches: number;
  completedBatchIndexes: number[];
  analysed: TItem[];
  diagnostics: Record<string, number>;
  updatedAt: string;
}

export interface OffsetCheckpointState {
  offset: number;
  total: number;
  migrated: number;
  skipped: number;
  ts: number;
}

export interface OrchestratorRunSummary {
  schemaVersion: number;
  runId: string;
  job?: string;
  tierLabel: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: 0 | 1 | 2;
  summaryLine: string;
  steps: Array<{
    name: string;
    status: string;
    summary: string;
    durationMs: number;
    jobRunId?: string;
    semanticOutcome?: JobRunSemanticOutcome;
  }>;
  counts: {
    ok: number;
    skipped: number;
    deferred: number;
    failed: number;
    rateLimited: number;
  };
  validation?: unknown;
}

export interface MaintenanceRunRollupSummary extends OrchestratorRunSummary {
  jobRuns?: MaintenanceJobRunRecord[];
}
