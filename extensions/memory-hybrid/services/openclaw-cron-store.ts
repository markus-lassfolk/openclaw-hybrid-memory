/**
 * Read/write OpenClaw cron job stores — legacy JSON (~/.openclaw/cron/jobs.json) and
 * SQLite (~/.openclaw/state/openclaw.sqlite) used by OpenClaw 2026.6.8+.
 *
 * Issue #1923: verify/install must target the live store, not a deprecated JSON file
 * that OpenClaw migrates away on load.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createTransaction } from "../utils/sqlite-transaction.js";

export type CronStoreBackend = "json" | "sqlite";

export type OpenClawCronStoreFile = {
  version?: number;
  jobs?: unknown[];
};

export type OpenClawCronStoreSnapshot = {
  store: OpenClawCronStoreFile;
  backend: CronStoreBackend;
  /** Human-facing path shown in CLI output. */
  displayPath: string;
  /** Legacy logical partition key (resolved jobs.json path). */
  legacyStorePath: string;
};

/** Default legacy cron store path (logical partition key in SQLite). */
export function resolveLegacyCronJobsPath(openclawDir: string): string {
  return join(openclawDir, "cron", "jobs.json");
}

/** Shared OpenClaw state database (cron rows live here on 2026.6.8+). */
export function resolveOpenClawStateSqlitePath(openclawDir: string): string {
  return join(openclawDir, "state", "openclaw.sqlite");
}

/** Partition key OpenClaw uses in cron_jobs.store_key (resolved legacy jobs.json path). */
export function cronStorePartitionKey(legacyStorePath: string): string {
  return resolve(legacyStorePath);
}

function sqliteHasCronJobsTable(db: DatabaseSync): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'`).get();
  return row != null;
}

function countSqliteCronRows(db: DatabaseSync, storeKey: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM cron_jobs WHERE store_key = ?`).get(storeKey) as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}

function hasMigratedLegacyCronFile(openclawDir: string): boolean {
  const cronDir = join(openclawDir, "cron");
  if (!existsSync(cronDir)) return false;
  try {
    return readdirSync(cronDir).some((f) => /^jobs\.json\.migrated(\.\d+)?$/.test(f));
  } catch {
    return false;
  }
}

/** Choose JSON vs SQLite backend for read/write on this host. */
export function detectCronStoreBackend(openclawDir: string): CronStoreBackend {
  const legacyPath = resolveLegacyCronJobsPath(openclawDir);
  const sqlitePath = resolveOpenClawStateSqlitePath(openclawDir);

  if (!existsSync(sqlitePath)) {
    return "json";
  }

  try {
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      if (!sqliteHasCronJobsTable(db)) {
        // DB exists but table missing; check if we're on a migrated host.
        if (hasMigratedLegacyCronFile(openclawDir)) return "sqlite";
        return "json";
      }
      const storeKey = cronStorePartitionKey(legacyPath);
      if (countSqliteCronRows(db, storeKey) > 0) return "sqlite";
      if (existsSync(legacyPath)) return "json";
      // Migrated or fresh 6.8+ host: jobs.json absent, SQLite is canonical.
      if (hasMigratedLegacyCronFile(openclawDir)) return "sqlite";
      return "sqlite";
    } finally {
      db.close();
    }
  } catch {
    // DB exists but can't be opened; check if we're on a migrated host.
    if (hasMigratedLegacyCronFile(openclawDir)) return "sqlite";
    return existsSync(legacyPath) ? "json" : "sqlite";
  }
}

export function describeCronStoreLocation(openclawDir: string, backend?: CronStoreBackend): string {
  const resolved = backend ?? detectCronStoreBackend(openclawDir);
  if (resolved === "sqlite") {
    return resolveOpenClawStateSqlitePath(openclawDir);
  }
  return resolveLegacyCronJobsPath(openclawDir);
}

function parseJsonObject(raw: string | null | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function mergeJobFromSqliteRow(row: {
  job_json: string;
  state_json: string | null;
  enabled: number;
  schedule_expr: string | null;
  job_id: string;
  name: string;
}): Record<string, unknown> {
  const config = parseJsonObject(row.job_json, {});
  const state = parseJsonObject(row.state_json, {});
  if (typeof state.lastRunStatus === "string" && state.lastStatus == null) {
    state.lastStatus = state.lastRunStatus;
  }
  const job: Record<string, unknown> = { ...config, state };
  if (job.id == null && row.job_id) job.id = row.job_id;
  if (job.name == null && row.name) job.name = row.name;
  // SQLite indexed column is authoritative for enabled (job_json can lag).
  job.enabled = row.enabled !== 0;
  if (job.schedule == null && row.schedule_expr) {
    job.schedule = { kind: "cron", expr: row.schedule_expr };
  }
  return job;
}

function readCronStoreFromJson(legacyPath: string): OpenClawCronStoreFile {
  if (!existsSync(legacyPath)) return { version: 1, jobs: [] };
  let parsed: OpenClawCronStoreFile;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as OpenClawCronStoreFile;
  } catch (err) {
    throw new Error(`failed to parse cron store at ${legacyPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed.jobs)) parsed.jobs = [];
  return parsed;
}

