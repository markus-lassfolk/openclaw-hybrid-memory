/**
 * Regression tests for #2097: `maintenance-coverage` printed raw counts with no way to tell a
 * healthy zero (quiet window) from a genuinely broken probe (wrong path, disconnected ingestion,
 * stale watermark). classifyMaintenanceCoverageMetrics assigns each metric an
 * ok/warn/fail/not-configured status plus a source path and remediation hint.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import {
  buildMaintenanceCoverageReport,
  classifyMaintenanceCoverageMetrics,
  formatMaintenanceCoverageReport,
} from "../services/maintenance-coverage.js";

const { FactsDB } = _testing;

const PATHS = {
  factsDbPath: "/tmp/facts.db",
  workflowDbPath: "/tmp/workflow-traces.db",
  proposalsDbPath: "/tmp/proposals.db",
  dailyLogDir: "/tmp/memory",
};

function baseFields(overrides: Partial<Parameters<typeof classifyMaintenanceCoverageMetrics>[0]> = {}) {
  return {
    recallEvents: 4,
    implicitSignals: 700,
    feedbackTrajectories: 388,
    dailyLogFiles: 3,
    dailyLogDirExists: true,
    sessionMetadataRows: 5,
    workflowTraces: 4,
    proposalRuns: 3,
    reflectionWatermarkAgeSec: 3600,
    reflectionParseFailures: 0,
    sessionLangs: { en: 5 },
    ...overrides,
  };
}

describe("classifyMaintenanceCoverageMetrics (#2097)", () => {
  it("classifies a fully healthy window as ok across every metric", () => {
    const metrics = classifyMaintenanceCoverageMetrics(baseFields(), PATHS);
    for (const key of Object.keys(metrics)) {
      expect(metrics[key].status, `${key} should be ok`).toBe("ok");
      expect(metrics[key].sourcePath).toBeTruthy();
    }
  });

  it("treats a zero volume counter (recall_events, implicit_signals, etc.) as ok, not a problem", () => {
    const metrics = classifyMaintenanceCoverageMetrics(
      baseFields({ recallEvents: 0, implicitSignals: 0, feedbackTrajectories: 0, workflowTraces: 0, proposalRuns: 0 }),
      PATHS,
    );
    expect(metrics.recallEvents.status).toBe("ok");
    expect(metrics.implicitSignals.status).toBe("ok");
    expect(metrics.feedbackTrajectories.status).toBe("ok");
    expect(metrics.workflowTraces.status).toBe("ok");
    expect(metrics.proposalRuns.status).toBe("ok");
  });

  it("daily_log_files: not-configured when the directory has never been created", () => {
    const metrics = classifyMaintenanceCoverageMetrics(
      baseFields({ dailyLogDirExists: false, dailyLogFiles: 0 }),
      PATHS,
    );
    expect(metrics.dailyLogFiles.status).toBe("not-configured");
    expect(metrics.dailyLogFiles.sourcePath).toBe(PATHS.dailyLogDir);
  });

  it("daily_log_files: warn when the directory exists but nothing was written in the window", () => {
    const metrics = classifyMaintenanceCoverageMetrics(
      baseFields({ dailyLogDirExists: true, dailyLogFiles: 0 }),
      PATHS,
    );
    expect(metrics.dailyLogFiles.status).toBe("warn");
    expect(metrics.dailyLogFiles.remediation).toMatch(/daily-log-synthesizer/);
  });

  it("daily_log_files: ok when the directory exists and has files in the window", () => {
    const metrics = classifyMaintenanceCoverageMetrics(
      baseFields({ dailyLogDirExists: true, dailyLogFiles: 12 }),
      PATHS,
    );
    expect(metrics.dailyLogFiles.status).toBe("ok");
  });

  it("session_metadata + session_langs: warn together when session_metadata has 0 rows", () => {
    const metrics = classifyMaintenanceCoverageMetrics(baseFields({ sessionMetadataRows: 0, sessionLangs: {} }), PATHS);
    expect(metrics.sessionMetadata.status).toBe("warn");
    expect(metrics.sessionMetadata.remediation).toMatch(/facts\.db/);
    expect(metrics.sessionLangs.status).toBe("warn");
  });

  it("session_langs: warn when session_metadata has rows but none carry a detected language", () => {
    const metrics = classifyMaintenanceCoverageMetrics(baseFields({ sessionMetadataRows: 5, sessionLangs: {} }), PATHS);
    expect(metrics.sessionMetadata.status).toBe("ok");
    expect(metrics.sessionLangs.status).toBe("warn");
  });

  it("session_metadata + session_langs: ok when rows and languages are both present", () => {
    const metrics = classifyMaintenanceCoverageMetrics(
      baseFields({ sessionMetadataRows: 5, sessionLangs: { en: 3, sv: 2 } }),
      PATHS,
    );
    expect(metrics.sessionMetadata.status).toBe("ok");
    expect(metrics.sessionLangs.status).toBe("ok");
  });

  it("reflection_watermark_age_sec: not-configured when reflection has never run", () => {
    const metrics = classifyMaintenanceCoverageMetrics(baseFields({ reflectionWatermarkAgeSec: null }), PATHS);
    expect(metrics.reflectionWatermarkAgeSec.status).toBe("not-configured");
  });

  it("reflection_watermark_age_sec: ok when recent, warn past 3 days, fail past 14 days", () => {
    const oneDay = 86400;
    const ok = classifyMaintenanceCoverageMetrics(baseFields({ reflectionWatermarkAgeSec: oneDay }), PATHS);
    expect(ok.reflectionWatermarkAgeSec.status).toBe("ok");

    const warn = classifyMaintenanceCoverageMetrics(baseFields({ reflectionWatermarkAgeSec: 5 * oneDay }), PATHS);
    expect(warn.reflectionWatermarkAgeSec.status).toBe("warn");

    // The issue's own reported example: ~36 days stale.
    const fail = classifyMaintenanceCoverageMetrics(baseFields({ reflectionWatermarkAgeSec: 36 * oneDay }), PATHS);
    expect(fail.reflectionWatermarkAgeSec.status).toBe("fail");
    expect(fail.reflectionWatermarkAgeSec.remediation).toMatch(/reflect/);
  });

  it("reflection_parse_failures: warn when any failures are present in the window", () => {
    const metrics = classifyMaintenanceCoverageMetrics(baseFields({ reflectionParseFailures: 2 }), PATHS);
    expect(metrics.reflectionParseFailures.status).toBe("warn");
  });
});

describe("formatMaintenanceCoverageReport renders status icons and remediation (#2097)", () => {
  it("includes a remediation line for a non-ok metric", () => {
    const text = formatMaintenanceCoverageReport({
      days: 7,
      sinceSec: 0,
      recallEvents: 4,
      implicitSignals: 700,
      feedbackTrajectories: 388,
      dailyLogFiles: 0,
      dailyLogDirExists: false,
      sessionMetadataRows: 0,
      workflowTraces: 4,
      workflowSystemTraces: 0,
      workflowUserFacingTraces: 4,
      proposalRuns: 3,
      reflectionWatermarkAgeSec: 36 * 86400,
      reflectionParseFailures: 0,
      sessionLangs: {},
      metrics: classifyMaintenanceCoverageMetrics(
        baseFields({
          dailyLogDirExists: false,
          dailyLogFiles: 0,
          sessionMetadataRows: 0,
          sessionLangs: {},
          reflectionWatermarkAgeSec: 36 * 86400,
        }),
        PATHS,
      ),
    });

    expect(text).toContain("➖");
    expect(text).toContain("⚠️");
    expect(text).toContain("❌");
    expect(text).toMatch(/└─/);
  });
});

describe("buildMaintenanceCoverageReport wires the metrics field end-to-end (#2097)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks reflection_watermark_age_sec not-configured on a fresh store with no watermark yet", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-coverage-"));
    const dbPath = join(tmpDir, "facts.db");
    const db = new FactsDB(dbPath);
    db.close();

    const report = buildMaintenanceCoverageReport({ factsDbPath: dbPath, days: 7 });

    expect(report.reflectionWatermarkAgeSec).toBeNull();
    expect(report.metrics.reflectionWatermarkAgeSec.status).toBe("not-configured");
    expect(report.metrics.recallEvents.status).toBe("ok");
    expect(report.metrics.sessionMetadata.sourcePath).toBe(dbPath);
  });

  it("marks session_metadata warn on a fresh store with the table present but zero rows scanned", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-coverage-"));
    const dbPath = join(tmpDir, "facts.db");
    const db = new FactsDB(dbPath);
    db.close();

    const report = buildMaintenanceCoverageReport({ factsDbPath: dbPath, days: 7 });

    expect(report.sessionMetadataRows).toBe(0);
    expect(report.metrics.sessionMetadata.status).toBe("warn");
    expect(report.metrics.sessionLangs.status).toBe("warn");
  });
});
