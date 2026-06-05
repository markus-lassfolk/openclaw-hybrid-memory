/**
 * Maintenance data coverage report for offline QA and ops.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countRecallEventsSince } from "./recall-events.js";
import { countSessionMetadataSince } from "./session-metadata.js";
import { countReflectionParseFailuresSince } from "./reflection-parse-log.js";
import { countDailyLogFiles, resolveDailyMemoryDir } from "./daily-log-synthesizer.js";
import { formatDateUtc } from "../utils/dates.js";
import { WorkflowStore } from "../backends/workflow-store.js";

export type MaintenanceCoverageReport = {
  days: number;
  sinceSec: number;
  recallEvents: number;
  implicitSignals: number;
  feedbackTrajectories: number;
  dailyLogFiles: number;
  sessionMetadataRows: number;
  workflowTraces: number;
  workflowSystemTraces: number | null;
  workflowUserFacingTraces: number | null;
  proposalRuns: number;
  reflectionWatermarkAgeSec: number | null;
  reflectionParseFailures: number;
  sessionLangs: Record<string, number>;
};

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

function countTableSince(db: DatabaseSync, table: string, timeCol: string, sinceSec: number): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${timeCol} >= ?`).get(sinceSec) as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}

export function buildMaintenanceCoverageReport(opts: {
  factsDbPath: string;
  workflowDbPath?: string;
  proposalsDbPath?: string;
  days?: number;
}): MaintenanceCoverageReport {
  const days = Math.max(1, opts.days ?? 7);
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;
  const sinceDate = formatDateUtc(sinceSec);

  const factsDb = new DatabaseSync(opts.factsDbPath);
  try {
    const watermarkRaw = factsDb
      .prepare("SELECT value FROM maintenance_state WHERE key = 'reflection_last_fact_created_at'")
      .get() as { value: string } | undefined;
    const watermarkSec = watermarkRaw ? Number.parseInt(watermarkRaw.value, 10) : null;
    const reflectionWatermarkAgeSec =
      watermarkSec != null && Number.isFinite(watermarkSec) ? Math.floor(Date.now() / 1000) - watermarkSec : null;

    const sessionLangs: Record<string, number> = {};
    if (tableExists(factsDb, "session_metadata")) {
      const rows = factsDb
        .prepare(
          `SELECT detected_lang, COUNT(*) AS cnt FROM session_metadata WHERE scanned_at >= ? GROUP BY detected_lang`,
        )
        .all(sinceSec) as Array<{ detected_lang: string; cnt: number }>;
      for (const row of rows) sessionLangs[row.detected_lang] = row.cnt;
    }

    let workflowTraces = 0;
    let workflowSystemTraces: number | null = null;
    let workflowUserFacingTraces: number | null = null;
    if (opts.workflowDbPath && existsSync(opts.workflowDbPath)) {
      const wfStore = new WorkflowStore(opts.workflowDbPath);
      try {
        const summary = wfStore.summarizeGoalKinds({ sinceSec });
        workflowTraces = summary.total;
        workflowSystemTraces = summary.systemGoals;
        workflowUserFacingTraces = summary.userFacing;
      } catch {
        const wfDb = new DatabaseSync(opts.workflowDbPath);
        try {
          if (tableExists(wfDb, "workflow_traces")) {
            const row = wfDb
              .prepare(`SELECT COUNT(*) AS cnt FROM workflow_traces WHERE created_at >= datetime(?, 'unixepoch')`)
              .get(sinceSec) as { cnt: number } | undefined;
            workflowTraces = row?.cnt ?? 0;
          }
        } finally {
          wfDb.close();
        }
      } finally {
        wfStore.close();
      }
    }

    let proposalRuns = 0;
    if (opts.proposalsDbPath && existsSync(opts.proposalsDbPath)) {
      const propDb = new DatabaseSync(opts.proposalsDbPath);
      try {
        if (tableExists(propDb, "proposal_runs")) {
          proposalRuns = countTableSince(propDb, "proposal_runs", "run_at", sinceSec);
        }
      } finally {
        propDb.close();
      }
    }

    return {
      days,
      sinceSec,
      recallEvents: countRecallEventsSince(factsDb, sinceSec),
      implicitSignals: countTableSince(factsDb, "implicit_signals", "created_at", sinceSec),
      feedbackTrajectories: countTableSince(factsDb, "feedback_trajectories", "created_at", sinceSec),
      dailyLogFiles: countDailyLogFiles(resolveDailyMemoryDir(), sinceDate),
      sessionMetadataRows: countSessionMetadataSince(factsDb, sinceSec),
      workflowTraces,
      workflowSystemTraces,
      workflowUserFacingTraces,
      proposalRuns,
      reflectionWatermarkAgeSec,
      reflectionParseFailures: countReflectionParseFailuresSince(factsDb, sinceSec),
      sessionLangs,
    };
  } finally {
    factsDb.close();
  }
}

export function defaultFactsDbPath(): string {
  return join(homedir(), ".openclaw", "memory", "facts.db");
}

export function defaultWorkflowDbPath(): string {
  return join(homedir(), ".openclaw", "memory", "workflow-traces.db");
}

export function defaultProposalsDbPath(): string {
  return join(homedir(), ".openclaw", "memory", "proposals.db");
}

export function formatMaintenanceCoverageReport(report: MaintenanceCoverageReport): string {
  const lines = [
    `Maintenance coverage (last ${report.days}d):`,
    `  recall_events: ${report.recallEvents}`,
    `  implicit_signals: ${report.implicitSignals}`,
    `  feedback_trajectories: ${report.feedbackTrajectories}`,
    `  daily_log_files: ${report.dailyLogFiles}`,
    `  session_metadata: ${report.sessionMetadataRows}`,
    `  workflow_traces: ${report.workflowTraces}${
      report.workflowUserFacingTraces != null
        ? ` (user-facing=${report.workflowUserFacingTraces}, system=${report.workflowSystemTraces ?? 0})`
        : ""
    }`,
    `  proposal_runs: ${report.proposalRuns}`,
    `  reflection_parse_failures: ${report.reflectionParseFailures}`,
    `  reflection_watermark_age_sec: ${report.reflectionWatermarkAgeSec ?? "unset"}`,
    `  session_langs: ${Object.entries(report.sessionLangs).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}