function readCronStoreFromSqlite(sqlitePath: string, storeKey: string): OpenClawCronStoreFile {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (!sqliteHasCronJobsTable(db)) return { version: 1, jobs: [] };
    const rows = db
      .prepare(
        `SELECT job_id, name, enabled, schedule_expr, job_json, state_json
         FROM cron_jobs
         WHERE store_key = ?
         ORDER BY sort_order ASC, updated_at ASC, job_id ASC`,
      )
      .all(storeKey) as Array<{
      job_id: string;
      name: string;
      enabled: number;
      schedule_expr: string | null;
      job_json: string;
      state_json: string | null;
    }>;
    return {
      version: 1,
      jobs: rows.map((row) => mergeJobFromSqliteRow(row)),
    };
  } finally {
    db.close();
  }
}

/** Load cron jobs from the live store (SQLite when migrated, else legacy JSON). */
export function readOpenClawCronStore(openclawDir: string): OpenClawCronStoreSnapshot {
  const legacyStorePath = resolveLegacyCronJobsPath(openclawDir);
  const backend = detectCronStoreBackend(openclawDir);
  const displayPath = describeCronStoreLocation(openclawDir, backend);
  const store =
    backend === "sqlite"
      ? readCronStoreFromSqlite(resolveOpenClawStateSqlitePath(openclawDir), cronStorePartitionKey(legacyStorePath))
      : readCronStoreFromJson(legacyStorePath);
  if (!Array.isArray(store.jobs)) store.jobs = [];
  return { store, backend, displayPath, legacyStorePath };
}

function boolToInt(v: boolean | undefined | null): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function stripJobRuntimeFields(job: Record<string, unknown>): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  return { ...rest, state: {} };
}

function resolvePayload(job: Record<string, unknown>): Record<string, unknown> | null {
  const payload = job.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (typeof job.message === "string") {
    return {
      kind: "agentTurn",
      message: job.message,
      ...(typeof job.model === "string" ? { model: job.model } : {}),
    };
  }
  if (typeof job.text === "string") {
    return { kind: "systemEvent", text: job.text };
  }
  return null;
}

function bindScheduleColumns(schedule: unknown): {
  schedule_kind: string;
  schedule_expr: string | null;
  schedule_tz: string | null;
  every_ms: number | null;
  anchor_ms: number | null;
  at: string | null;
  stagger_ms: number | null;
} {
  if (typeof schedule === "string") {
    return {
      schedule_kind: "cron",
      schedule_expr: schedule,
      schedule_tz: null,
      every_ms: null,
      anchor_ms: null,
      at: null,
      stagger_ms: null,
    };
  }
  if (typeof schedule === "object" && schedule !== null && !Array.isArray(schedule)) {
    const s = schedule as Record<string, unknown>;
    if (s.kind === "at" && typeof s.at === "string") {
      return {
        schedule_kind: "at",
        at: s.at,
        schedule_expr: null,
        schedule_tz: null,
        every_ms: null,
        anchor_ms: null,
        stagger_ms: null,
      };
    }
    if (s.kind === "every" && typeof s.everyMs === "number") {
      return {
        schedule_kind: "every",
        every_ms: s.everyMs,
        anchor_ms: typeof s.anchorMs === "number" ? s.anchorMs : null,
        schedule_expr: null,
        schedule_tz: null,
        at: null,
        stagger_ms: null,
      };
    }
    if (s.kind === "cron" && typeof s.expr === "string") {
      return {
        schedule_kind: "cron",
        schedule_expr: s.expr,
        schedule_tz: typeof s.tz === "string" ? s.tz : null,
        stagger_ms: typeof s.staggerMs === "number" ? s.staggerMs : null,
        every_ms: null,
        anchor_ms: null,
        at: null,
      };
    }
  }
  return {
    schedule_kind: "manual",
    schedule_expr: null,
    schedule_tz: null,
    every_ms: null,
    anchor_ms: null,
    at: null,
    stagger_ms: null,
  };
}

