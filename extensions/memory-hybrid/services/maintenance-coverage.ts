/**
 * Maintenance data coverage report for offline QA and ops.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkflowStore } from "../backends/workflow-store.js";
import { formatDateUtc, formatTimestampUtc } from "../utils/dates.js";
import { countDailyLogFiles, resolveDailyMemoryDir } from "./daily-log-synthesizer.js";
import { countRecallEventsSince } from "./recall-events.js";
import { countReflectionParseFailuresSince } from "./reflection-parse-log.js";
import { countSessionMetadataSince } from "./session-metadata.js";

export type MaintenanceCoverageStatus = "ok" | "warn" | "fail" | "not-configured";

/** Per-metric classification (#2097): status, where the value came from, and how to act on it. */
export type MaintenanceCoverageMetricStatus = {
  status: MaintenanceCoverageStatus;
  sourcePath: string;
  remediation?: string;
};

export type MaintenanceCoverageReport = {
  days: number;
  sinceSec: number;
  recallEvents: number;
  implicitSignals: number;
  feedbackTrajectories: number;
  dailyLogFiles: number;
  dailyLogDirExists: boolean;
  sessionMetadataRows: number;
  workflowTraces: number;
  workflowSystemTraces: number | null;
  workflowUserFacingTraces: number | null;
  proposalRuns: number;
  reflectionWatermarkAgeSec: number | null;
  reflectionParseFailures: number;
  sessionLangs: Record<string, number>;
  /** Per-metric ok/warn/fail/not-configured classification, keyed by the same names used above. */
  metrics: Record<string, MaintenanceCoverageMetricStatus>;
};

const REFLECTION_WATERMARK_WARN_SEC = 3 * 86400;
const REFLECTION_WATERMARK_FAIL_SEC = 14 * 86400;

/**
 * Classify each coverage metric as ok/warn/fail/not-configured with a source and remediation
 * (#2097). Volume counters that are legitimately zero during a quiet window (recall events,
 * implicit signals, workflow traces, proposal runs) are always "ok" — a low/zero count is not
 * itself a problem. The four metrics the issue specifically flagged as ambiguous get real
 * classification: daily_log_files distinguishes "directory never created" (not-configured) from
 * "directory exists but nothing written in the window" (warn); session_metadata and session_langs
 * (same backing table) warn on zero rows rather than silently reading as healthy;
 * reflection_watermark_age_sec treats "never run yet" as not-configured (not a failure on a fresh
 * install) and ages the value into warn/fail buckets otherwise.
 */
