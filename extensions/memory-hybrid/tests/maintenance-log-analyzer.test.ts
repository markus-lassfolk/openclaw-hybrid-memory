import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(() => "event-1"),
}));

import { capturePluginError } from "../services/error-reporter.js";
import {
  analyzeMaintenanceSteps,
  buildMaintenanceAnalysisReport,
  classifyMaintenanceFailure,
  collectMaintenanceSteps,
  maintenanceRules,
  persistMaintenanceFindings,
  reportGlitchTipFindings,
  shouldMaintenanceStrictFail,
  weekOverWeekTrend,
} from "../services/maintenance-log-analyzer.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "hm-maint-"));
}

describe("maintenance log analyzer", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads a data-driven rule table covering the #1199 classes", () => {
    const classes = new Set(maintenanceRules().map((r) => r.classification));
    expect(classes).toEqual(
      new Set([
        "env-misconfig",
        "transient-llm",
        "transient-network",
        "provider-auth",
        "infra",
        "plugin-bug",
        "smoke-only",
        "orchestration-bug",
      ]),
    );
  });

  it("classifies curated synthetic failures", () => {
    const cases: Array<[string, string]> = [
      ["Node.js v22.3+ is required", "env-misconfig"],
      ["429 TooManyRequests from Azure", "transient-llm"],
      ["ECONNRESET to gateway", "transient-network"],
      ["EmbeddingError 401 Unauthorized", "provider-auth"],
      ["ENOSPC disk full", "env-misconfig"],
      ["SQLITE_BUSY database is locked", "infra"],
      ["TypeError: Cannot read properties of undefined", "plugin-bug"],
      ["timeout 124 killed after 60s", "smoke-only"],
      ["agent stopped early", "orchestration-bug"],
      ["guard not updated after success", "orchestration-bug"],
      ["something bespoke", "unclassified"],
    ];
    for (const [logContent, expected] of cases) {
      expect(classifyMaintenanceFailure({ step: "step", exitCode: 1, logContent }).classification).toBe(expected);
    }
  });

  it("walks exit/log siblings, detects non-zero and exit=0 orchestration heuristics, and emits digest JSON shape", () => {
    const root = tmpRoot();
    const day = join(root, "20260507");
    mkdirSync(day, { recursive: true });
    const exitPath = join(day, "nightly-distill-20260507T021015Z-123.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(
      exitPath,
      [
        "2026-05-07T02:10:21Z prune exit=0",
        "2026-05-07T02:11:02Z distill exit=1",
        "2026-05-07T02:12:02Z guard exit=0",
      ].join("\n"),
    );
    writeFileSync(
      logPath,
      "openclaw-hybrid-memory 2026.5.64\nTypeError: Cannot read properties of undefined\nguard not updated after success\n",
    );

    const steps = collectMaintenanceSteps(root, "7d", Date.UTC(2026, 4, 8));
    const findings = analyzeMaintenanceSteps(steps);
    expect(steps).toHaveLength(3);
    expect(findings.map((f) => f.classification)).toEqual(["plugin-bug", "orchestration-bug"]);
    expect(findings[0].pluginVersion).toBe("2026.5.64");

    const report = buildMaintenanceAnalysisReport({ root, since: "7d", steps, findings });
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.byClassification["plugin-bug"]).toBe(1);
    expect(report.digestMd).toContain("Hybrid-memory maintenance digest");
    expect(report.digestMd).toContain("nightly-distill");
  });

  it("persists one row per finding and returns week-over-week trend", () => {
    const dbPath = join(tmpRoot(), "maintenance-findings.db");
    const now = Math.floor(Date.now() / 1000);
    const findings = [
      {
        id: "a",
        occurredAt: now - 3600,
        job: "nightly",
        step: "distill",
        exitCode: 1,
        classification: "plugin-bug" as const,
        ruleId: "plugin-type-error",
        fingerprint: "fp-a",
        logExcerpt: "TypeError",
        logPath: "/tmp/a.log",
        pluginVersion: "2026.5.64",
        actionTaken: "glitchtip+digest" as const,
        suggestedAction: "fix",
        severity: "high" as const,
      },
      {
        id: "b",
        occurredAt: now - 8 * 24 * 3600,
        job: "weekly",
        step: "reflect",
        exitCode: 1,
        classification: "provider-auth" as const,
        ruleId: "embedding-auth",
        fingerprint: "fp-b",
        logExcerpt: "401",
        logPath: "/tmp/b.log",
        pluginVersion: null,
        actionTaken: "escalate-user" as const,
        suggestedAction: "auth",
        severity: "high" as const,
      },
    ];
    persistMaintenanceFindings(dbPath, findings);
    const db = new DatabaseSync(dbPath);
    try {
      const count = db.prepare("SELECT COUNT(*) AS c FROM maintenance_finding").get() as { c: number };
      expect(count.c).toBe(2);
    } finally {
      db.close();
    }
    const trend = weekOverWeekTrend(dbPath, now);
    expect(trend.find((r) => r.classification === "plugin-bug")?.currentWeek).toBe(1);
    expect(trend.find((r) => r.classification === "provider-auth")?.previousWeek).toBe(1);
  });

  it("reports only plugin/orchestration findings to GlitchTip and strict fails only actionable classes", () => {
    const base = {
      id: "a",
      occurredAt: Math.floor(Date.now() / 1000),
      job: "job",
      step: "step",
      exitCode: 1,
      ruleId: "x",
      fingerprint: "fp",
      logExcerpt: "x",
      logPath: "x.log",
      pluginVersion: null,
      actionTaken: "user-digest" as const,
      suggestedAction: "x",
      severity: "high" as const,
    };
    const findings = reportGlitchTipFindings([
      { ...base, id: "plugin", classification: "plugin-bug" as const },
      { ...base, id: "orch", classification: "orchestration-bug" as const },
      { ...base, id: "auth", classification: "provider-auth" as const },
      { ...base, id: "smoke", classification: "smoke-only" as const, severity: "info" as const },
    ]);
    expect(capturePluginError).toHaveBeenCalledTimes(2);
    expect(findings.filter((f) => f.glitchtipEventId === "event-1")).toHaveLength(2);
    expect(shouldMaintenanceStrictFail(findings)).toBe(true);
    expect(shouldMaintenanceStrictFail([findings[3]])).toBe(false);
  });
});
