import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { runAnalyzeMaintenanceLogs } from "../cli/commands/manage/register-analyze-maintenance-logs.js";
import { _testing } from "../index.js";
import { formatTimestampUtcFromMs } from "../utils/dates.js";

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
  findingFromStep,
  isCanonicalMaintenanceLog,
  isUnderAuxiliaryDir,
  maintenanceRules,
  persistMaintenanceFindings,
  pluginVersionGte,
  reportGlitchTipFindings,
  shouldMaintenanceStrictFail,
  summarizeMaintenanceFindings,
  summarizeMaintenanceLogAnalysis,
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
        "json-parse-failure",
        "smoke-only",
        "orchestration-bug",
      ]),
    );
  });

  it("classifies curated synthetic failures", () => {
    const cases: Array<[string, string]> = [
      ["Node.js v22.16+ is required", "env-misconfig"],
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

  it("ignores benign zero-error strings in excerpts while keeping real failure signals", () => {
    const finding = findingFromStep(
      {
        occurredAt: Date.now() / 1000,
        iso: new Date().toISOString(),
        job: "nightly-memory-sweep",
        step: "self-correction-analysis",
        exitCode: 1,
        exitPath: "/tmp/nightly.exit.txt",
        line: "self-correction-analysis exit=1",
        logPath: "/tmp/nightly.log",
        logContent: [
          "self-correction-analysis summary: errorCount=0 warningCount=0",
          "No errors detected in dry section",
          "Unhandled exception: parser timeout",
        ].join("\n"),
      },
      classifyMaintenanceFailure({
        step: "self-correction-analysis",
        exitCode: 1,
        logContent: "Unhandled exception: parser timeout",
      }),
    );

    expect(finding.logExcerpt).toContain("Unhandled exception: parser timeout");
    expect(finding.logExcerpt).not.toContain("errorCount=0");
    expect(finding.logExcerpt).not.toContain("No errors detected");
  });

  it("keeps actionable failure excerpts when benign counters appear on the same line", () => {
    const finding = findingFromStep(
      {
        occurredAt: Date.now() / 1000,
        iso: new Date().toISOString(),
        job: "nightly-memory-sweep",
        step: "self-correction-analysis",
        exitCode: 1,
        exitPath: "/tmp/nightly.exit.txt",
        line: "self-correction-analysis exit=1",
        logPath: "/tmp/nightly.log",
        logContent: [
          "summary: errorCount=0 warningCount=0",
          "summary: errorCount=0 but Unhandled exception: parser timeout",
          "No failures reported before final command failed with timeout",
        ].join("\n"),
      },
      classifyMaintenanceFailure({
        step: "self-correction-analysis",
        exitCode: 1,
        logContent: "Unhandled exception: parser timeout",
      }),
    );

    expect(finding.logExcerpt).toContain("summary: errorCount=0 but Unhandled exception: parser timeout");
    expect(finding.logExcerpt).toContain("No failures reported before final command failed with timeout");
    expect(finding.logExcerpt).not.toContain("summary: errorCount=0 warningCount=0");
  });

  it("collects benign SDK and Codex warnings in noiseWarnings without actionable findings", () => {
    const steps = [
      {
        occurredAt: Math.floor(Date.now() / 1000),
        iso: new Date().toISOString(),
        job: "weekly-reflection",
        step: "reflect",
        exitCode: 0,
        exitPath: "/tmp/reflect.exit.txt",
        line: "reflect exit=0",
        logPath: "/tmp/reflect.log",
        logContent: [
          "memory-hybrid: registerContextEngine not found in SDK; skipping ContextEngine registration",
          "[agent/embedded] codex app-server stderr: ERROR codex_app_server: Ignored unsupported project-local config keys in /mnt/openclaw/.openclaw/workspace/.codex/config.toml: model_provider, model_providers, profiles. If you want these settings to apply, manually set them in your user-level config.toml.",
        ].join("\n"),
      },
    ];

    const findings = analyzeMaintenanceSteps(steps);
    expect(findings).toHaveLength(0);

    const report = buildMaintenanceAnalysisReport({ since: "24h", steps, findings });
    expect(report.noiseWarnings).toHaveLength(2);
    expect(report.noiseWarnings.map((w) => w.patternId)).toEqual(
      expect.arrayContaining(["register-context-engine-missing", "codex-unsupported-project-local-config"]),
    );
    expect(report.noiseWarnings.every((w) => w.classification === "benign_noise")).toBe(true);
    expect(report.digestMd).toContain("Benign noise (suppressed from failure counts)");
    expect(report.digestMd).toContain("register-context-engine-missing");
  });

  it("suppresses benign-noise-only non-zero steps but keeps co-occurring actionable failures", () => {
    const benignOnly = analyzeMaintenanceSteps([
      {
        occurredAt: Math.floor(Date.now() / 1000),
        iso: new Date().toISOString(),
        job: "weekly-reflection",
        step: "reflect",
        exitCode: 1,
        exitPath: "/tmp/reflect.exit.txt",
        line: "reflect exit=1",
        logPath: "/tmp/reflect.log",
        logContent:
          "ERROR codex_app_server: Ignored unsupported project-local config keys in /mnt/openclaw/.openclaw/workspace/.codex/config.toml: model_provider, model_providers, profiles.",
      },
    ]);
    expect(benignOnly).toHaveLength(0);

    const actionable = analyzeMaintenanceSteps([
      {
        occurredAt: Math.floor(Date.now() / 1000),
        iso: new Date().toISOString(),
        job: "weekly-reflection",
        step: "reflect",
        exitCode: 1,
        exitPath: "/tmp/reflect.exit.txt",
        line: "reflect exit=1",
        logPath: "/tmp/reflect.log",
        logContent: [
          "ERROR codex_app_server: Ignored unsupported project-local config keys in /mnt/openclaw/.openclaw/workspace/.codex/config.toml: model_provider, model_providers, profiles.",
          "Unhandled exception: parser timeout",
        ].join("\n"),
      },
    ]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0]?.logExcerpt).toContain("Unhandled exception: parser timeout");
    expect(actionable[0]?.logExcerpt).not.toContain("codex_app_server");
  });

  it("classifies cron wrapper PATH failure (openclaw binary not in PATH) as env-misconfig", () => {
    // This reproduces the real-world cron failure:
    //   /usr/bin/timeout: failed to run command 'openclaw': No such file or directory
    const cronPathFailures = [
      "/usr/bin/timeout: failed to run command 'openclaw': No such file or directory",
      "bash: openclaw: command not found",
      "command not found: openclaw",
      "/usr/bin/env: 'openclaw': No such file or directory",
    ];
    for (const logContent of cronPathFailures) {
      const result = classifyMaintenanceFailure({ step: "nightly-memory-sweep", exitCode: 127, logContent });
      expect(result.classification).toBe("env-misconfig");
      expect(result.severity).toBe("high");
    }
  });

  it("distinguishes audit-health strict failures from command crashes", () => {
    const strictWarnings = JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-09T15:06:34Z",
        status: "partial",
        ok: false,
        warningCount: 2,
        errorCount: 0,
        activeFacts: 1,
        warnings: ["w1", "w2"],
        remediation: [],
        errors: [],
        exitCode: 2,
        exitReason: "strict_warnings",
        strictFailureReason: "2 warning(s) present and --strict was set",
      },
      null,
      2,
    );
    const a = classifyMaintenanceFailure({ step: "audit-health", exitCode: 2, logContent: strictWarnings });
    expect(a.classification).toBe("health-warnings");
    expect(a.id).toBe("audit-health-strict-warnings");

    const crash = classifyMaintenanceFailure({ step: "audit-health", exitCode: 2, logContent: "no json here" });
    expect(crash.classification).toBe("command-crash");
    expect(crash.id).toBe("audit-health-command-crash");
  });

  it("lets generic rules classify audit-health crashes before falling back to command-crash", () => {
    const auth = classifyMaintenanceFailure({
      step: "audit-health",
      exitCode: 1,
      logContent: "EmbeddingError: 401 Unauthorized while checking provider health",
    });

    expect(auth.classification).toBe("provider-auth");
    expect(auth.id).toBe("embedding-auth");
  });

  it("extracts audit-health JSON containing escaped quotes and brace characters", () => {
    const logContent = [
      "preamble",
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: "2026-05-09T15:06:34Z",
          status: "partial",
          ok: false,
          warningCount: 1,
          errorCount: 0,
          activeFacts: 1,
          warnings: ['quoted "brace { inside}" warning'],
          remediation: [],
          errors: [],
          exitCode: 2,
          exitReason: "strict_warnings",
          strictFailureReason: '1 warning(s) with "quoted { text }" and --strict was set',
        },
        null,
        2,
      ),
      "tail",
    ].join("\n");

    const result = classifyMaintenanceFailure({ step: "audit-health", exitCode: 2, logContent });

    expect(result.classification).toBe("health-warnings");
    expect(result.id).toBe("audit-health-strict-warnings");
  });

  it("classifies audit-health json-parse-failure as json-parse-failure class (not command-crash)", () => {
    // Reproduces the real-world failure from issue #1637:
    // audit-health exits 2 and the log contains a recognisable but truncated/malformed JSON block.
    // extractAuditHealthJsonFromLog triggers parse_error when both "schemaVersion":1 AND "activeFacts":
    // are present but no valid JSON object can be extracted — matching the real broken-output scenario.
    const malformedLog = [
      "preamble from openclaw audit health",
      // Truncated mid-object — contains the two heuristic markers but closing brace is missing
      '{"schemaVersion":1,"activeFacts":42,"generatedAt":"2026-05-09T15:06:34Z","status":"partial","ok":false,',
      "tail: process exited unexpectedly",
    ].join("\n");

    const result = classifyMaintenanceFailure({ step: "audit-health", exitCode: 2, logContent: malformedLog });
    expect(result.classification).toBe("json-parse-failure");
    expect(result.id).toBe("audit-health-json-parse-failure");
    expect(result.severity).toBe("high");
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
      "openclaw-hybrid-memory 2026.5.81\nTypeError: Cannot read properties of undefined\nguard not updated after success\n",
    );

    const steps = collectMaintenanceSteps(root, "7d", Date.UTC(2026, 4, 8));
    const findings = analyzeMaintenanceSteps(steps);
    expect(steps).toHaveLength(3);
    expect(findings.map((f) => f.classification)).toEqual(["plugin-bug", "orchestration-bug"]);
    expect(findings[0].pluginVersion).toBe("2026.5.81");

    const report = buildMaintenanceAnalysisReport({ root, since: "7d", steps, findings });
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.byClassification["plugin-bug"]).toBe(1);
    expect(report.digestMd).toContain("Hybrid-memory maintenance digest");
    expect(report.digestMd).toContain("nightly-distill");
  });

  it("ingests orchestrator summary.json inner step failures (#1891)", () => {
    const root = tmpRoot();
    const day = join(root, "20260605");
    mkdirSync(day, { recursive: true });
    const summaryPath = join(day, "maintenance-nightly-20260605T030000Z-42.summary.json");
    const logPath = summaryPath.replace(/\.summary\.json$/, ".log");
    const exitPath = summaryPath.replace(/\.summary\.json$/, ".exit.txt");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        runId: "20260605T030000Z-42",
        tierLabel: "nightly",
        finishedAt: "2026-06-05T03:15:00.000Z",
        exitCode: 1,
        steps: [
          { name: "distill", status: "ok", summary: "stored=12 sessions=3" },
          {
            name: "self-correction-run",
            status: "failed",
            summary: "semantic=failed_semantic_empty jobRunId=distill-abc",
          },
          { name: "extract-reinforcement", status: "skipped_guard", summary: "cooldown" },
        ],
      }),
    );
    writeFileSync(logPath, "self-correction-run semantic_empty\n");
    writeFileSync(exitPath, "2026-06-05T03:15:00Z self-correction-run exit=1\n");

    const nowMs = Date.UTC(2026, 5, 5, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs);
    const summarySteps = steps.filter((s) => s.line.startsWith("summary.json "));
    expect(summarySteps.map((s) => s.step)).toEqual(["distill", "self-correction-run"]);
    expect(summarySteps[1].exitCode).toBe(1);
    expect(summarySteps[1].line).toContain("summary.json self-correction-run status=failed");
  });

  it("treats ok summary steps with semantic=partial as non-zero exit", () => {
    const root = tmpRoot();
    const day = join(root, "20260605");
    mkdirSync(day, { recursive: true });
    const summaryPath = join(day, "maintenance-nightly-20260605T040000Z-43.summary.json");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        runId: "20260605T040000Z-43",
        tierLabel: "nightly",
        finishedAt: "2026-06-05T04:15:00.000Z",
        exitCode: 0,
        steps: [
          {
            name: "enrich-entities",
            status: "ok",
            summary: "processed=10 enriched=2 llmFailures=1 stopReason=provider_budget remaining=50 semantic=partial",
          },
        ],
      }),
    );

    const nowMs = Date.UTC(2026, 5, 5, 5, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs);
    const enrich = steps.find((s) => s.step === "enrich-entities");
    expect(enrich?.exitCode).toBe(1);
  });

  it("dedupes HM_EXIT steps when summary.json already ingested the same run", () => {
    const root = tmpRoot();
    const day = join(root, "20260605");
    mkdirSync(day, { recursive: true });
    const stem = "maintenance-nightly-20260605T030000Z-99";
    const summaryPath = join(day, `${stem}.summary.json`);
    const canonicalExitPath = join(root, `${stem}.exit.txt`);
    writeFileSync(
      summaryPath,
      JSON.stringify({
        runId: "20260605T030000Z-99",
        tierLabel: "nightly",
        finishedAt: "2026-06-05T03:15:00.000Z",
        exitCode: 0,
        steps: [{ name: "distill", status: "ok", summary: "stored=1" }],
      }),
    );
    writeFileSync(canonicalExitPath, "2026-06-05T03:15:00Z distill exit=0\n");

    const nowMs = Date.UTC(2026, 5, 5, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs);
    expect(steps.filter((s) => s.step === "distill")).toHaveLength(1);
  });

  it("parses extended HM_EXIT lines with step=<name> format", () => {
    const root = tmpRoot();
    const day = join(root, "20260513");
    mkdirSync(day, { recursive: true });
    const exitPath = join(day, "weekly-pending-digest-autopilot-20260513T082000Z-123.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(
      exitPath,
      [
        "2026-05-13T08:20:01Z step=guard-check exit=0 status=ok reason=ok duration_ms=10",
        "2026-05-13T08:20:02Z step=digest-autopilot exit=1 status=failed reason=inner_command_failed duration_ms=20",
      ].join("\n"),
    );
    writeFileSync(logPath, "digest autopilot failed");

    const steps = collectMaintenanceSteps(root, "24h", Date.UTC(2026, 4, 13, 9, 0, 0));
    expect(steps).toHaveLength(2);
    expect(steps[0].step).toBe("guard-check");
    expect(steps[1].step).toBe("digest-autopilot");
  });

  it("flags empty exit ledger + progress log as orchestration bug (root-level cron files)", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(
      logPath,
      [
        "[dream-cycle] extract implicit feedback — complete in 2639s",
        "[dream-cycle] closed-loop effectiveness — complete in 50s",
        "[dream-cycle] cross-agent learning — complete in 0s",
      ].join("\n"),
    );

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    const findings = analyzeMaintenanceSteps(steps);
    const report = buildMaintenanceAnalysisReport({ root, since: "24h", steps, findings });

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-empty-exit-after-progress");
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("orchestration-bug");
    expect(findings[0].severity).toBe("high");
    expect(report.summary.jobsOk).toBe(0);
    expect(report.summary.jobsWithFindings).toBe(1);
  });

  it("flags stale still-running dream-cycle logs as high orchestration failures", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(
      logPath,
      "[dream-cycle] extract implicit feedback — still running after 2210s — stage=scan-sessions; sessions=106/177",
    );

    const staleAt = new Date("2026-05-11T02:45:00Z");
    utimesSync(exitPath, staleAt, staleAt);
    utimesSync(logPath, staleAt, staleAt);

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 30 * 60 * 1000 });
    const findings = analyzeMaintenanceSteps(steps);

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-stale-running");
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("orchestration-bug");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].suggestedAction.toLowerCase()).toContain("stale");
  });

  it("detects memory-hybrid stage markers as progress when exit ledger is empty", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(
      logPath,
      [
        "memory-hybrid: dream-cycle — stage 1/6 prune expired facts start",
        "memory-hybrid: dream-cycle — stage 1/6 prune expired facts complete in 2s",
      ].join("\n"),
    );

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-empty-exit-after-progress");
    expect(steps[0].line).toContain("progress-marker=present");
  });

  it("detects memory-hybrid still-running heartbeat as stale-running orchestration anomaly", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(logPath, "memory-hybrid: dream-cycle — stage 3 still running after 2210s");

    const staleAt = new Date("2026-05-11T02:45:00Z");
    utimesSync(exitPath, staleAt, staleAt);
    utimesSync(logPath, staleAt, staleAt);

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 30 * 60 * 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-stale-running");
  });

  it("treats build-languages heartbeat lines as progress markers for empty ledgers", () => {
    const root = tmpRoot();
    const exitPath = join(root, "monthly-consolidation-20260517T155138Z-24030.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(logPath, "memory-hybrid: build-languages — still running after 60s; stage=detect+generate");

    const nowMs = Date.UTC(2026, 4, 17, 16, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-empty-exit-after-progress");
    expect(steps[0].line).toContain("progress-marker=present");
  });

  it("treats enrich-entities heartbeat lines as progress markers for empty ledgers", () => {
    const root = tmpRoot();
    const exitPath = join(root, "monthly-consolidation-20260517T155138Z-24030.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "");
    writeFileSync(logPath, "memory-hybrid: enrich-entities — still running after 60s; stage=entity-enrichment");

    const nowMs = Date.UTC(2026, 4, 17, 16, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-empty-exit-after-progress");
    expect(steps[0].line).toContain("progress-marker=present");
  });
  it("classifies missing .exit.txt ledgers as orchestration failures", () => {
    const root = tmpRoot();
    const logPath = join(root, "nightly-memory-sweep-20260511T030000Z-555.log");
    writeFileSync(
      logPath,
      [
        "[nightly-memory-sweep] prune completed",
        "[nightly-memory-sweep] distill completed",
        "validate-cron-exit marker missing because wrapper failed before ledger flush",
      ].join("\n"),
    );

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-missing-exit-ledger");
    expect(steps[0].line).toContain("matching .exit.txt ledger is missing");

    const rule = classifyMaintenanceFailure(steps[0]);
    expect(rule.id).toBe("orchestration-missing-exit-ledger");
    expect(rule.classification).toBe("orchestration-bug");

    const findings = analyzeMaintenanceSteps(steps);
    expect(findings).toHaveLength(1);
    expect(findings[0].classification).toBe("orchestration-bug");
    expect(findings[0].ruleId).toBe("orchestration-missing-exit-ledger");
  });

  it("ignores manual-qa stdout transcripts: does not report them as missing-exit-ledger", () => {
    const root = tmpRoot();
    // Create a canonical wrapper log (should produce a finding — used as baseline)
    const canonicalLog = join(root, "maintenance-log-analyzer-20260529T050412Z-15978.log");
    writeFileSync(canonicalLog, "[maintenance-log-analyzer] run started\n");

    // Create manual-qa directory with a stdout.log transcript
    const qaDir = join(root, "manual-qa", "maintenance-log-analyzer-20260529T050412Z");
    mkdirSync(qaDir, { recursive: true });
    writeFileSync(
      join(qaDir, "stdout.log"),
      [
        "SUCCESS: maintenance-log-analyzer",
        "HM_EXIT=/home/markus/.openclaw/logs/cron-hybrid-mem/maintenance-log-analyzer-20260529T050412Z-15978.exit.txt",
        "2026-05-29T05:04:27Z analyze-maintenance-logs exit=0",
        "HM_LOG=/home/markus/.openclaw/logs/cron-hybrid-mem/maintenance-log-analyzer-20260529T050412Z-15978.log",
        "GUARD_UPDATED=yes",
      ].join("\n"),
    );

    const nowMs = Date.UTC(2026, 4, 29, 6, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });

    // Only the canonical wrapper log should produce a step; the QA transcript must be ignored
    expect(steps).toHaveLength(1);
    expect(steps[0].logPath).toBe(canonicalLog);
    expect(steps.every((s) => !s.logPath.includes("manual-qa"))).toBe(true);
  });

  it("ignores arbitrary helper logs under subdirectories that lack canonical names", () => {
    const root = tmpRoot();
    // Arbitrary helper log without a timestamp-pid suffix — should be skipped
    const helperDir = join(root, "helpers");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "stdout.log"), "helper output\n");
    writeFileSync(join(helperDir, "debug.log"), "debug output\n");

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    expect(steps).toHaveLength(0);
  });

  it("still produces missing-exit-ledger for .cron.log files without a matching .exit.txt", () => {
    const root = tmpRoot();
    const logPath = join(root, "nightly-memory-sweep-20260511.cron.log");
    writeFileSync(logPath, "[nightly-memory-sweep] run started\n");

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-missing-exit-ledger");
    expect(steps[0].job).toBe("nightly-memory-sweep");
  });

  it("ignores stale manual exit rows even when the files were touched recently", () => {
    const root = tmpRoot();
    const manualDir = join(root, "manual-20260508-20260508-053702");
    mkdirSync(manualDir, { recursive: true });
    const exitPath = join(manualDir, "preflight.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "2026-05-08T05:44:29Z current-config exit=1\n");
    writeFileSync(logPath, "Unknown command: openclaw hybrid-mem\n");

    const refreshedMs = Date.UTC(2026, 5, 1, 5, 0, 0);
    utimesSync(exitPath, refreshedMs / 1000, refreshedMs / 1000);
    utimesSync(logPath, refreshedMs / 1000, refreshedMs / 1000);

    const steps = collectMaintenanceSteps(root, "7d", refreshedMs);
    expect(steps).toHaveLength(0);
  });

  it("treats malformed exit-ledger timestamps as unparseable and emits the orchestration fallback", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "not-a-date dream-cycle exit=1\n");
    writeFileSync(logPath, "memory-hybrid: dream-cycle — stage 1/6 prune expired facts complete in 2s\n");

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-empty-exit-after-progress");
    expect(steps[0].line).toContain("progress-marker=present");
  });

  it("isCanonicalMaintenanceLog and isUnderAuxiliaryDir unit checks", () => {
    // compact timestamp-pid format
    expect(isCanonicalMaintenanceLog("/logs/nightly-distill-20260507T021015Z-123.log")).toBe(true);
    expect(isCanonicalMaintenanceLog("/logs/maintenance-log-analyzer-20260529T050412Z-15978.log")).toBe(true);
    // .cron.log format
    expect(isCanonicalMaintenanceLog("/logs/nightly-memory-sweep-20260511.cron.log")).toBe(true);
    // ISO-with-dashes format produced by runPendingDigestAutopilotCron
    expect(isCanonicalMaintenanceLog("/logs/weekly-pending-digest-autopilot-2026-05-13T08-20-00-000Z.log")).toBe(true);
    expect(
      isCanonicalMaintenanceLog("/logs/20260513/weekly-pending-digest-autopilot-2026-05-13T08-20-00-000Z.log"),
    ).toBe(true);
    // non-canonical helper logs
    expect(isCanonicalMaintenanceLog("/logs/manual-qa/run/stdout.log")).toBe(false);
    expect(isCanonicalMaintenanceLog("/logs/helpers/debug.log")).toBe(false);
    expect(isCanonicalMaintenanceLog("/logs/stderr.log")).toBe(false);

    const root = "/home/user/.openclaw/logs/cron-hybrid-mem";
    expect(isUnderAuxiliaryDir(`${root}/manual-qa/run/stdout.log`, root)).toBe(true);
    expect(isUnderAuxiliaryDir(`${root}/tmp/scratch.log`, root)).toBe(true);
    expect(isUnderAuxiliaryDir(`${root}/archive/old.log`, root)).toBe(true);
    expect(isUnderAuxiliaryDir(`${root}/.hidden/x.log`, root)).toBe(true);
    expect(isUnderAuxiliaryDir(`${root}/nightly-distill-20260507T021015Z-123.log`, root)).toBe(false);
    expect(isUnderAuxiliaryDir(`${root}/20260507/nightly-distill-20260507T021015Z-123.log`, root)).toBe(false);
  });

  it("produces missing-exit-ledger for autopilot-cron ISO-with-dashes log without a matching .exit.txt", () => {
    const root = tmpRoot();
    const dayDir = join(root, "20260513");
    mkdirSync(dayDir, { recursive: true });
    // Filename as produced by runPendingDigestAutopilotCron (ISO datetime, colons/dots → dashes, no PID)
    const logPath = join(dayDir, "weekly-pending-digest-autopilot-2026-05-13T08-20-00-000Z.log");
    writeFileSync(logPath, "run.start job=weekly-pending-digest-autopilot\n");

    const nowMs = Date.UTC(2026, 4, 13, 9, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("orchestration-missing-exit-ledger");
    expect(steps[0].job).toBe("weekly-pending-digest-autopilot");
    expect(steps[0].logPath).toBe(logPath);
  });

  it("keeps normal successful verbose dream-cycle runs as OK", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-dream-cycle-20260511T024522Z-17502.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "2026-05-11T03:58:20Z dream-cycle exit=0\n");
    writeFileSync(
      logPath,
      [
        "[dream-cycle] stage 2/6 extract implicit feedback — complete in 2639s",
        "[dream-cycle] pipeline complete in 2740s (core=42s, follow-ups=6/6, follow-up-elapsed=2698s, follow-up-failures=0)",
        "--- validate-cron-exit ---",
      ].join("\n"),
    );

    const nowMs = Date.UTC(2026, 4, 11, 4, 0, 0);
    const steps = collectMaintenanceSteps(root, "24h", nowMs, { staleThresholdMs: 45 * 60 * 1000 });
    const findings = analyzeMaintenanceSteps(steps);
    const report = buildMaintenanceAnalysisReport({ root, since: "24h", steps, findings });

    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("dream-cycle");
    expect(findings).toHaveLength(0);
    expect(report.summary.jobsOk).toBe(1);
    expect(report.summary.jobsWithFindings).toBe(0);
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
        pluginVersion: "2026.5.81",
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

  it("summarizeMaintenanceLogAnalysis marks strict=fail when findings include strict classes", () => {
    const root = tmpRoot();
    const exitPath = join(root, "nightly-memory-sweep-20260511T030000Z-555.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, "2026-05-11T03:00:00Z nightly-memory-sweep/distill exit=1\n");
    writeFileSync(logPath, "TypeError: Cannot read properties of undefined (reading 'foo')");

    const steps = collectMaintenanceSteps(root, "24h", Date.UTC(2026, 4, 11, 4, 0, 0));
    const result = summarizeMaintenanceLogAnalysis(steps);
    expect(result.findingsCount).toBeGreaterThan(0);
    expect(result.strictFailed).toBe(true);
    expect(result.summary).toContain("strict=fail");
    expect(result.summary).toContain("semantic=partial");
  });

  it("collapses repeated fingerprints into new/still-failing sections and suppresses stale historical noise", () => {
    const dbPath = join(tmpRoot(), "maintenance-findings.db");
    const now = Math.floor(Date.UTC(2026, 5, 1, 6, 0, 0) / 1000);
    persistMaintenanceFindings(dbPath, [
      {
        id: "old-still",
        occurredAt: now - 3600,
        job: "nightly",
        step: "distill",
        exitCode: 1,
        classification: "plugin-bug",
        ruleId: "plugin-type-error",
        fingerprint: "fp-still",
        logExcerpt: "TypeError",
        logPath: "/tmp/old-still.log",
        pluginVersion: null,
        actionTaken: "reported-glitchtip",
        suggestedAction: "fix",
        severity: "high",
      },
      {
        id: "old-stale",
        occurredAt: now - 10 * 24 * 3600,
        job: "manual",
        step: "current-config",
        exitCode: 1,
        classification: "transient-network",
        ruleId: "network",
        fingerprint: "fp-stale",
        logExcerpt: "ECONNRESET",
        logPath: "/tmp/old-stale.log",
        pluginVersion: null,
        actionTaken: "retry-once",
        suggestedAction: "retry",
        severity: "medium",
      },
    ]);

    const summarized = summarizeMaintenanceFindings(
      [
        {
          id: "still-1",
          occurredAt: now - 120,
          job: "nightly",
          step: "distill",
          exitCode: 1,
          classification: "plugin-bug",
          ruleId: "plugin-type-error",
          fingerprint: "fp-still",
          logExcerpt: "TypeError",
          logPath: "/tmp/still-1.log",
          pluginVersion: null,
          actionTaken: "glitchtip+digest",
          suggestedAction: "fix",
          severity: "high",
        },
        {
          id: "still-2",
          occurredAt: now - 60,
          job: "nightly",
          step: "distill",
          exitCode: 1,
          classification: "plugin-bug",
          ruleId: "plugin-type-error",
          fingerprint: "fp-still",
          logExcerpt: "TypeError",
          logPath: "/tmp/still-2.log",
          pluginVersion: null,
          actionTaken: "glitchtip+digest",
          suggestedAction: "fix",
          severity: "high",
        },
        {
          id: "new",
          occurredAt: now - 30,
          job: "dream-cycle",
          step: "orchestration-stale-running",
          exitCode: 1,
          classification: "orchestration-bug",
          ruleId: "orchestration-stale-maintenance-run",
          fingerprint: "fp-new",
          logExcerpt: "still running after",
          logPath: "/tmp/new.log",
          pluginVersion: null,
          actionTaken: "glitchtip+digest",
          suggestedAction: "rerun",
          severity: "high",
        },
      ],
      { dbPath, historicalCutoffSec: now - 7 * 24 * 3600 },
    );

    expect(summarized.findings).toHaveLength(2);
    expect(summarized.historicalStaleSuppressed).toBe(1);
    expect(summarized.findings[0]?.fingerprint).toBe("fp-new");
    expect(summarized.findings[0]?.status).toBe("new");

    const stillFailing = summarized.findings.find((f) => f.fingerprint === "fp-still");
    expect(stillFailing?.status).toBe("still-failing");
    expect(stillFailing?.occurrenceCount).toBe(3);
    expect(stillFailing?.actionTaken).toBe("reported");

    const findings = reportGlitchTipFindings(summarized.findings, {
      alreadyReportedFingerprints: new Set(["fp-still"]),
    });
    expect(capturePluginError).toHaveBeenCalledTimes(1);
    expect(findings.find((f) => f.fingerprint === "fp-still")?.actionTaken).toBe("reported");

    const report = buildMaintenanceAnalysisReport({
      since: "7d",
      steps: [],
      findings,
      historicalStaleSuppressed: summarized.historicalStaleSuppressed,
    });
    expect(report.summary.newFindings).toBe(1);
    expect(report.summary.stillFailing).toBe(1);
    expect(report.digestMd).toContain("### New");
    expect(report.digestMd).toContain("### Still failing");
    expect(report.digestMd).toContain("### Historical/stale");
    expect(report.digestMd).toContain("Suppressed 1 older historical fingerprint");
    expect(report.digestMd).toContain("Seen 3 times");
  });

  it("persists raw occurrences while reporting summarized current findings", async () => {
    const root = tmpRoot();
    const nowMs = Date.now() - 2 * 60 * 60 * 1000;
    const dayStamp = formatTimestampUtcFromMs(nowMs).slice(0, 10).replace(/-/g, "");
    const day = join(root, dayStamp);
    mkdirSync(day, { recursive: true });
    const iso1 = formatTimestampUtcFromMs(nowMs);
    const iso2 = formatTimestampUtcFromMs(nowMs + 1000);
    const exitPath = join(day, `nightly-distill-${dayStamp}T060000Z-123.exit.txt`);
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, [`${iso1} distill exit=1`, `${iso2} distill exit=1`].join("\n"));
    writeFileSync(logPath, "TypeError: Cannot read properties of undefined\n");

    const outPath = join(root, "report.json");
    const findingsPath = join(root, "maintenance-findings.db");
    await runAnalyzeMaintenanceLogs(
      {
        root,
        since: "7d",
        format: "json",
        out: outPath,
        persist: findingsPath,
      },
      {
        cfg: { sqlitePath: "" },
        factsDb: {} as never,
      } as unknown as ManageBindings,
    );

    const report = JSON.parse(readFileSync(outPath, "utf-8")) as {
      findings: Array<{ fingerprint: string }>;
      summary: { newFindings: number };
    };
    expect(report.findings).toHaveLength(1);
    expect(report.summary.newFindings).toBe(1);

    const db = new DatabaseSync(findingsPath);
    try {
      const count = db.prepare("SELECT COUNT(*) AS c FROM maintenance_finding").get() as { c: number };
      expect(count.c).toBe(2);
    } finally {
      db.close();
    }
  });

  it("pluginVersionGte compares dotted plugin versions for resolved-issue suppression", () => {
    expect(pluginVersionGte("2026.5.81", "2026.5.63")).toBe(true);
    expect(pluginVersionGte("2026.5.81", "2026.5.81")).toBe(true);
    expect(pluginVersionGte("2026.5.63", "2026.5.81")).toBe(false);
    expect(pluginVersionGte(null, "1.0.0")).toBe(false);
  });

  it("suppresses findings when fingerprint is listed and pluginVersion meets resolvedInVersion", () => {
    const root = tmpRoot();
    const day = join(root, "20260507");
    mkdirSync(day, { recursive: true });
    const exitPath = join(day, "nightly-distill-20260507T021015Z-123.exit.txt");
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    writeFileSync(exitPath, ["2026-05-07T02:11:02Z distill exit=1"].join("\n"));
    writeFileSync(logPath, "openclaw-hybrid-memory 2026.5.81\nTypeError: boom\n");

    const steps = collectMaintenanceSteps(root, "7d", Date.UTC(2026, 4, 8));
    const findings = analyzeMaintenanceSteps(steps);
    expect(findings).toHaveLength(1);
    const fp = findings[0].fingerprint;
    const empty = analyzeMaintenanceSteps(steps, {
      resolvedFingerprints: { [fp]: { resolvedInVersion: "2026.5.81", note: "fixed in release" } },
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