export function classifyMaintenanceCoverageMetrics(
  fields: Pick<
    MaintenanceCoverageReport,
    | "recallEvents"
    | "implicitSignals"
    | "feedbackTrajectories"
    | "dailyLogFiles"
    | "dailyLogDirExists"
    | "sessionMetadataRows"
    | "workflowTraces"
    | "proposalRuns"
    | "reflectionWatermarkAgeSec"
    | "reflectionParseFailures"
    | "sessionLangs"
  >,
  paths: { factsDbPath: string; workflowDbPath?: string; proposalsDbPath?: string; dailyLogDir: string },
): Record<string, MaintenanceCoverageMetricStatus> {
  const metrics: Record<string, MaintenanceCoverageMetricStatus> = {
    recallEvents: { status: "ok", sourcePath: paths.factsDbPath },
    implicitSignals: { status: "ok", sourcePath: paths.factsDbPath },
    feedbackTrajectories: { status: "ok", sourcePath: paths.factsDbPath },
    workflowTraces: { status: "ok", sourcePath: paths.workflowDbPath ?? "(not configured)" },
    proposalRuns: { status: "ok", sourcePath: paths.proposalsDbPath ?? "(not configured)" },
    reflectionParseFailures:
      fields.reflectionParseFailures > 0
        ? {
            status: "warn",
            sourcePath: paths.factsDbPath,
            remediation:
              "Inspect reflection_parse_log for the failing task; malformed LLM output usually self-heals next run.",
          }
        : { status: "ok", sourcePath: paths.factsDbPath },
  };

  if (!fields.dailyLogDirExists) {
    metrics.dailyLogFiles = {
      status: "not-configured",
      sourcePath: paths.dailyLogDir,
      remediation: "Daily log synthesis directory does not exist yet; it is created on first daily summary write.",
    };
  } else if (fields.dailyLogFiles === 0) {
    metrics.dailyLogFiles = {
      status: "warn",
      sourcePath: paths.dailyLogDir,
      remediation:
        "Directory exists but no daily-*.md files were written in the window; check the daily-log-synthesizer cron step.",
    };
  } else {
    metrics.dailyLogFiles = { status: "ok", sourcePath: paths.dailyLogDir };
  }

  const sessionLangCount = Object.keys(fields.sessionLangs).length;
  if (fields.sessionMetadataRows === 0) {
    metrics.sessionMetadata = {
      status: "warn",
      sourcePath: paths.factsDbPath,
      remediation:
        "session_metadata has 0 rows scanned in the window; verify the coverage probe points at the live facts.db and that session scanning is running.",
    };
    metrics.sessionLangs = {
      status: "warn",
      sourcePath: paths.factsDbPath,
      remediation: "No detected session languages in the window — follows from session_metadata being empty.",
    };
  } else {
    metrics.sessionMetadata = { status: "ok", sourcePath: paths.factsDbPath };
    metrics.sessionLangs =
      sessionLangCount === 0
        ? {
            status: "warn",
            sourcePath: paths.factsDbPath,
            remediation: "session_metadata rows exist but none have a detected_lang value.",
          }
        : { status: "ok", sourcePath: paths.factsDbPath };
  }

  if (fields.reflectionWatermarkAgeSec == null) {
    metrics.reflectionWatermarkAgeSec = {
      status: "not-configured",
      sourcePath: paths.factsDbPath,
      remediation: "Reflection has never run yet; the watermark is set on its first run.",
    };
  } else if (fields.reflectionWatermarkAgeSec > REFLECTION_WATERMARK_FAIL_SEC) {
    metrics.reflectionWatermarkAgeSec = {
      status: "fail",
      sourcePath: paths.factsDbPath,
      remediation: "Run `hybrid-mem reflect` (or check why the nightly reflect step isn't advancing the watermark).",
    };
  } else if (fields.reflectionWatermarkAgeSec > REFLECTION_WATERMARK_WARN_SEC) {
    metrics.reflectionWatermarkAgeSec = {
      status: "warn",
      sourcePath: paths.factsDbPath,
      remediation: "Reflection watermark is aging; confirm the reflect maintenance step is still scheduled.",
    };
  } else {
    metrics.reflectionWatermarkAgeSec = { status: "ok", sourcePath: paths.factsDbPath };
  }

  return metrics;
}

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
          "SELECT detected_lang, COUNT(*) AS cnt FROM session_metadata WHERE scanned_at >= ? GROUP BY detected_lang",
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
              .prepare("SELECT COUNT(*) AS cnt FROM workflow_traces WHERE created_at >= ?")
              .get(formatTimestampUtc(sinceSec)) as { cnt: number } | undefined;
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

    const dailyLogDir = resolveDailyMemoryDir();
    const fields = {
      recallEvents: countRecallEventsSince(factsDb, sinceSec),
      implicitSignals: countTableSince(factsDb, "implicit_signals", "created_at", sinceSec),
      feedbackTrajectories: countTableSince(factsDb, "feedback_trajectories", "created_at", sinceSec),
      dailyLogFiles: countDailyLogFiles(dailyLogDir, sinceDate),
      dailyLogDirExists: existsSync(dailyLogDir),
      sessionMetadataRows: countSessionMetadataSince(factsDb, sinceSec),
      workflowTraces,
      proposalRuns,
      reflectionWatermarkAgeSec,
      reflectionParseFailures: countReflectionParseFailuresSince(factsDb, sinceSec),
      sessionLangs,
    };

    return {
      days,
      sinceSec,
      ...fields,
      workflowSystemTraces,
      workflowUserFacingTraces,
      metrics: classifyMaintenanceCoverageMetrics(fields, {
        factsDbPath: opts.factsDbPath,
        workflowDbPath: opts.workflowDbPath,
        proposalsDbPath: opts.proposalsDbPath,
        dailyLogDir,
      }),
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

const STATUS_ICON: Record<MaintenanceCoverageStatus, string> = {
  ok: "✅",
  warn: "⚠️ ",
  fail: "❌",
  "not-configured": "➖",
};

/** Render one metric line with its status icon and, when not ok, a remediation hint (#2097). */
function formatMetricLine(
  name: string,
  valueText: string,
  metric: MaintenanceCoverageMetricStatus | undefined,
): string {
  const icon = metric ? STATUS_ICON[metric.status] : "  ";
  const base = `  ${icon} ${name}: ${valueText}`;
  if (metric && metric.status !== "ok" && metric.remediation) {
    return `${base}\n       └─ ${metric.remediation}`;
  }
  return base;
}

export function formatMaintenanceCoverageReport(report: MaintenanceCoverageReport): string {
  const lines = [
    `Maintenance coverage (last ${report.days}d):`,
    formatMetricLine("recall_events", String(report.recallEvents), report.metrics.recallEvents),
    formatMetricLine("implicit_signals", String(report.implicitSignals), report.metrics.implicitSignals),
    formatMetricLine("feedback_trajectories", String(report.feedbackTrajectories), report.metrics.feedbackTrajectories),
    formatMetricLine("daily_log_files", String(report.dailyLogFiles), report.metrics.dailyLogFiles),
    formatMetricLine("session_metadata", String(report.sessionMetadataRows), report.metrics.sessionMetadata),
    formatMetricLine(
      "workflow_traces",
      `${report.workflowTraces}${
        report.workflowUserFacingTraces != null
          ? ` (user-facing=${report.workflowUserFacingTraces}, system=${report.workflowSystemTraces ?? 0})`
          : ""
      }`,
      report.metrics.workflowTraces,
    ),
    formatMetricLine("proposal_runs", String(report.proposalRuns), report.metrics.proposalRuns),
    formatMetricLine(
      "reflection_parse_failures",
      String(report.reflectionParseFailures),
      report.metrics.reflectionParseFailures,
    ),
    formatMetricLine(
      "reflection_watermark_age_sec",
      report.reflectionWatermarkAgeSec != null ? String(report.reflectionWatermarkAgeSec) : "unset",
      report.metrics.reflectionWatermarkAgeSec,
    ),
    formatMetricLine(
      "session_langs",
      Object.entries(report.sessionLangs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(none)",
      report.metrics.sessionLangs,
    ),
  ];
  return lines.join("\n");
}