function bindPayloadColumns(payload: Record<string, unknown>): {
  payload_kind: string;
  payload_message: string | null;
  payload_model: string | null;
  payload_fallbacks_json: string | null;
  payload_thinking: string | null;
  payload_timeout_seconds: number | null;
  payload_allow_unsafe_external_content: number | null;
  payload_external_content_source_json: string | null;
  payload_light_context: number | null;
  payload_tools_allow_json: string | null;
} {
  const kind = String(payload.kind ?? "agentTurn");
  if (kind === "systemEvent") {
    const text = typeof payload.text === "string" ? payload.text : typeof payload.message === "string" ? payload.message : null;
    return {
      payload_kind: "systemEvent",
      payload_message: text,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  if (kind === "command") {
    const { timeoutSeconds, ...rest } = payload;
    return {
      payload_kind: "command",
      payload_message: JSON.stringify(rest),
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: numOrNull(timeoutSeconds),
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  return {
    payload_kind: "agentTurn",
    payload_message: typeof payload.message === "string" ? payload.message : null,
    payload_model: typeof payload.model === "string" ? payload.model : null,
    payload_fallbacks_json: Array.isArray(payload.fallbacks) ? JSON.stringify(payload.fallbacks) : null,
    payload_thinking: typeof payload.thinking === "string" ? payload.thinking : null,
    payload_timeout_seconds: numOrNull(payload.timeoutSeconds),
    payload_allow_unsafe_external_content: boolToInt(payload.allowUnsafeExternalContent as boolean | undefined),
    payload_external_content_source_json:
      payload.externalContentSource != null ? JSON.stringify(payload.externalContentSource) : null,
    payload_light_context: boolToInt(payload.lightContext as boolean | undefined),
    payload_tools_allow_json: Array.isArray(payload.toolsAllow) ? JSON.stringify(payload.toolsAllow) : null,
  };
}

function bindDeliveryColumns(delivery: unknown): Record<string, string | number | null> {
  if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery)) {
    return {
      delivery_mode: null,
      delivery_channel: null,
      delivery_to: null,
      delivery_thread_id: null,
      delivery_account_id: null,
      delivery_best_effort: null,
      delivery_completion_mode: null,
      delivery_completion_to: null,
      failure_delivery_mode: null,
      failure_delivery_channel: null,
      failure_delivery_to: null,
      failure_delivery_account_id: null,
    };
  }
  const d = delivery as Record<string, unknown>;
  const failure = d.failureDestination as Record<string, unknown> | undefined;
  return {
    delivery_mode: typeof d.mode === "string" ? d.mode : null,
    delivery_channel: typeof d.channel === "string" ? d.channel : null,
    delivery_to: typeof d.to === "string" ? d.to : null,
    delivery_thread_id: d.threadId != null ? String(d.threadId) : null,
    delivery_account_id: typeof d.accountId === "string" ? d.accountId : null,
    delivery_best_effort: boolToInt(d.bestEffort as boolean | undefined),
    delivery_completion_mode:
      typeof (d.completionDestination as Record<string, unknown> | undefined)?.mode === "string"
        ? String((d.completionDestination as Record<string, unknown>).mode)
        : null,
    delivery_completion_to:
      typeof (d.completionDestination as Record<string, unknown> | undefined)?.to === "string"
        ? String((d.completionDestination as Record<string, unknown>).to)
        : null,
    failure_delivery_mode: failure && Object.hasOwn(failure, "mode") ? String(failure.mode ?? "") : null,
    failure_delivery_channel: failure && Object.hasOwn(failure, "channel") ? String(failure.channel ?? "") : null,
    failure_delivery_to: failure && Object.hasOwn(failure, "to") ? String(failure.to ?? "") : null,
    failure_delivery_account_id:
      failure && Object.hasOwn(failure, "accountId") ? String(failure.accountId ?? "") : null,
  };
}

function bindStateColumns(state: Record<string, unknown>): Record<string, string | number | null> {
  const lastStatus =
    typeof state.lastRunStatus === "string"
      ? state.lastRunStatus
      : typeof state.lastStatus === "string"
        ? state.lastStatus
        : null;
  return {
    next_run_at_ms: numOrNull(state.nextRunAtMs),
    running_at_ms: numOrNull(state.runningAtMs),
    last_run_at_ms: numOrNull(state.lastRunAtMs),
    last_run_status: lastStatus,
    last_error: typeof state.lastError === "string" ? state.lastError : null,
    last_duration_ms: numOrNull(state.lastDurationMs),
    consecutive_errors: numOrNull(state.consecutiveErrors),
    consecutive_skipped: numOrNull(state.consecutiveSkipped),
    schedule_error_count: numOrNull(state.scheduleErrorCount),
    last_delivery_status: typeof state.lastDeliveryStatus === "string" ? state.lastDeliveryStatus : null,
    last_delivery_error: typeof state.lastDeliveryError === "string" ? state.lastDeliveryError : null,
    last_delivered: boolToInt(state.lastDelivered as boolean | undefined),
    last_failure_alert_at_ms: numOrNull(state.lastFailureAlertAtMs),
  };
}

function normalizeJobRecord(raw: Record<string, unknown>): Record<string, unknown> | null {
  const id = String(raw.id ?? raw.pluginJobId ?? raw.name ?? "").trim();
  if (!id) return null;
  const now = Date.now();
  const state =
    typeof raw.state === "object" && raw.state !== null && !Array.isArray(raw.state)
      ? (raw.state as Record<string, unknown>)
      : {};
  const payload = resolvePayload(raw);
  if (!payload) return null;
  const schedule = raw.schedule ?? { kind: "manual" };
  return {
    ...raw,
    id,
    name: String(raw.name ?? id),
    enabled: raw.enabled !== false,
    schedule,
    sessionTarget: raw.sessionTarget ?? "main",
    wakeMode: raw.wakeMode ?? "now",
    payload,
    delivery: raw.delivery ?? { mode: "none" },
    createdAtMs: numOrNull(raw.createdAtMs) ?? now,
    updatedAtMs: numOrNull(raw.updatedAtMs) ?? now,
    state,
  };
}

const CRON_JOBS_INSERT_SQL = `
INSERT INTO cron_jobs (
  store_key, job_id, name, description, enabled, delete_after_run, created_at_ms, updated_at,
  agent_id, session_key, session_target, wake_mode,
  schedule_kind, schedule_expr, schedule_tz, every_ms, anchor_ms, at, stagger_ms,
  payload_kind, payload_message, payload_model, payload_fallbacks_json, payload_thinking,
  payload_timeout_seconds, payload_allow_unsafe_external_content, payload_external_content_source_json,
  payload_light_context, payload_tools_allow_json,
  delivery_mode, delivery_channel, delivery_to, delivery_thread_id, delivery_account_id,
  delivery_best_effort, delivery_completion_mode, delivery_completion_to,
  failure_delivery_mode, failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
  failure_alert_disabled, failure_alert_after, failure_alert_channel, failure_alert_to,
  failure_alert_cooldown_ms, failure_alert_include_skipped, failure_alert_mode, failure_alert_account_id,
  next_run_at_ms, running_at_ms, last_run_at_ms, last_run_status, last_error, last_duration_ms,
  consecutive_errors, consecutive_skipped, schedule_error_count, last_delivery_status, last_delivery_error,
  last_delivered, last_failure_alert_at_ms, state_json, runtime_updated_at_ms, schedule_identity, sort_order, job_json
) VALUES (
  @store_key, @job_id, @name, @description, @enabled, @delete_after_run, @created_at_ms, @updated_at,
  @agent_id, @session_key, @session_target, @wake_mode,
  @schedule_kind, @schedule_expr, @schedule_tz, @every_ms, @anchor_ms, @at, @stagger_ms,
  @payload_kind, @payload_message, @payload_model, @payload_fallbacks_json, @payload_thinking,
  @payload_timeout_seconds, @payload_allow_unsafe_external_content, @payload_external_content_source_json,
  @payload_light_context, @payload_tools_allow_json,
  @delivery_mode, @delivery_channel, @delivery_to, @delivery_thread_id, @delivery_account_id,
  @delivery_best_effort, @delivery_completion_mode, @delivery_completion_to,
  @failure_delivery_mode, @failure_delivery_channel, @failure_delivery_to, @failure_delivery_account_id,
  @failure_alert_disabled, @failure_alert_after, @failure_alert_channel, @failure_alert_to,
  @failure_alert_cooldown_ms, @failure_alert_include_skipped, @failure_alert_mode, @failure_alert_account_id,
  @next_run_at_ms, @running_at_ms, @last_run_at_ms, @last_run_status, @last_error, @last_duration_ms,
  @consecutive_errors, @consecutive_skipped, @schedule_error_count, @last_delivery_status, @last_delivery_error,
  @last_delivered, @last_failure_alert_at_ms, @state_json, @runtime_updated_at_ms, @schedule_identity, @sort_order, @job_json
)`;

function bindCronJobInsertRow(
  storeKey: string,
  rawJob: Record<string, unknown>,
  sortOrder: number,
): Record<string, string | number | null> | null {
  const job = normalizeJobRecord(rawJob);
  if (!job) return null;
  const payload = job.payload as Record<string, unknown>;
  const state = job.state as Record<string, unknown>;
  const scheduleCols = bindScheduleColumns(job.schedule);
  const payloadCols = bindPayloadColumns(payload);
  if (!payloadCols.payload_message) return null;
  const deliveryCols = bindDeliveryColumns(job.delivery);
  const stateCols = bindStateColumns(state);
  const updatedAtMs = numOrNull(job.updatedAtMs) ?? Date.now();
  const createdAtMs = numOrNull(job.createdAtMs) ?? updatedAtMs;
  return {
    store_key: storeKey,
    job_id: String(job.id),
    name: String(job.name),
    description: strOrNull(job.description),
    enabled: job.enabled === false ? 0 : 1,
    delete_after_run: boolToInt(job.deleteAfterRun as boolean | undefined),
    created_at_ms: createdAtMs,
    updated_at: updatedAtMs,
    agent_id: strOrNull(job.agentId),
    session_key: strOrNull(job.sessionKey),
    session_target: String(job.sessionTarget ?? "main"),
    wake_mode: String(job.wakeMode ?? "now"),
    ...scheduleCols,
    ...payloadCols,
    ...deliveryCols,
    failure_alert_disabled: null,
    failure_alert_after: null,
    failure_alert_channel: null,
    failure_alert_to: null,
    failure_alert_cooldown_ms: null,
    failure_alert_include_skipped: null,
    failure_alert_mode: null,
    failure_alert_account_id: null,
    ...stateCols,
    state_json: JSON.stringify(state),
    runtime_updated_at_ms: updatedAtMs,
    schedule_identity: null,
    sort_order: sortOrder,
    job_json: JSON.stringify(stripJobRuntimeFields(job)),
  };
}

function writeCronStoreToJson(legacyPath: string, store: OpenClawCronStoreFile): void {
  mkdirSync(dirname(legacyPath), { recursive: true });
  const payload = JSON.stringify(store, null, 2);
  const tmpPath = `${legacyPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, legacyPath);
}

function cronJobRowId(rawJob: Record<string, unknown>): string {
  return String(rawJob.id ?? rawJob.pluginJobId ?? rawJob.name ?? "").trim();
}

function loadExistingSqliteCronRows(db: DatabaseSync, storeKey: string): Map<string, Record<string, unknown>> {
  const rows = db.prepare(`SELECT * FROM cron_jobs WHERE store_key = ?`).all(storeKey) as Array<Record<string, unknown>>;
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const jobId = String(row.job_id ?? "");
    if (jobId) out.set(jobId, row);
  }
  return out;
}

function writeCronStoreToSqlite(sqlitePath: string, storeKey: string, store: OpenClawCronStoreFile): void {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  try {
    if (!sqliteHasCronJobsTable(db)) {
      throw new Error("cron_jobs table missing in OpenClaw state database");
    }
    const existingByJobId = loadExistingSqliteCronRows(db, storeKey);
    const jobs = Array.isArray(store.jobs) ? (store.jobs as Array<Record<string, unknown>>) : [];
    const incomingIds = new Set<string>();
    const rowsToInsert: Array<Record<string, string | number | null>> = [];

    let sortOrder = 0;
    for (const rawJob of jobs) {
      if (typeof rawJob !== "object" || rawJob === null) continue;
      const jobId = cronJobRowId(rawJob);
      if (!jobId) {
        throw new Error("Refusing to persist cron store with a job missing id/pluginJobId/name");
      }
      incomingIds.add(jobId);
      const row = bindCronJobInsertRow(storeKey, rawJob, sortOrder);
      if (row) {
        rowsToInsert.push(row);
        sortOrder += 1;
        continue;
      }
      const preserved = existingByJobId.get(jobId);
      if (preserved) {
        rowsToInsert.push(preserved as Record<string, string | number | null>);
        sortOrder += 1;
        continue;
      }
      throw new Error(
        `Job normalization failed for ${JSON.stringify(rawJob).slice(0, 200)}; refusing to drop job from SQLite store`,
      );
    }

    // Keep DB rows not represented in the in-memory store (defensive — full reads should include all jobs).
    for (const [jobId, preserved] of existingByJobId) {
      if (!incomingIds.has(jobId)) {
        rowsToInsert.push(preserved as Record<string, string | number | null>);
        sortOrder += 1;
      }
    }

    const tx = createTransaction(db, () => {
      db.prepare(`DELETE FROM cron_jobs WHERE store_key = ?`).run(storeKey);
      const insert = db.prepare(CRON_JOBS_INSERT_SQL);
      for (const row of rowsToInsert) {
        insert.run(row);
      }
    }, "IMMEDIATE");
    tx();
  } finally {
    db.close();
  }
}

/** Persist cron jobs to the live store (SQLite when migrated, else legacy JSON). */
export function writeOpenClawCronStore(
  openclawDir: string,
  store: OpenClawCronStoreFile,
  backend?: CronStoreBackend,
): { backend: CronStoreBackend; displayPath: string } {
  const resolvedBackend = backend ?? detectCronStoreBackend(openclawDir);
  const legacyStorePath = resolveLegacyCronJobsPath(openclawDir);
  const displayPath = describeCronStoreLocation(openclawDir, resolvedBackend);
  if (!Array.isArray(store.jobs)) store.jobs = [];

  if (resolvedBackend === "sqlite") {
    try {
      writeCronStoreToSqlite(
        resolveOpenClawStateSqlitePath(openclawDir),
        cronStorePartitionKey(legacyStorePath),
        store,
      );
      return { backend: "sqlite", displayPath };
    } catch (err) {
      throw new Error(`SQLite write failed on migrated host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeCronStoreToJson(legacyStorePath, store);
  return { backend: "json", displayPath: legacyStorePath };
}

/** Convenience: load store, mutate jobs array in place, then persist. */
export function withOpenClawCronStore<T>(
  openclawDir: string,
  mutate: (ctx: { store: OpenClawCronStoreFile; jobs: Array<Record<string, unknown>>; snapshot: OpenClawCronStoreSnapshot }) => T,
): T {
  const snapshot = readOpenClawCronStore(openclawDir);
  if (!Array.isArray(snapshot.store.jobs)) snapshot.store.jobs = [];
  const jobs = snapshot.store.jobs as Array<Record<string, unknown>>;
  const result = mutate({ store: snapshot.store, jobs, snapshot });
  writeOpenClawCronStore(openclawDir, snapshot.store, snapshot.backend);
  return result;
}
