/**
 * Backup health / heartbeat alerting (Issue #2230).
 *
 * `hybrid-mem backup` records its outcome to `~/.openclaw/state/memory-backup-last.json`
 * (Issue #276, Gap 5). This module turns that state file into an actionable health signal:
 *  - `evaluateBackupHealth` classifies the current state (ok / failed / stale / unknown), the
 *    failure reason category, and age since the last verified success — pure, no I/O.
 *  - `recordBackupOutcome` persists a fresh outcome from an actual `runBackup()` call, carrying
 *    forward `lastSuccessAt` / consecutive-failure bookkeeping across runs.
 *  - `evaluateAndMaybeAlertBackupHealth` re-reads the state file and, when health is degraded,
 *    fires a deduplicated alert via the existing error-reporter pipeline — mirroring the
 *    fingerprint + time-window dedup pattern in services/error-reporter.ts so a persisting
 *    failure doesn't spam on every heartbeat/cron tick. A later success naturally clears the
 *    dedup fingerprint (it's simply absent from the fresh success record), so the very next
 *    failure alerts immediately instead of staying suppressed by a stale window.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { capturePluginError } from "./error-reporter.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

export type BackupFailureReasonCategory =
  | "disk_full"
  | "permission_denied"
  | "path_not_found"
  | "integrity_check_failed"
  | "unknown";

/** Categorize a raw backup error message for actionable, non-sensitive remediation guidance. */
export function classifyBackupFailureReason(errorMessage: string | null | undefined): BackupFailureReasonCategory {
  const msg = (errorMessage ?? "").toLowerCase();
  if (!msg) return "unknown";
  if (msg.includes("disk is full") || msg.includes("enospc") || msg.includes("no space left")) return "disk_full";
  if (msg.includes("eacces") || msg.includes("eperm") || msg.includes("permission denied")) return "permission_denied";
  if (msg.includes("enoent") || msg.includes("no such file") || msg.includes("not found")) return "path_not_found";
  if (msg.includes("integrity")) return "integrity_check_failed";
  return "unknown";
}

/** Persisted shape of `~/.openclaw/state/memory-backup-last.json`. */
export type BackupStateFile = {
  ok: boolean;
  timestamp: string;
  error?: string;
  reasonCategory?: BackupFailureReasonCategory;
  backupDir?: string;
  sqliteSize?: number;
  lancedbSize?: number;
  durationMs?: number;
  integrityOk?: boolean;
  snapshotSkewMs?: number;
  /** ISO timestamp of the most recent successful run, carried forward across failures. */
  lastSuccessAt?: string;
  /** Consecutive failed runs since the last success. */
  consecutiveFailures?: number;
  /** Bookkeeping for alert dedup — when a matching alert was last actually emitted. */
  lastAlertedAt?: string;
  /** Bookkeeping for alert dedup — fingerprint (`status:reasonCategory`) of the last emitted alert. */
  lastAlertedFingerprint?: string;
};

export type BackupHealthAlertPolicy = {
  enabled: boolean;
  /** Hours since last verified success after which the backup is stale even without a fresh failure. */
  staleAfterHours: number;
  /** Minimum hours between repeated alerts for the same persisting fingerprint. */
  dedupeWindowHours: number;
};

/** Mirrors the config parser's defaults (config/parsers/maintenance.ts) for callers that may see a
 * partial/mocked config (e.g. tests) without a fully-parsed `maintenance.backup.alerting`. */
export const DEFAULT_BACKUP_HEALTH_ALERT_POLICY: BackupHealthAlertPolicy = {
  enabled: true,
  staleAfterHours: 192,
  dedupeWindowHours: 24,
};

export type BackupHealthStatus = {
  status: "ok" | "failed" | "stale" | "unknown";
  reasonCategory: BackupFailureReasonCategory | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  ageSinceLastSuccessHours: number | null;
  consecutiveFailures: number;
  remediation: string[];
};

export function defaultBackupStateFilePath(): string {
  return join(homedir(), ".openclaw", "state", "memory-backup-last.json");
}

export function readBackupStateFile(path: string): BackupStateFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as BackupStateFile;
  } catch {
    return null;
  }
}

