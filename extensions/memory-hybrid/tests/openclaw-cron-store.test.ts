import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  cronStorePartitionKey,
  detectCronStoreBackend,
  readOpenClawCronStore,
  resolveLegacyCronJobsPath,
  resolveOpenClawStateSqlitePath,
  writeOpenClawCronStore,
} from "../services/openclaw-cron-store.js";

const CRON_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  store_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  delete_after_run INTEGER,
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  session_key TEXT,
  session_target TEXT NOT NULL DEFAULT 'main',
  wake_mode TEXT NOT NULL DEFAULT 'now',
  schedule_kind TEXT NOT NULL DEFAULT 'manual',
  schedule_expr TEXT,
  schedule_tz TEXT,
  every_ms INTEGER,
  anchor_ms INTEGER,
  at TEXT,
  stagger_ms INTEGER,
  payload_kind TEXT NOT NULL DEFAULT 'agentTurn',
  payload_message TEXT,
  payload_model TEXT,
  payload_fallbacks_json TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER,
  payload_allow_unsafe_external_content INTEGER,
  payload_external_content_source_json TEXT,
  payload_light_context INTEGER,
  payload_tools_allow_json TEXT,
  delivery_mode TEXT,
  delivery_channel TEXT,
  delivery_to TEXT,
  delivery_thread_id TEXT,
  delivery_account_id TEXT,
  delivery_best_effort INTEGER,
  delivery_completion_mode TEXT,
  delivery_completion_to TEXT,
  failure_delivery_mode TEXT,
  failure_delivery_channel TEXT,
  failure_delivery_to TEXT,
  failure_delivery_account_id TEXT,
  failure_alert_disabled INTEGER,
  failure_alert_after INTEGER,
  failure_alert_channel TEXT,
  failure_alert_to TEXT,
  failure_alert_cooldown_ms INTEGER,
  failure_alert_include_skipped INTEGER,
  failure_alert_mode TEXT,
  failure_alert_account_id TEXT,
  next_run_at_ms INTEGER,
  running_at_ms INTEGER,
  last_run_at_ms INTEGER,
  last_run_status TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_errors INTEGER,
  consecutive_skipped INTEGER,
  schedule_error_count INTEGER,
  last_delivery_status TEXT,
  last_delivery_error TEXT,
  last_delivered INTEGER,
  last_failure_alert_at_ms INTEGER,
  state_json TEXT NOT NULL DEFAULT '{}',
  runtime_updated_at_ms INTEGER,
  schedule_identity TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  job_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (store_key, job_id)
);
`;

function seedSqliteCronJob(
  openclawDir: string,
  job: Record<string, unknown>,
  state: Record<string, unknown> = { lastRunAtMs: 1_700_000_000_000, lastRunStatus: "ok" },
): void {
  const legacyPath = resolveLegacyCronJobsPath(openclawDir);
  const sqlitePath = resolveOpenClawStateSqlitePath(openclawDir);
  mkdirSync(join(openclawDir, "state"), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(CRON_JOBS_DDL);
    const storeKey = cronStorePartitionKey(legacyPath);
    const id = String(job.id ?? job.pluginJobId ?? "test-job");
    const payload = (job.payload as Record<string, unknown> | undefined) ?? {
      kind: "agentTurn",
      message: String(job.message ?? "cron heartbeat test"),
    };
    db.prepare(
      `INSERT INTO cron_jobs (
        store_key, job_id, name, enabled, created_at_ms, updated_at, session_target, wake_mode,
        schedule_kind, schedule_expr, payload_kind, payload_message, delivery_mode,
        last_run_at_ms, last_run_status, state_json, runtime_updated_at_ms, sort_order, job_json
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'now', 'cron', ?, ?, ?, 'none', ?, 'ok', ?, ?, 0, ?)`,
    ).run(
      storeKey,
      id,
      String(job.name ?? id),
      Date.now(),
      Date.now(),
      String(job.sessionTarget ?? "main"),
      typeof (job.schedule as { expr?: string } | undefined)?.expr === "string"
        ? (job.schedule as { expr: string }).expr
        : "5 2 * * *",
      String(payload.kind ?? "agentTurn"),
      String(payload.message ?? payload.text ?? ""),
      state.lastRunAtMs ?? null,
      JSON.stringify(state),
      Date.now(),
      JSON.stringify({ ...job, state: {} }),
    );
  } finally {
    db.close();
  }
}

describe("openclaw-cron-store (#1923)", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
  });

  it("detects SQLite backend when jobs.json is absent but cron_jobs rows exist", () => {
    homeDir = mkdtempSync(join(tmpdir(), "oc-cron-store-"));
    const openclawDir = join(homeDir, ".openclaw");
    seedSqliteCronJob(openclawDir, {
      id: "hybrid-mem:maintenance-nightly",
      pluginJobId: "hybrid-mem:maintenance-nightly",
      name: "maintenance-nightly",
      schedule: { kind: "cron", expr: "5 2 * * *" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
    });
    expect(detectCronStoreBackend(openclawDir)).toBe("sqlite");
    const snapshot = readOpenClawCronStore(openclawDir);
    expect(snapshot.backend).toBe("sqlite");
    expect(snapshot.store.jobs?.length).toBe(1);
    const job = snapshot.store.jobs?.[0] as Record<string, unknown>;
    expect(job.pluginJobId ?? job.id).toBe("hybrid-mem:maintenance-nightly");
    expect((job.state as { lastRunStatus?: string }).lastRunStatus).toBe("ok");
  });

  it("reads legacy jobs.json when SQLite has no rows", () => {
    homeDir = mkdtempSync(join(tmpdir(), "oc-cron-store-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(
      resolveLegacyCronJobsPath(openclawDir),
      JSON.stringify({
        jobs: [
          {
            id: "hybrid-mem:maintenance-nightly",
            pluginJobId: "hybrid-mem:maintenance-nightly",
            name: "maintenance-nightly",
            enabled: true,
            schedule: { kind: "cron", expr: "0 2 * * *" },
            payload: { kind: "agentTurn", message: "legacy job" },
          },
        ],
      }),
      "utf-8",
    );
    expect(detectCronStoreBackend(openclawDir)).toBe("json");
    const snapshot = readOpenClawCronStore(openclawDir);
    expect(snapshot.backend).toBe("json");
    expect((snapshot.store.jobs?.[0] as { name?: string }).name).toBe("maintenance-nightly");
  });

  it("writes maintenance jobs to SQLite without creating jobs.json", () => {
    homeDir = mkdtempSync(join(tmpdir(), "oc-cron-store-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "state"), { recursive: true });
    const sqlitePath = resolveOpenClawStateSqlitePath(openclawDir);
    const db = new DatabaseSync(sqlitePath);
    db.exec(CRON_JOBS_DDL);
    db.close();

    writeOpenClawCronStore(
      openclawDir,
      {
        jobs: [
          {
            id: "hybrid-mem:maintenance-nightly",
            pluginJobId: "hybrid-mem:maintenance-nightly",
            name: "maintenance-nightly",
            enabled: true,
            sessionTarget: "isolated",
            wakeMode: "now",
            schedule: { kind: "cron", expr: "5 2 * * *" },
            delivery: { mode: "none" },
            payload: { kind: "agentTurn", message: "openclaw hybrid-mem maintenance nightly --verbose" },
          },
        ],
      },
      "sqlite",
    );

    expect(detectCronStoreBackend(openclawDir)).toBe("sqlite");
    const legacyPath = resolveLegacyCronJobsPath(openclawDir);
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(legacyPath)).toBe(false);
    const reread = readOpenClawCronStore(openclawDir);
    expect(reread.store.jobs?.length).toBe(1);
  });
});
