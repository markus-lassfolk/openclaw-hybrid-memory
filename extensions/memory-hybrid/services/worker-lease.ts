/**
 * DB-backed worker leases for multi-process vault safety (Issue #1904).
 */
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import type { WorkerLeasesConfig } from "../config/types/maintenance.js";
import { emitFeatureTelemetry, type FeatureTelemetryLogger } from "./feature-telemetry.js";
import { isInQuietWindowAt, quietWindowEndEpochSecAt } from "./quiet-window.js";

export type WorkerLeaseRow = {
  workerId: string;
  ownerSessionId: string;
  pid: number | null;
  host: string | null;
  acquiredAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  stateJson: string | null;
};

export const DEFAULT_WORKER_LEASES_CONFIG: WorkerLeasesConfig = {
  enabled: false,
  defaultTtlSeconds: 120,
  heartbeatIntervalSeconds: 30,
  quietWindow: {
    enabled: false,
    start: "01:00",
    end: "06:00",
    tz: "UTC",
  },
};

export function resolveWorkerLeasesConfig(cfg?: WorkerLeasesConfig): WorkerLeasesConfig {
  return {
    ...DEFAULT_WORKER_LEASES_CONFIG,
    ...cfg,
    quietWindow: cfg?.quietWindow
      ? { ...DEFAULT_WORKER_LEASES_CONFIG.quietWindow!, ...cfg.quietWindow }
      : DEFAULT_WORKER_LEASES_CONFIG.quietWindow,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Returns true when local time (in configured TZ) is inside the quiet window. */
export function isInQuietWindow(cfg: WorkerLeasesConfig, at = new Date()): boolean {
  const qw = cfg.quietWindow;
  if (!qw?.enabled) return false;
  return isInQuietWindowAt(qw, at);
}

/** Epoch seconds when the quiet window ends (next eligible run time). */
export function quietWindowEndEpochSec(cfg: WorkerLeasesConfig, at = new Date()): number | null {
  const qw = cfg.quietWindow;
  if (!qw?.enabled) return null;
  return quietWindowEndEpochSecAt(qw, at);
}

/** Heuristic context usage: recent fact writes in last 5 minutes vs baseline. Returns 0–1. */
export function estimateContextUsage(db: DatabaseSync): number {
  try {
    const now = nowSec();
    const windowSec = 300;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM facts WHERE created_at >= ? AND superseded_at IS NULL`,
      )
      .get(now - windowSec) as { cnt: number } | undefined;
    const recent = row?.cnt ?? 0;
    // Saturate at 20 writes/5min → usage 1.0
    return Math.min(1, recent / 20);
  } catch {
    return 0;
  }
}

export function shouldRunWorker(
  db: DatabaseSync,
  cfg: WorkerLeasesConfig,
  logger?: FeatureTelemetryLogger,
): { allowed: boolean; reason?: string } {
  if (isInQuietWindow(cfg)) {
    emitFeatureTelemetry(logger, {
      feature: "worker_lease",
      operation: "gate",
      outcome: "skipped",
      fields: { reason: "quiet_window_active", tz: cfg.quietWindow?.tz ?? "UTC" },
    });
    return { allowed: false, reason: "quiet_window_active" };
  }
  if (cfg.contextUsageThreshold != null) {
    const usage = estimateContextUsage(db);
    if (usage > cfg.contextUsageThreshold) {
      emitFeatureTelemetry(logger, {
        feature: "worker_lease",
        operation: "gate",
        outcome: "skipped",
        fields: { reason: "context_usage", usage },
      });
      return { allowed: false, reason: `context_usage_${usage.toFixed(2)}` };
    }
  }
  return { allowed: true };
}

export function acquireLease(
  db: DatabaseSync,
  workerId: string,
  ownerSessionId: string,
  opts: {
    ttlSeconds?: number;
    heartbeatIntervalSeconds?: number;
    stateJson?: string;
    logger?: FeatureTelemetryLogger;
  } = {},
): boolean {
  const ttl = opts.ttlSeconds ?? 120;
  const heartbeatInterval = opts.heartbeatIntervalSeconds ?? 30;
  const now = nowSec();
  const expiresAt = now + ttl;
  const pid = process.pid;
  const host = hostname();

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        "SELECT owner_session_id, expires_at, last_heartbeat_at FROM worker_leases WHERE worker_id = ?",
      )
      .get(workerId) as
      | { owner_session_id: string; expires_at: number; last_heartbeat_at: number }
      | undefined;

    if (existing) {
      const heartbeatStale = existing.last_heartbeat_at < now - heartbeatInterval;
      const expired = existing.expires_at <= now;
      if (!expired && !heartbeatStale) {
        db.exec("ROLLBACK");
        return false;
      }
      db.prepare(
        `UPDATE worker_leases SET owner_session_id = ?, pid = ?, host = ?, acquired_at = ?, last_heartbeat_at = ?, expires_at = ?, state_json = ?
         WHERE worker_id = ?`,
      ).run(
        ownerSessionId,
        pid,
        host,
        now,
        now,
        expiresAt,
        opts.stateJson ?? null,
        workerId,
      );
    } else {
      db.prepare(
        `INSERT INTO worker_leases (worker_id, owner_session_id, pid, host, acquired_at, last_heartbeat_at, expires_at, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(workerId, ownerSessionId, pid, host, now, now, expiresAt, opts.stateJson ?? null);
    }
    db.exec("COMMIT");
    emitFeatureTelemetry(opts.logger, {
      feature: "worker_lease",
      operation: "acquire",
      outcome: "ok",
      fields: { worker_id: workerId, owner_session_id: ownerSessionId, takeover: Boolean(existing) },
    });
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    emitFeatureTelemetry(opts.logger, {
      feature: "worker_lease",
      operation: "acquire",
      outcome: "error",
      fields: { worker_id: workerId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

export function heartbeatLease(
  db: DatabaseSync,
  workerId: string,
  ownerSessionId: string,
  extendSeconds = 60,
): boolean {
  const now = nowSec();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT owner_session_id FROM worker_leases WHERE worker_id = ?")
      .get(workerId) as { owner_session_id: string } | undefined;
    if (!row || row.owner_session_id !== ownerSessionId) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(
      "UPDATE worker_leases SET last_heartbeat_at = ?, expires_at = ? WHERE worker_id = ? AND owner_session_id = ?",
    ).run(now, now + extendSeconds, workerId, ownerSessionId);
    db.exec("COMMIT");
    return true;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function releaseLease(db: DatabaseSync, workerId: string, ownerSessionId: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare("DELETE FROM worker_leases WHERE worker_id = ? AND owner_session_id = ?")
      .run(workerId, ownerSessionId);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function releaseAllLeasesForSession(db: DatabaseSync, ownerSessionId: string): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("DELETE FROM worker_leases WHERE owner_session_id = ?").run(ownerSessionId);
    db.exec("COMMIT");
    return result.changes;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return 0;
  }
}

export function listWorkerLeases(db: DatabaseSync): WorkerLeaseRow[] {
  const rows = db.prepare("SELECT * FROM worker_leases ORDER BY worker_id").all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    workerId: r.worker_id as string,
    ownerSessionId: r.owner_session_id as string,
    pid: r.pid == null ? null : (r.pid as number),
    host: (r.host as string | null) ?? null,
    acquiredAt: r.acquired_at as number,
    lastHeartbeatAt: r.last_heartbeat_at as number,
    expiresAt: r.expires_at as number,
    stateJson: (r.state_json as string | null) ?? null,
  }));
}

const sessionLeaseCleanups = new Map<string, () => void>();

/** Register SIGTERM + process exit cleanup for leases held by this session. */
export function registerWorkerLeaseShutdown(
  factsDbStore: { getRawDb: () => DatabaseSync; isOpen: () => boolean },
  ownerSessionId: string,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): void {
  if (sessionLeaseCleanups.has(ownerSessionId)) return;

  const cleanup = (): void => {
    try {
      if (!factsDbStore.isOpen()) return;
      const db = factsDbStore.getRawDb();
      const n = releaseAllLeasesForSession(db, ownerSessionId);
      if (n > 0) logger?.info?.(`worker-lease: released ${n} lease(s) for session ${ownerSessionId}`);
    } catch (err) {
      logger?.warn?.(`worker-lease: cleanup failed: ${err}`);
    }
  };

  sessionLeaseCleanups.set(ownerSessionId, cleanup);

  const onSigterm = (): void => {
    cleanup();
    process.exit(0);
  };
  process.once("SIGTERM", onSigterm);
  process.once("beforeExit", cleanup);
}