function remediationFor(status: BackupHealthStatus["status"], reason: BackupFailureReasonCategory | null): string[] {
  if (status === "failed") {
    switch (reason) {
      case "disk_full":
        return [
          "Free disk space on the backup volume (check `df -h`) or lower maintenance.backup.retentionCount / retentionAgeDays, then re-run `openclaw hybrid-mem backup`.",
        ];
      case "permission_denied":
        return [
          "Check filesystem permissions on the backup destination directory, then re-run `openclaw hybrid-mem backup`.",
        ];
      case "path_not_found":
        return ["Verify the configured backup destination path exists and is reachable, then re-run the backup."];
      case "integrity_check_failed":
        return [
          "SQLite integrity check failed on the source database before backup ran. Run `openclaw hybrid-mem backup verify` and consider restoring from an earlier snapshot.",
        ];
      default:
        return ["Re-run `openclaw hybrid-mem backup` and check ~/.openclaw/logs/backup.log for details."];
    }
  }
  if (status === "stale") {
    return [
      "Run `openclaw hybrid-mem backup` now and confirm the weekly cron is installed (`openclaw hybrid-mem backup schedule`).",
    ];
  }
  if (status === "unknown") {
    return ["No backup has run yet. Run `openclaw hybrid-mem backup` or `openclaw hybrid-mem backup schedule`."];
  }
  return [];
}

/** Pure classification of backup health from a state-file snapshot. No I/O, no side effects. */
export function evaluateBackupHealth(
  state: BackupStateFile | null,
  nowMs: number,
  policy: Pick<BackupHealthAlertPolicy, "staleAfterHours">,
): BackupHealthStatus {
  if (!state) {
    return {
      status: "unknown",
      reasonCategory: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      ageSinceLastSuccessHours: null,
      consecutiveFailures: 0,
      remediation: remediationFor("unknown", null),
    };
  }

  const lastSuccessAt = state.ok ? state.timestamp : (state.lastSuccessAt ?? null);
  const lastFailureAt = state.ok ? null : state.timestamp;
  const ageSinceLastSuccessHours = lastSuccessAt ? (nowMs - Date.parse(lastSuccessAt)) / 3_600_000 : null;
  const stale = ageSinceLastSuccessHours !== null && ageSinceLastSuccessHours >= policy.staleAfterHours;

  const status: BackupHealthStatus["status"] = !state.ok ? "failed" : stale ? "stale" : "ok";
  const reasonCategory = state.ok ? null : (state.reasonCategory ?? classifyBackupFailureReason(state.error));

  return {
    status,
    reasonCategory,
    lastSuccessAt,
    lastFailureAt,
    ageSinceLastSuccessHours:
      ageSinceLastSuccessHours !== null && Number.isFinite(ageSinceLastSuccessHours)
        ? Number(ageSinceLastSuccessHours.toFixed(2))
        : null,
    consecutiveFailures: state.ok ? 0 : Math.max(1, state.consecutiveFailures ?? 1),
    remediation: remediationFor(status, reasonCategory),
  };
}

export type BackupOutcomeInput =
  | {
      ok: true;
      timestamp: string;
      backupDir: string;
      sqliteSize: number;
      lancedbSize: number;
      durationMs: number;
      integrityOk: boolean;
      snapshotSkewMs: number;
    }
  | { ok: false; timestamp: string; error: string };

/**
 * Persist a fresh backup outcome (from an actual `runBackup()` call) to the state file, carrying
 * forward `lastSuccessAt` / consecutive-failure counters across runs. A success clears all prior
 * failure/alert bookkeeping — Issue #2230's "a later successful backup clears/supersedes the
 * stale failure state" requirement.
 */
