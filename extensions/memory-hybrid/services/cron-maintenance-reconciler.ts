/**
 * Reconcile hybrid-memory maintenance validation back into OpenClaw cron state.
 *
 * Issue #1233: OpenClaw cron marks isolated agent-turn jobs as `ok` when the agent
 * returns a normal message, even if the embedded hybrid-mem maintenance harness
 * reported `FAILED` / `maintenanceStatus:"failed"`. This service is intentionally
 * narrow and idempotent: it only touches `hybrid-mem:*` jobs/runs that are still
 * recorded as ok and whose summary or run artifacts prove maintenance failed.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { validateMaintenanceExecution, type ExitValidationResult } from "./cron-exit-validator.js";

const HYBRID_MEM_JOB_PREFIX = "hybrid-mem:";
const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MAX_RUN_RECORDS_PER_FILE = 20;

export type CronMaintenanceReconcileLogger = {
  info?: (s: string) => void;
  warn?: (s: string) => void;
  debug?: (s: string) => void;
};

export interface CronMaintenanceReconcileOptions {
  openclawDir?: string;
  nowMs?: number;
  lookbackMs?: number;
  maxRunRecordsPerFile?: number;
}

export interface CronMaintenanceReconcileResult {
  runsCorrected: number;
  jobsCorrected: number;
  inspectedRuns: number;
  errors: string[];
}

type CronRunRecord = Record<string, unknown> & {
  ts?: number;
  jobId?: string;
  status?: string;
  summary?: string;
  error?: string;
};

type CronJobRecord = Record<string, unknown> & {
  id?: string;
  pluginJobId?: string;
  name?: string;
  state?: Record<string, unknown>;
};

interface FailureEvidence {
  status: "failed" | "partial";
  error: string;
  logPath?: string;
  exitPath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function parseJsonObjectsFromText(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const needles: number[] = [];
  let idx = text.indexOf("maintenanceStatus");
  while (idx >= 0) {
    needles.push(idx);
    idx = text.indexOf("maintenanceStatus", idx + 1);
  }

  for (const needle of needles) {
    const start = text.lastIndexOf("{", needle);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const parsed = readJsonString(text.slice(start, i + 1));
          if (parsed) objects.push(parsed);
          break;
        }
      }
    }
  }
  return objects;
}

function readJsonString(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function validationToEvidence(validation: ExitValidationResult): FailureEvidence | null {
  if (validation.maintenanceStatus !== "failed" && validation.maintenanceStatus !== "partial") return null;
  return {
    status: validation.maintenanceStatus,
    error: validation.error ?? `maintenanceStatus=${validation.maintenanceStatus}`,
    logPath: validation.logPath,
    exitPath: validation.exitPath,
  };
}

function evidenceFromStructuredStatus(obj: Record<string, unknown>): FailureEvidence | null {
  const status = obj.maintenanceStatus;
  if (status !== "failed" && status !== "partial") return null;
  return {
    status,
    error: typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : `maintenanceStatus=${status}`,
    logPath: typeof obj.logPath === "string" ? obj.logPath : undefined,
    exitPath: typeof obj.exitPath === "string" ? obj.exitPath : undefined,
  };
}

function extractPath(summary: string, label: "HM_EXIT" | "HM_LOG"): string | undefined {
  const re = new RegExp(`${label}[^\n]*?(?:path)?[^\n]*?[:\\n]\\s*\`?([^\`\n]+?${label === "HM_EXIT" ? "\\.exit\\.txt" : "\\.log"})\`?`, "i");
  const match = summary.match(re);
  return match?.[1]?.trim();
}

const JOB_REQUIRED_STEPS: Record<string, string[]> = {
  "hybrid-mem:nightly-distill": ["prune", "distill", "extract-daily", "resolve-contradictions", "enrich-entities"],
  "hybrid-mem:self-correction-analysis": ["self-correction-run"],
  "hybrid-mem:weekly-reflection": ["reflect", "reflect-rules", "reflect-meta"],
  "hybrid-mem:weekly-extract-procedures": [
    "extract-procedures",
    "extract-directives",
    "extract-reinforcement",
    "generate-auto-skills",
  ],
  "hybrid-mem:weekly-audit-health": ["audit-health"],
  "hybrid-mem:maintenance-log-analyzer": ["analyze-maintenance-logs"],
  "hybrid-mem:weekly-pending-digest": ["digest-pending"],
  "hybrid-mem:weekly-deep-maintenance": ["compact", "vectordb-optimize", "scope-promote"],
  "hybrid-mem:weekly-persona-proposals": ["generate-proposals"],
  "hybrid-mem:monthly-consolidation": [
    "consolidate",
    "build-languages",
    "backfill-decay",
    "reembed-vectorless",
    "enrich-entities",
  ],
  "hybrid-mem:nightly-dream-cycle": ["dream-cycle"],
  "hybrid-mem:sensor-sweep": ["sensor-sweep-tier-1", "sensor-sweep-tier-2"],
  "hybrid-mem:daily-lifecycle-sync": ["lifecycle-sync"],
};

function requiredStepsFor(jobId: string | undefined): string[] {
  return jobId ? (JOB_REQUIRED_STEPS[jobId] ?? []) : [];
}

function evidenceFromSummary(record: CronRunRecord): FailureEvidence | null {
  const summary = typeof record.summary === "string" ? record.summary : "";
  if (!summary) return null;

  for (const obj of parseJsonObjectsFromText(summary)) {
    const evidence = evidenceFromStructuredStatus(obj);
    if (evidence) return evidence;
  }

  const exitPath = extractPath(summary, "HM_EXIT");
  const logPath = extractPath(summary, "HM_LOG");
  const requiredSteps = requiredStepsFor(String(record.jobId ?? ""));
  if (exitPath && requiredSteps.length > 0) {
    const evidence = validationToEvidence(validateMaintenanceExecution(exitPath, logPath, requiredSteps, true));
    if (evidence) return evidence;
  }

  // Last-resort textual detection for already-humanized summaries. Keep this strict to avoid false positives.
  if (/^\s*(?:\d+\.\s*)?(?:\*\*)?FAILED(?:\*\*)?\b/im.test(summary)) {
    return {
      status: "failed",
      error: "Maintenance summary reported FAILED but cron run was recorded ok",
      logPath,
      exitPath,
    };
  }
  return null;
}

function runFileForJob(openclawDir: string, jobId: string): string {
  return join(openclawDir, "cron", "runs", `${jobId}.jsonl`);
}

function jobsStorePath(openclawDir: string): string {
  return join(openclawDir, "cron", "jobs.json");
}

function isRecent(ts: unknown, cutoffMs: number): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= cutoffMs;
}

function readRunRecords(path: string, maxRecords: number): CronRunRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines
    .slice(Math.max(0, lines.length - maxRecords))
    .map((line) => readJsonString(line))
    .filter((r): r is CronRunRecord => !!r);
}

function writeRunRecords(path: string, records: CronRunRecord[]): void {
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
}

function patchRunRecord(record: CronRunRecord, evidence: FailureEvidence): boolean {
  if (record.status !== "ok") return false;
  record.status = "error";
  record.error = evidence.error;
  const diagnostics = asRecord(record.diagnostics) ?? {};
  record.diagnostics = {
    ...diagnostics,
    maintenanceStatus: evidence.status,
    maintenanceError: evidence.error,
    logPath: evidence.logPath,
    exitPath: evidence.exitPath,
    reconciledBy: "openclaw-hybrid-memory#1233",
  };
  return true;
}

function patchJobState(job: CronJobRecord, run: CronRunRecord, evidence: FailureEvidence, nowMs: number): boolean {
  const state = asRecord(job.state) ?? {};
  const lastRunAtMs = typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : undefined;
  const runAtMs = typeof run.runAtMs === "number" ? run.runAtMs : typeof run.ts === "number" ? run.ts : undefined;
  if (lastRunAtMs !== undefined && runAtMs !== undefined && Math.abs(lastRunAtMs - runAtMs) > 5 * 60 * 1000) {
    return false;
  }

  const previousErrors = typeof state.consecutiveErrors === "number" && Number.isFinite(state.consecutiveErrors)
    ? Math.max(0, Math.floor(state.consecutiveErrors))
    : 0;
  job.state = {
    ...state,
    lastRunStatus: "error",
    lastStatus: "error",
    lastError: evidence.error,
    lastErrorReason: "maintenance-validation-failed",
    consecutiveErrors: previousErrors + 1,
    consecutiveSkipped: 0,
    lastDiagnostics: {
      ...(asRecord(state.lastDiagnostics) ?? {}),
      maintenanceStatus: evidence.status,
      maintenanceError: evidence.error,
      logPath: evidence.logPath,
      exitPath: evidence.exitPath,
      reconciledBy: "openclaw-hybrid-memory#1233",
    },
    lastDiagnosticSummary: evidence.error,
    lastRunAtMs: runAtMs ?? lastRunAtMs ?? nowMs,
  };
  job.updatedAtMs = nowMs;
  return true;
}

function loadJobs(openclawDir: string): { path: string; store: { jobs?: unknown[] } } | null {
  const path = jobsStorePath(openclawDir);
  if (!existsSync(path)) return null;
  const parsed = readJsonFile(path);
  const store = asRecord(parsed) as { jobs?: unknown[] } | null;
  if (!store || !Array.isArray(store.jobs)) return null;
  return { path, store };
}

function knownHybridRunFiles(openclawDir: string): string[] {
  const runsDir = join(openclawDir, "cron", "runs");
  if (!existsSync(runsDir)) return [];
  try {
    return readdirSync(runsDir)
      .filter((name) => name.startsWith(HYBRID_MEM_JOB_PREFIX) && name.endsWith(".jsonl"))
      .map((name) => join(runsDir, name));
  } catch {
    return [];
  }
}

export function reconcileHybridMemCronMaintenanceOutcomes(
  logger: CronMaintenanceReconcileLogger,
  options: CronMaintenanceReconcileOptions = {},
): CronMaintenanceReconcileResult {
  const openclawDir = options.openclawDir ?? join(homedir(), ".openclaw");
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.lookbackMs ?? DEFAULT_LOOKBACK_MS);
  const maxRunRecords = Math.max(1, options.maxRunRecordsPerFile ?? DEFAULT_MAX_RUN_RECORDS_PER_FILE);
  const result: CronMaintenanceReconcileResult = { runsCorrected: 0, jobsCorrected: 0, inspectedRuns: 0, errors: [] };

  const jobsState = loadJobs(openclawDir);
  const jobs = (jobsState?.store.jobs ?? []).filter((j): j is CronJobRecord => !!asRecord(j));
  const jobsById = new Map<string, CronJobRecord>();
  for (const job of jobs) {
    const id = String(job.pluginJobId ?? job.id ?? "");
    if (id.startsWith(HYBRID_MEM_JOB_PREFIX)) jobsById.set(id, job);
  }

  let jobsMutated = false;
  for (const runPath of knownHybridRunFiles(openclawDir)) {
    let records: CronRunRecord[];
    try {
      records = readRunRecords(runPath, maxRunRecords);
    } catch (err) {
      result.errors.push(`${runPath}: ${err}`);
      continue;
    }

    let runFileMutated = false;
    for (const record of records) {
      const jobId = String(record.jobId ?? basename(runPath, ".jsonl"));
      if (!jobId.startsWith(HYBRID_MEM_JOB_PREFIX)) continue;
      if (record.status !== "ok") continue;
      if (!isRecent(record.ts, cutoffMs) && !isRecent(record.runAtMs, cutoffMs)) continue;
      result.inspectedRuns++;

      const evidence = evidenceFromSummary({ ...record, jobId });
      if (!evidence) continue;
      if (patchRunRecord(record, evidence)) {
        result.runsCorrected++;
        runFileMutated = true;
      }
      const job = jobsById.get(jobId);
      if (job && patchJobState(job, record, evidence, nowMs)) {
        result.jobsCorrected++;
        jobsMutated = true;
      }
    }

    if (runFileMutated) {
      try {
        const allRecords = readFileSync(runPath, "utf-8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => readJsonString(line) ?? line);
        const patchedByTs = new Map(records.map((r) => [String(r.ts ?? `${r.jobId}:${r.summary}`), r]));
        const merged = allRecords.map((entry) => {
          if (typeof entry === "string") return entry;
          const key = String((entry as CronRunRecord).ts ?? `${(entry as CronRunRecord).jobId}:${(entry as CronRunRecord).summary}`);
          return patchedByTs.get(key) ?? entry;
        });
        writeFileSync(runPath, `${merged.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`, "utf-8");
      } catch (err) {
        result.errors.push(`${runPath}: failed to write patched run records: ${err}`);
      }
    }
  }

  if (jobsMutated && jobsState) {
    try {
      writeFileSync(jobsState.path, JSON.stringify(jobsState.store, null, 2), "utf-8");
    } catch (err) {
      result.errors.push(`${jobsState.path}: failed to write patched job state: ${err}`);
    }
  }

  if (result.runsCorrected > 0 || result.jobsCorrected > 0) {
    logger.warn?.(
      `memory-hybrid: reconciled ${result.runsCorrected} false-ok cron run(s) and ${result.jobsCorrected} job state(s) from maintenance validation failures`,
    );
  } else {
    logger.debug?.(`memory-hybrid: cron maintenance outcome reconciliation inspected ${result.inspectedRuns} ok run(s); no false-ok records found`);
  }

  return result;
}
