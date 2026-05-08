import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(() => "event-1"),
}));

import { capturePluginError } from "../services/error-reporter.js";
import {
  applyHeavyMaintenanceAutoFixes,
  applyMaintenanceAutoFix,
  clearStaleLock,
} from "../services/maintenance-auto-fix.js";
import {
  analyzeMaintenanceSteps,
  buildMaintenanceAnalysisReport,
  classifyMaintenanceFailure,
  collectMaintenanceSteps,
  countPersistedSqliteBusySince,
  maintenanceRules,
  persistMaintenanceFindings,
  pluginVersionGte,
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
      ["Node.js v22.12+ is required", "env-misconfig"],
      [
        'Unknown command: openclaw hybrid-mem. No built-in command or plugin CLI metadata owns "hybrid-mem".',
        "env-misconfig",
      ],
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

  it("pluginVersionGte compares dotted plugin versions for resolved-issue suppression", () => {
    expect(pluginVersionGte("2026.5.64", "2026.5.63")).toBe(true);
    expect(pluginVersionGte("2026.5.64", "2026.5.64")).toBe(true);
    expect(pluginVersionGte("2026.5.63", "2026.5.64")).toBe(false);
    expect(pluginVersionGte(null, "1.0.0")).toBe(false);
  });

  it("suppresses findings when fingerprint is listed and pluginVersion meets resolvedInVersion", () => {
    const root = tmpRoot();
    const day = join(root, "20260507");
    mkdirSync(day, { recursive: true });
    const exitPath = join(day, "nightly-distill-20260507T021015Z-123.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, ["2026-05-07T02:11:02Z distill exit=1"].join("\n"));
    writeFileSync(logPath, "openclaw-hybrid-memory 2026.5.64\nTypeError: boom\n");

    const steps = collectMaintenanceSteps(root, "7d", Date.UTC(2026, 4, 8));
    const findings = analyzeMaintenanceSteps(steps);
    expect(findings).toHaveLength(1);
    const fp = findings[0].fingerprint;
    const empty = analyzeMaintenanceSteps(steps, {
      resolvedFingerprints: { [fp]: { resolvedInVersion: "2026.5.64", note: "fixed in release" } },
    });
    expect(empty).toHaveLength(0);
    const stillThere = analyzeMaintenanceSteps(steps, {
      resolvedFingerprints: { [fp]: { resolvedInVersion: "2026.6.0", note: "future" } },
    });
    expect(stillThere).toHaveLength(1);
  });

  it("clearStaleLock removes dead PID locks and applyMaintenanceAutoFix clears sqlite-busy paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-lock-"));
    const lock = join(dir, "scan.lock");
    writeFileSync(lock, "999999999\n");
    const cleared = clearStaleLock(lock);
    expect(cleared.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);

    const live = join(dir, "live.lock");
    writeFileSync(live, `${process.pid}\n`);
    expect(clearStaleLock(live).ok).toBe(false);

    const stalePath = join(dir, "stale.lock");
    writeFileSync(stalePath, "999999998\n");
    const fixed = applyMaintenanceAutoFix({
      id: "x",
      occurredAt: 1,
      job: "j",
      step: "s",
      exitCode: 1,
      classification: "infra",
      ruleId: "sqlite-busy",
      fingerprint: "fp",
      logExcerpt: `SQLITE_BUSY database is locked\n${stalePath}`,
      logPath: "/tmp/x.log",
      pluginVersion: null,
      actionTaken: "retry-once",
      suggestedAction: "retry",
      severity: "medium",
    });
    expect(fixed.actionTaken).toBe("auto-fixed-clear-stale-lock");
    expect(existsSync(stalePath)).toBe(false);
  });

  it("countPersistedSqliteBusySince counts SQLITE_BUSY rows in window (#1199)", () => {
    const dbPath = join(tmpRoot(), "busy-count.db");
    const now = Math.floor(Date.now() / 1000);
    persistMaintenanceFindings(dbPath, [
      {
        id: "b1",
        occurredAt: now - 120,
        job: "j",
        step: "s",
        exitCode: 1,
        classification: "infra",
        ruleId: "sqlite-busy",
        fingerprint: "fp1",
        logExcerpt: "SQLITE_BUSY database is locked",
        logPath: "/tmp/x.log",
        pluginVersion: null,
        actionTaken: "retry-once",
        suggestedAction: "retry",
        severity: "medium",
      },
    ]);
    expect(countPersistedSqliteBusySince(dbPath, now - 3600)).toBe(1);
    expect(countPersistedSqliteBusySince(dbPath, now)).toBe(0);
  });

  it("applyHeavyMaintenanceAutoFixes runs vacuum + CLI hooks when SQLITE_BUSY repeats (#1199)", () => {
    const dir = tmpRoot();
    const dbPath = join(dir, "facts.db");
    const findingsPath = join(dir, "maint.db");
    const factsDb = new FactsDB(dbPath);
    const now = Math.floor(Date.now() / 1000);
    persistMaintenanceFindings(findingsPath, [
      {
        id: "old",
        occurredAt: now - 4000,
        job: "j",
        step: "s",
        exitCode: 1,
        classification: "infra",
        ruleId: "sqlite-busy",
        fingerprint: "fp-old",
        logExcerpt: "SQLITE_BUSY",
        logPath: "/tmp/old.log",
        pluginVersion: null,
        actionTaken: "retry-once",
        suggestedAction: "retry",
        severity: "medium",
      },
    ]);

    const calls: string[][] = [];
    const findings = [
      {
        id: "new",
        occurredAt: now,
        job: "j",
        step: "s",
        exitCode: 1,
        classification: "infra" as const,
        ruleId: "sqlite-busy",
        fingerprint: "fp-new",
        logExcerpt: "SQLITE_BUSY",
        logPath: "/tmp/new.log",
        pluginVersion: null,
        actionTaken: "retry-once" as const,
        suggestedAction: "retry",
        severity: "medium" as const,
      },
    ];

    const out = applyHeavyMaintenanceAutoFixes({
      findings,
      findingsDbPath: findingsPath,
      factsDb,
      sqliteBusyWindowSec: 86_400,
      spawnOpenclaw: (args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    expect(out[0]?.actionTaken).toBe("auto-fixed-vacuum-on-busy");
    expect(calls.some((c) => c[0] === "hybrid-mem" && c[1] === "vectordb-optimize")).toBe(true);

    const outEmbed = applyHeavyMaintenanceAutoFixes({
      findings: [
        {
          ...findings[0],
          ruleId: "embedding-auth",
          classification: "provider-auth",
        },
      ],
      findingsDbPath: join(dir, "empty.db"),
      factsDb,
      spawnOpenclaw: (args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(outEmbed[0]?.actionTaken).toBe("auto-fixed-reembed-vectorless");
    expect(calls.some((c) => c.includes("reembed-vectorless") && c.includes("--limit"))).toBe(true);

    factsDb.close();
  });
});