export function recordBackupOutcome(
  stateFilePath: string,
  outcome: BackupOutcomeInput,
): BackupStateFile {
  const previous = readBackupStateFile(stateFilePath);
  const next: BackupStateFile = outcome.ok
    ? {
        ok: true,
        timestamp: outcome.timestamp,
        backupDir: outcome.backupDir,
        sqliteSize: outcome.sqliteSize,
        lancedbSize: outcome.lancedbSize,
        durationMs: outcome.durationMs,
        integrityOk: outcome.integrityOk,
        snapshotSkewMs: outcome.snapshotSkewMs,
        lastSuccessAt: outcome.timestamp,
        consecutiveFailures: 0,
      }
    : {
        ok: false,
        timestamp: outcome.timestamp,
        error: outcome.error,
        reasonCategory: classifyBackupFailureReason(outcome.error),
        lastSuccessAt: previous?.ok ? previous.timestamp : previous?.lastSuccessAt,
        consecutiveFailures: (previous && !previous.ok ? (previous.consecutiveFailures ?? 0) : 0) + 1,
        lastAlertedAt: previous?.lastAlertedAt,
        lastAlertedFingerprint: previous?.lastAlertedFingerprint,
      };
  try {
    atomicWriteFile(stateFilePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Non-fatal — state file is advisory only for heartbeat monitoring.
  }
  return next;
}

function formatBackupAlertMessage(health: BackupHealthStatus): string {
  const lines = [`hybrid-mem backup health: ${health.status.toUpperCase()}${health.reasonCategory ? ` (${health.reasonCategory})` : ""}`];
  lines.push(
    health.lastSuccessAt
      ? `Last verified success: ${health.lastSuccessAt} (${health.ageSinceLastSuccessHours?.toFixed(1) ?? "?"}h ago)`
      : "Last verified success: never",
  );
  if (health.consecutiveFailures > 0) lines.push(`Consecutive failures: ${health.consecutiveFailures}`);
  for (const r of health.remediation) lines.push(`Remediation: ${r}`);
  return lines.join("\n");
}

export type BackupHealthAssessment = {
  health: BackupHealthStatus;
  alerted: boolean;
  alertMessage: string | null;
};

/**
 * Evaluate current backup health from the persisted state file and, when degraded (failed or
 * stale) and alerting is enabled, emit a deduplicated actionable alert. Safe to call from every
 * heartbeat/maintenance tick (e.g. the weekly `audit-health` cron step) and once right after a
 * `hybrid-mem backup` run — repeated calls while the same failure/staleness persists only
 * re-alert after `policy.dedupeWindowHours` elapses, mirroring the fingerprinted dedup pattern
 * in services/error-reporter.ts.
 */
export function evaluateAndMaybeAlertBackupHealth(
  stateFilePath: string,
  policy: BackupHealthAlertPolicy,
  nowMs: number = Date.now(),
): BackupHealthAssessment {
  const state = readBackupStateFile(stateFilePath);
  const health = evaluateBackupHealth(state, nowMs, policy);

  if (!policy.enabled || !state || (health.status !== "failed" && health.status !== "stale")) {
    return { health, alerted: false, alertMessage: null };
  }

  const fingerprint = `${health.status}:${health.reasonCategory ?? "unknown"}`;
  const lastAlertedAtMs = state.lastAlertedAt ? Date.parse(state.lastAlertedAt) : Number.NaN;
  const dedupeWindowMs = Math.max(0, policy.dedupeWindowHours) * 3_600_000;
  const withinDedupeWindow =
    state.lastAlertedFingerprint === fingerprint &&
    Number.isFinite(lastAlertedAtMs) &&
    nowMs - lastAlertedAtMs < dedupeWindowMs;
  if (withinDedupeWindow) {
    return { health, alerted: false, alertMessage: null };
  }

  const alertMessage = formatBackupAlertMessage(health);
  try {
    capturePluginError(new Error(`hybrid-mem backup health degraded: ${fingerprint}`), {
      operation: "backup_health_alert",
      subsystem: "backup",
      severity: "warning",
      fingerprint: ["backup_health_alert", health.status, health.reasonCategory ?? "unknown"],
      tags: { consecutiveFailures: health.consecutiveFailures, status: health.status },
    });
  } catch {
    // Best-effort telemetry only — never block on alert delivery.
  }
  try {
    atomicWriteFile(
      stateFilePath,
      `${JSON.stringify(
        { ...state, lastAlertedAt: new Date(nowMs).toISOString(), lastAlertedFingerprint: fingerprint },
        null,
        2,
      )}\n`,
    );
  } catch {
    // Non-fatal — dedup bookkeeping is advisory; worst case is a duplicate alert next tick.
  }
  return { health, alerted: true, alertMessage };
}
