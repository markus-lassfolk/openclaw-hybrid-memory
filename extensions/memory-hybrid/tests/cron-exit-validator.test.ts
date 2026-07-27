/**
 * Tests for cron exit ledger validation.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkForUnknownCommands,
  parseExitLine,
  suppressRedundantGenericMaintenanceIssues,
  validateFromSummaryJson,
  validateMaintenanceExecution,
} from "../services/cron-exit-validator.js";
import type { MaintenanceTelemetryIssue } from "../services/cron-exit-validator.js";

describe("cron-exit-validator", () => {
  describe("parseExitLine", () => {
    it("should parse valid exit line", () => {
      const line = "2024-05-08T02:15:30Z prune exit=0";
      const result = parseExitLine(line);
      expect(result).toBeTruthy();
      expect(result?.timestamp).toBe("2024-05-08T02:15:30Z");
      expect(result?.step).toBe("prune");
      expect(result?.exitCode).toBe(0);
    });

    it("should parse line with non-zero exit code", () => {
      const line = "2024-05-08T02:15:30Z distill exit=1";
      const result = parseExitLine(line);
      expect(result).toBeTruthy();
      expect(result?.exitCode).toBe(1);
    });

    it("should return null for invalid line", () => {
      expect(parseExitLine("invalid line")).toBeNull();
      expect(parseExitLine("")).toBeNull();
      expect(parseExitLine("2024-05-08 prune exit=0")).toBeNull();
    });

    it("should handle hyphenated step names", () => {
      const line = "2024-05-08T02:15:30Z extract-daily exit=0";
      const result = parseExitLine(line);
      expect(result).toBeTruthy();
      expect(result?.step).toBe("extract-daily");
    });

    it("parses extended step= format with status/reason/duration fields", () => {
      const line = "2024-05-08T02:15:30Z step=extract-daily exit=0 status=ok reason=ok duration_ms=42";
      const result = parseExitLine(line);
      expect(result).toBeTruthy();
      expect(result?.step).toBe("extract-daily");
      expect(result?.exitCode).toBe(0);
      expect(result?.status).toBe("ok");
      expect(result?.reason).toBe("ok");
      expect(result?.durationMs).toBe(42);
    });

    it("rejects malformed exit code suffixes and trailing junk", () => {
      expect(parseExitLine("2024-05-08T02:15:30Z prune exit=0oops")).toBeNull();
      expect(parseExitLine("2024-05-08T02:15:30Z prune exit=0 extra=ignored")).toBeNull();
    });
  });

  describe("checkForUnknownCommands", () => {
    it("should detect unknown command in log", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const logPath = join(tmpDir, "test.log");
      writeFileSync(
        logPath,
        `Starting job
error: unknown command 'consolidate-episodes'
Job failed
`,
      );

      const unknownCommands = checkForUnknownCommands(logPath);
      expect(unknownCommands.length).toBe(1);
      expect(unknownCommands[0]).toBe("consolidate-episodes");
    });

    it("should detect multiple unknown commands", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const logPath = join(tmpDir, "test.log");
      writeFileSync(
        logPath,
        `error: unknown command 'foo'
error: unknown command 'bar'
`,
      );

      const unknownCommands = checkForUnknownCommands(logPath);
      expect(unknownCommands.length).toBe(2);
      expect(unknownCommands).toEqual(["foo", "bar"]);
    });

    it("should return empty array if no unknown commands", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const logPath = join(tmpDir, "test.log");
      writeFileSync(logPath, "Everything ok\nNo errors\n");

      const unknownCommands = checkForUnknownCommands(logPath);
      expect(unknownCommands.length).toBe(0);
    });
  });

  describe("validateMaintenanceExecution", () => {
    it("should report success when all steps complete", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
2024-05-08T02:01:00Z distill exit=0
2024-05-08T02:02:00Z extract-daily exit=0
`,
      );

      const result = validateMaintenanceExecution(exitPath, undefined, ["prune", "distill", "extract-daily"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.guardUpdated).toBe(true);
      expect(result.missingSteps.length).toBe(0);
      expect(result.failedSteps.length).toBe(0);
      expect(result.steps.length).toBe(3);
    });

    it("should report failed when a step has non-zero exit", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
2024-05-08T02:01:00Z distill exit=1
`,
      );

      const result = validateMaintenanceExecution(exitPath, undefined, ["prune", "distill"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("unknown");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.length).toBe(1);
      expect(result.failedSteps[0].step).toBe("distill");
      expect(result.failedSteps[0].exitCode).toBe(1);
      expect(result.reportableIssues[0]?.fingerprint.join(":")).toBe(
        "hybrid-memory-maintenance:test:distill:nonzero_exit",
      );
    });

    it("should report failed when a step has exit=0 but status=failed in extended HM_EXIT format", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        "2024-05-08T02:01:00Z step=extract-daily exit=0 status=failed reason=tolerated_extract_daily_exit_1 duration_ms=120000\n",
      );

      const result = validateMaintenanceExecution(exitPath, undefined, ["extract-daily"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].step).toBe("extract-daily");
      expect(result.failedSteps[0].exitCode).toBe(0);
      expect(result.failedSteps[0].status).toBe("failed");
    });

    it("should surface HM_EXIT failure reasons for non-zero steps", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        "2024-05-08T02:01:00Z step=reembed-vectorless exit=1 status=failed reason=failed_embedding_provider_5xx duration_ms=420000\n",
      );

      const result = validateMaintenanceExecution(exitPath, undefined, ["reembed-vectorless"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].failureReason).toBe("failed_embedding_provider_5xx");
      expect(result.error).toContain("failed_embedding_provider_5xx");
    });

    it("should annotate audit-health strict failures with a machine-readable reason", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:01:00Z audit-health exit=2\n");
      writeFileSync(
        logPath,
        [
          "some preamble",
          JSON.stringify(
            {
              schemaVersion: 1,
              generatedAt: "2026-05-09T15:06:34Z",
              status: "partial",
              ok: false,
              warningCount: 1,
              errorCount: 0,
              activeFacts: 1,
              warnings: ["a warning"],
              remediation: [],
              errors: [],
              exitCode: 2,
              exitReason: "strict_warnings",
              strictFailureReason: "1 warning(s) present and --strict was set",
            },
            null,
            2,
          ),
          "tail",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["audit-health"]);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].failureReason).toBe("strict_warnings");
      expect(result.failedSteps[0].strictFailureReason).toContain("--strict");
      expect(result.error).toContain("strict_warnings");
    });

    it("should annotate audit-health strict failures when JSON contains escaped quotes and braces", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:01:00Z audit-health exit=2\n");
      writeFileSync(
        logPath,
        [
          "some preamble",
          JSON.stringify(
            {
              schemaVersion: 1,
              generatedAt: "2026-05-09T15:06:34Z",
              status: "partial",
              ok: false,
              warningCount: 1,
              errorCount: 0,
              activeFacts: 1,
              warnings: ['warning with "quoted { brace }" text'],
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
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["audit-health"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps[0].failureReason).toBe("strict_warnings");
      expect(result.failedSteps[0].strictFailureReason).toContain("quoted { text }");
    });

    it("should report partial when steps are missing", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
`,
      );

      const result = validateMaintenanceExecution(exitPath, undefined, ["prune", "distill", "extract-daily"]);

      expect(result.maintenanceStatus).toBe("partial");
      expect(result.guardUpdated).toBe(false);
      expect(result.missingSteps.length).toBe(2);
      expect(result.missingSteps).toEqual(["distill", "extract-daily"]);
    });

    it("should report failed when all required steps are missing from the ledger", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(exitPath, "");

      const result = validateMaintenanceExecution(exitPath, undefined, ["prune", "distill"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.missingSteps).toEqual(["prune", "distill"]);
      expect(result.error).toContain("Missing steps");
    });

    it("should accept skip variants when allowSkip is true", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
2024-05-08T02:01:00Z distill-skipped exit=0
`,
      );

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill"],
        true, // allowSkip
      );

      expect(result.maintenanceStatus).toBe("success");
      expect(result.guardUpdated).toBe(true);
      expect(result.missingSteps.length).toBe(0);
    });

    it("reports skipped when a required step explicitly records status=skipped", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(exitPath, "2024-05-08T02:01:00Z self-correct exit=0 status=skipped reason=skipped_cooldown\n");

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["self-correct"],
        true, // allowSkip
      );

      expect(result.maintenanceStatus).toBe("skipped");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("skipped_cooldown");
    });

    it("treats explicit skipped statuses as skipped for maintenance QA markers", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        "2024-05-08T02:01:00Z record-storage-sample exit=0 status=skipped reason=skipped_already_sampled_today\n",
      );

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["record-storage-sample"],
        true, // allowSkip
      );

      expect(result.maintenanceStatus).toBe("skipped");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("skipped_already_sampled_today");
    });

    it("reports success and updates guard when only some steps are skipped in multi-step job", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0 status=ok
2024-05-08T02:01:00Z distill exit=0 status=ok
2024-05-08T02:02:00Z self-correct exit=0 status=skipped reason=skipped_cooldown
`,
      );

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill", "self-correct"],
        true, // allowSkip
      );

      expect(result.maintenanceStatus).toBe("success");
      expect(result.guardUpdated).toBe(true);
      expect(result.missingSteps.length).toBe(0);
      expect(result.failedSteps.length).toBe(0);
    });

    it("should fail when unknown command detected in log", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
`,
      );
      writeFileSync(logPath, "error: unknown command 'consolidate-episodes'\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("consolidate-episodes");
    });

    it("should fail when exit file does not exist", () => {
      const result = validateMaintenanceExecution("/nonexistent/path.exit.txt", undefined, ["prune"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should report skipped when ledger is empty and log indicates feature-gated full skip", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "");
      writeFileSync(
        logPath,
        "reflection.enabled is false in hybrid-memory config. Job was skipped per preamble; not updating guard.",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect", "reflect-rules"]);

      expect(result.maintenanceStatus).toBe("skipped");
      expect(result.guardUpdated).toBe(false);
      expect(result.steps.length).toBe(0);
    });

    it("should still fail on empty ledger when log does not indicate intentional skip", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "");
      writeFileSync(logPath, "set -euo pipefail\nbash: something blew up\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.maintenanceStatus).toBe("failed");
    });

    it("should deterministically fail stale empty ledgers with heartbeat-only logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "");
      writeFileSync(
        logPath,
        [
          "[dream-cycle] extract implicit feedback — still running after 2210s — stage=scan-sessions; sessions=106/177",
          "memory-hybrid: dream-cycle — stage 3 still running after 2210s",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failureClass).toBe("wrapper_aborted_before_steps");
      expect(result.missingSteps).toEqual([]);
      expect(result.error).toContain("Wrapper aborted before steps");
    });

    it("classifies empty HM_EXIT with wrapper exit 64 as wrapper_aborted_before_steps (#1982)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "maintenance-20260625T160532Z-17113.exit.txt");
      const logPath = join(tmpDir, "maintenance-20260625T160532Z-17113.log");
      writeFileSync(exitPath, "");
      writeFileSync(
        logPath,
        ["HM_JOB=maintenance", "RUN_ID=20260625T160532Z-17113", "HM_STEP_EXIT=64", "FAILED: maintenance"].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["maintenance"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failureClass).toBe("wrapper_aborted_before_steps");
      expect(result.wrapperExitCode).toBe(64);
      expect(result.missingSteps).toEqual([]);
      expect(result.failedSteps).toEqual([]);
      expect(result.error).toBe("Wrapper aborted before steps (exit=64); no maintenance steps recorded in HM_EXIT");
      expect(result.reportableIssues.some((i) => i.failureClass === "wrapper_aborted_before_steps")).toBe(true);
      expect(result.reportableIssues.some((i) => i.failureClass === "missing_required_step")).toBe(false);
    });

    it("fails dream-cycle validation when continuous verification reports degraded machine status", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:15:30Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Continuous verification complete:",
          "  Checked: 12",
          "  Confirmed: 0",
          "  Stale: 0",
          "  Uncertain: 12",
          "  Errors: 12",
          "  Machine status: status=degraded reason=errors_present checked=12 confirmed=0 stale=0 uncertain=12 errors=12",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].step).toBe("continuous-verification");
      expect(result.failedSteps[0].timestamp).toBe("2024-05-08T02:15:30Z");
      expect(result.failedSteps[0].failureReason).toBe("errors_present");
      expect(result.error).toContain("continuous-verification (exit=2 errors_present)");
    });

    it.each([["errors_present", 12] as const])(
      "fails dream-cycle validation when continuous verification reports degraded %s machine status",
      (reason, errors) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
        const exitPath = join(tmpDir, "test.exit.txt");
        const logPath = join(tmpDir, "test.log");
        writeFileSync(exitPath, "2024-05-08T03:00:00Z dream-cycle exit=0\n");
        writeFileSync(
          logPath,
          [
            "Continuous verification complete:",
            "  Checked: 12",
            "  Confirmed: 0",
            "  Stale: 0",
            "  Uncertain: 12",
            `  Errors: ${errors}`,
            `  Machine status: status=degraded reason=${reason} checked=12 confirmed=0 stale=0 uncertain=12 errors=${errors}`,
          ].join("\n"),
        );

        const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

        expect(result.maintenanceStatus).toBe("failed");
        expect(result.guardUpdated).toBe(false);
        expect(result.failedSteps).toHaveLength(1);
        expect(result.failedSteps[0].step).toBe("continuous-verification");
        expect(result.failedSteps[0].timestamp).toBe("2024-05-08T03:00:00Z");
        expect(result.failedSteps[0].failureReason).toBe(reason);
        expect(result.error).toContain(`continuous-verification (exit=2 ${reason})`);
      },
    );

    it("does not fail dream-cycle validation when continuous verification only reports all-uncertain outcomes", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T03:00:00Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Continuous verification complete:",
          "  Checked: 12",
          "  Confirmed: 0",
          "  Stale: 0",
          "  Uncertain: 12",
          "  Errors: 0",
          "  Machine status: status=degraded reason=all_uncertain checked=12 confirmed=0 stale=0 uncertain=12 errors=0",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).not.toBe("failed");
      expect(result.failedSteps.some((s) => s.step === "continuous-verification")).toBe(false);
    });

    it("uses an ISO-compatible timestamp for synthetic degraded verification failures without a dream-cycle ledger step", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "");
      writeFileSync(
        logPath,
        [
          "Continuous verification complete:",
          "  Checked: 12",
          "  Confirmed: 0",
          "  Stale: 0",
          "  Uncertain: 12",
          "  Errors: 12",
          "  Machine status: status=degraded reason=errors_present checked=12 confirmed=0 stale=0 uncertain=12 errors=12",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].timestamp).toBe("1970-01-01T00:00:00Z");
      expect(Number.isNaN(Date.parse(result.failedSteps[0].timestamp))).toBe(false);
      expect(result.failedSteps[0].failureReason).toBe("errors_present");
    });

    it("fails dream-cycle validation when core stages report failures in the log", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:15:30Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Dream cycle finished with errors: Stages failed: reflection (patterns).",
          "  Core stage failures: reflection (patterns)",
          "memory-hybrid: dream-cycle — stage 3 failed after 12s: reflection (patterns): Error: llm down",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps.some((s) => s.step === "dream-cycle-core")).toBe(true);
    });

    it("fails dream-cycle-core validation when required step is dream-cycle-core", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:15:30Z dream-cycle-core exit=0\n");
      writeFileSync(
        logPath,
        "memory-hybrid: dream-cycle — stage 3 failed after 12s: reflection (patterns): Error: llm down",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle-core"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps.some((s) => s.step === "dream-cycle-core")).toBe(true);
    });

    it("fails dream-cycle validation from machine-readable status line without duplicate core entries", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:15:30Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Dream cycle finished with errors: Stages failed: reflection (patterns).",
          "  Core stage failures: reflection (patterns)",
          "Dream cycle status: success=false core_success=false failed_stages=1 follow_up_failures=0",
          "memory-hybrid: dream-cycle — stage 3 failed after 12s: reflection (patterns): Error: llm down",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      const coreFailures = result.failedSteps.filter((s) => s.step === "dream-cycle-core");
      expect(coreFailures).toHaveLength(1);
      expect(coreFailures[0].failureReason).toBe("core_stage_failed");
    });

    it("fails dream-cycle validation when follow-up failures are reported", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      const logPath = join(tmpDir, "test.log");
      writeFileSync(exitPath, "2024-05-08T02:15:30Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Dream cycle complete: No changes.",
          "Dream cycle follow-ups: 1 failure(s)",
          "  - extract implicit feedback: boom",
          "[dream-cycle] pipeline complete in 120s (core=10s, follow-ups=5/6, follow-up-elapsed=110s, follow-up-failures=1)",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps.some((s) => s.step === "dream-cycle-follow-ups")).toBe(true);
    });

    it("detects semantic reflect-rules failures with stable grouped fingerprints", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const firstExitPath = join(tmpDir, "weekly-reflection-20260508T021500Z-111.exit.txt");
      const secondExitPath = join(tmpDir, "weekly-reflection-20260509T021500Z-222.exit.txt");
      const logPath = join(tmpDir, "reflect.log");
      writeFileSync(firstExitPath, "2026-05-08T02:15:30Z reflect-rules exit=0\n");
      writeFileSync(secondExitPath, "2026-05-09T02:15:30Z reflect-rules exit=0\n");
      writeFileSync(logPath, "reflect-rules parse_success=false stored=0 model=minimax/MiniMax-M2.7-highspeed\n");

      const first = validateMaintenanceExecution(firstExitPath, logPath, ["reflect-rules"]);
      const second = validateMaintenanceExecution(secondExitPath, logPath, ["reflect-rules"]);

      expect(first.maintenanceStatus).toBe("failed");
      expect(first.semanticStatus).toBe("semantic_fail");
      expect(first.guardUpdated).toBe(false);
      expect(first.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "reflect-rules",
          failureCategory: "semantic_failure",
          failureClass: "invalid_response_format_zero_stored",
          storedCount: 0,
        }),
      );
      expect(first.reportableIssues[0]?.fingerprint.join(":")).toBe(
        "hybrid-memory-maintenance:weekly-reflection:reflect-rules:invalid_response_format_zero_stored",
      );
      expect(first.reportableIssues.length).toBeGreaterThan(0);
      expect(second.reportableIssues.length).toBeGreaterThan(0);
      expect(second.reportableIssues[0]?.fingerprint.join(":")).toBe(first.reportableIssues[0]?.fingerprint.join(":"));
    });

    it("does not flag skipped_guard reflect-rules as zero stored semantic failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-reflection-20260710T070000Z-111.exit.txt");
      const logPath = join(tmpDir, "reflect.log");
      writeFileSync(
        exitPath,
        "2026-07-10T07:00:00Z reflect-rules exit=0 status=skipped_guard reason=locked_by_concurrent_run\n",
      );
      writeFileSync(logPath, "reflect-rules parse_success=true stored=0 semantic=success\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(
        result.reportableIssues.some(
          (i) => i.stepName === "reflect-rules" && i.failureClass === "reflect_rules_zero_stored",
        ),
      ).toBe(false);
      expect(result.maintenanceStatus).toBe("success");
    });

    it("does not flag skipped_gate reflect-rules as zero stored semantic failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-reflection-20260710T070000Z-222.exit.txt");
      const logPath = join(tmpDir, "reflect.log");
      writeFileSync(
        exitPath,
        "2026-07-10T07:00:00Z reflect-rules exit=0 status=skipped_gate reason=reflection_disabled\n",
      );
      writeFileSync(logPath, "reflect-rules parse_success=true stored=0 semantic=success\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(
        result.reportableIssues.some(
          (i) => i.stepName === "reflect-rules" && i.failureClass === "reflect_rules_zero_stored",
        ),
      ).toBe(false);
      expect(result.maintenanceStatus).toBe("success");
    });

    it("does not flag reflect-rules zero_rules_reason=valid_no_actionable_rules as a semantic failure (#2043)", () => {
      // The model ran fine and legitimately found nothing to extract — maintenance-step-runners.ts and
      // semantic-outcome.ts already treat this as success; this validator must agree.
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-reflection-20260508T021500Z-111.exit.txt");
      const logPath = join(tmpDir, "reflect.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect-rules exit=0\n");
      writeFileSync(
        logPath,
        "reflect-rules — diagnostics: model_response_chars=1200 parse_success=true parsed_candidates=0 " +
          "rejected_duplicates=0 rejected_low_confidence=0 stored=0 status=ok zero_rules_reason=valid_no_actionable_rules\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(
        result.reportableIssues.some((i) => i.stepName === "reflect-rules" && i.failureCategory === "semantic_failure"),
      ).toBe(false);
    });

    it("detects self-correction failed_partial semantic failures", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "self-correction-partial.exit.txt");
      const logPath = join(tmpDir, "self-correction-partial.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z self-correction-run exit=1\n");
      writeFileSync(
        logPath,
        "self-correction-run status=failed_partial parse_success=false batches_completed=1/2 analysed=2\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["self-correction-run"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "self-correction-run",
          failureClass: "self_correction_partial_batch_failure",
        }),
      );
    });

    it("detects self-correction zero-parsed semantic failures", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "self-correction.exit.txt");
      const logPath = join(tmpDir, "self-correction.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z self-correction-run exit=1\n");
      writeFileSync(
        logPath,
        "self-correction-run status=failed_suspect_zero_parsed parse_success=false analysed=0 incidents=3\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["self-correction-run"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "self-correction-run",
          failureCategory: "semantic_failure",
        }),
      );
    });

    it("detects self-correction analysis failure (status=failed)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "self-correction-analysis.exit.txt");
      const logPath = join(tmpDir, "self-correction-analysis.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z self-correction-run exit=1\n");
      writeFileSync(
        logPath,
        "Error: simulated first-batch LLM API failure status=failed\nself-correction-run 2 incidents found, 0 analysed parse_success=false batches_completed=0/1\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["self-correction-run"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "self-correction-run",
          failureCategory: "semantic_failure",
          failureClass: "self_correction_analysis_failure",
        }),
      );
    });

    it("detects generate-proposals semantic_empty failures", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "generate-proposals.exit.txt");
      const logPath = join(tmpDir, "generate-proposals.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z generate-proposals exit=1\n");
      writeFileSync(
        logPath,
        "memory-hybrid: generate-proposals semantic_empty: had insight input but parsed zero proposal items parse_success=false\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["generate-proposals"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "generate-proposals",
          failureCategory: "semantic_failure",
        }),
      );
    });

    it("detects extract-reinforcement degraded_model_or_parser", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "extract-reinforcement.exit.txt");
      const logPath = join(tmpDir, "extract-reinforcement.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z extract-reinforcement exit=0\n");
      writeFileSync(
        logPath,
        "extract-reinforcement annotationStatus=degraded_model_or_parser incidents=4 annotated=0\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["extract-reinforcement"]);

      expect(result.semanticStatus).toBe("degraded");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "extract-reinforcement",
          failureCategory: "semantic_failure",
        }),
      );
    });

    it("blocks guard updates when extract-reinforcement reports semantic empty", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "extract-reinforcement.exit.txt");
      const logPath = join(tmpDir, "extract-reinforcement.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z extract-reinforcement exit=0\n");
      writeFileSync(
        logPath,
        "memory-hybrid: extract-reinforcement suspect: 4 incident(s) but zero parsed remediations\nextract-reinforcement sessions=12 jobRunId=abc semantic=failed_semantic_empty\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["extract-reinforcement"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "extract-reinforcement",
          failureClass: "extract_reinforcement_semantic_empty",
        }),
      );
    });

    it("detects extract-daily vector_failures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "extract-daily.exit.txt");
      const logPath = join(tmpDir, "extract-daily.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z extract-daily exit=0\n");
      writeFileSync(logPath, "extract-daily stored=3 vector_failures=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["extract-daily"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "extract-daily",
          failureClass: "extract_daily_vector_partial",
        }),
      );
    });

    it("detects extract-procedures readFailures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "extract-procedures.exit.txt");
      const logPath = join(tmpDir, "extract-procedures.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z extract-procedures exit=0\n");
      writeFileSync(
        logPath,
        "extract-procedures sessions=2 readFailures=1 semantic=partial\nmemory-hybrid: extract-procedures — 1 session read failure(s); scan cursor not advanced\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["extract-procedures"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "extract-procedures",
          failureClass: "extract_procedures_read_failures",
        }),
      );
    });

    it("detects reflect embed partial on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "reflect.exit.txt");
      const logPath = join(tmpDir, "reflect.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect exit=0\n");
      writeFileSync(
        logPath,
        "patternsStored=2 facts=40 semantic=partial\nmemory-hybrid: reflection — finished: 2 pattern(s) stored, 0 skipped, 3 new-pattern embed failure(s), 5 candidate(s) total\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "reflect",
          failureClass: "reflect_embed_partial",
        }),
      );
    });

    it("allows healthy enrich-entities incremental catch-up on exit=0 (#2009)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "enrich-entities.exit.txt");
      const logPath = join(tmpDir, "enrich-entities.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities processed=200 enriched=41 llmFailures=0 stopReason=exhausted remaining=19789 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities"]);

      expect(result.maintenanceStatus).not.toBe("failed");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "enrich-entities",
          failureClass: "enrich_entities_incomplete_catchup",
        }),
      );
    });

    it("allows legacy semantic=partial logs when metrics show healthy catch-up (#2009)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "enrich-entities.exit.txt");
      const logPath = join(tmpDir, "enrich-entities.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities processed=200 enriched=41 llmFailures=0 stopReason=exhausted remaining=19789 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities"]);

      expect(result.maintenanceStatus).not.toBe("failed");
    });

    it("allows enrich logs missing processed metric when stopReason is exhausted (#2009)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-enrich-missing-processed-"));
      const exitPath = join(tmpDir, "enrich-entities.exit.txt");
      const logPath = join(tmpDir, "enrich-entities.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities enriched=41 llmFailures=0 stopReason=exhausted remaining=19789 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities"]);

      expect(result.maintenanceStatus).not.toBe("failed");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "enrich-entities",
          failureClass: "enrich_entities_incomplete_catchup",
        }),
      );
    });

    it("blocks enrich-entities budget stop with zero processed facts (#2009)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "enrich-entities.exit.txt");
      const logPath = join(tmpDir, "enrich-entities.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities processed=0 enriched=0 llmFailures=0 stopReason=time_budget remaining=19789 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "enrich-entities",
          failureClass: "enrich_entities_incomplete_catchup",
        }),
      );
    });

    it("detects enrich-entities llmFailures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "enrich-entities.exit.txt");
      const logPath = join(tmpDir, "enrich-entities.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities processed=20 enriched=5 llmFailures=2 stopReason=provider_budget remaining=100 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "enrich-entities",
          failureClass: "enrich_entities_llm_failures",
        }),
      );
    });

    it("detects consolidate cluster failures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "consolidate.exit.txt");
      const logPath = join(tmpDir, "consolidate.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z consolidate exit=0\n");
      writeFileSync(
        logPath,
        "consolidate merged=1 clusters=3 clustersFailed=2 vector_failures=0 semantic=partial\nmemory-hybrid: consolidate LLM failed for cluster: timeout\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["consolidate"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "consolidate",
          failureClass: "consolidate_cluster_failures",
        }),
      );
    });

    it("detects reflect-identity LLM failure on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "reflect-identity.exit.txt");
      const logPath = join(tmpDir, "reflect-identity.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect-identity exit=0\n");
      writeFileSync(
        logPath,
        "reflect-identity insightsStored=0 insightsExtracted=0 semantic=failed\nmemory-hybrid: reflect-identity LLM failed: 429\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-identity"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "reflect-identity",
          failureClass: "reflect_identity_llm_failure",
        }),
      );
    });

    it("detects resolve-contradictions degraded backlog on exit=0 without blocking guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "resolve-contradictions.exit.txt");
      const logPath = join(tmpDir, "resolve-contradictions.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z resolve-contradictions exit=0\n");
      writeFileSync(
        logPath,
        "resolve-contradictions summary mode=default auto_resolved=0 ambiguous=250 no_progress=1 degraded=1 threshold_enabled=1 threshold=200 consecutive=1 consecutive_threshold=1 semantic=monitoring\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["resolve-contradictions"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.guardUpdated).toBe(true);
      expect(result.semanticStatus).toBe("degraded");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "resolve-contradictions",
          failureClass: "resolve_contradictions_degraded_backlog",
        }),
      );
    });

    it("detects generate-auto-skills validation failures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "generate-auto-skills.exit.txt");
      const logPath = join(tmpDir, "generate-auto-skills.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z generate-auto-skills exit=0\n");
      writeFileSync(logPath, "generate-auto-skills failedValidation=2 failedEval=1 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["generate-auto-skills"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "generate-auto-skills",
          failureClass: "generate_auto_skills_validation_failures",
        }),
      );
    });

    it("detects prune vector_failures on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "prune.exit.txt");
      const logPath = join(tmpDir, "prune.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z prune exit=0\n");
      writeFileSync(logPath, "prune pruned=3 vector_failures=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "prune",
          failureClass: "prune_vector_cleanup_partial",
        }),
      );
    });

    it("detects distill partial on exit=0 and blocks guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "distill.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(logPath, "distill stored=5 sessions=3 batchFailures=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "distill",
          failureClass: "distill_partial_batch_failures",
        }),
      );
    });

    it("threads batchFailures/hardBatchFailures/truncatedBatches counts into the distill issue (GlitchTip issue 27)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "distill.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "memory-hybrid: distill done — status=partial extracted=5 blocks=10/10 batchFailures=2 hardBatchFailures=1 truncatedBatches=1 duration=30s\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      const issue = result.reportableIssues.find((i) => i.failureClass === "distill_partial_batch_failures");
      expect(issue?.batchFailures).toBe(2);
      expect(issue?.hardBatchFailures).toBe(1);
      expect(issue?.truncatedBatches).toBe(1);
      // The structured counts also show up in the message, not just as invisible fields.
      expect(issue?.message).toContain("batchFailures=2");
      expect(issue?.message).toContain("hardBatchFailures=1");
      expect(issue?.message).toContain("truncatedBatches=1");
    });

    it("does not treat all-uncertain continuous-verification as a nightly failure on exit=0", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "continuous-verification.exit.txt");
      const logPath = join(tmpDir, "continuous-verification.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z continuous-verification exit=0\n");
      writeFileSync(
        logPath,
        "continuous-verification checked=12 confirmed=0 stale=0 uncertain=12 errors=0 semantic=success Machine status: status=healthy reason=healthy checked=12 confirmed=0 stale=0 uncertain=12 errors=0\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["continuous-verification"]);

      expect(result.maintenanceStatus).not.toBe("failed");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "continuous-verification",
          failureClass: "continuous_verification_all_uncertain",
        }),
      );
    });

    it("detects degraded implicit-feedback collapse backlogs that change nothing", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-implicit-feedback-collapse-20260508T021500Z-111.exit.txt");
      const logPath = join(tmpDir, "collapse.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z implicit-feedback-collapse exit=0\n");
      writeFileSync(logPath, "weekly-implicit-feedback-collapse scanned=10432 collapsed=0 changed=0\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["implicit-feedback-collapse"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.semanticStatus).toBe("degraded");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          failureClass: "implicit_feedback_large_backlog_zero_changes",
          factsScanned: 10432,
          collapsedCount: 0,
        }),
      );
    });

    it("detects unusable incident diagnostics artifacts", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "vm-memory-incident-20260508T021500Z-111.exit.txt");
      const logPath = join(tmpDir, "incident.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z diagnostics exit=0\n");
      writeFileSync(
        logPath,
        "vm memory incident bundle created at /tmp/bundle; memory-diagnostics-live.json 0 bytes and malformed",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["diagnostics"]);

      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "diagnostics",
          failureCategory: "diagnostic_failure",
          failureClass: "zero_byte_memory_diagnostics",
          artifactPaths: ["memory-diagnostics-live.json"],
        }),
      );
    });

    it("classifies LanceDB commit conflict from step log content when reason is generic nonzero_exit", () => {
      const testDir = mkdtempSync(join(tmpdir(), "cron-exit-test-"));
      const exitPath = join(testDir, "test.exit");
      const logPath = join(testDir, "test.log");

      // Realistic scenario: HM_EXIT has generic reason but log has specific error
      writeFileSync(exitPath, "2026-05-08T02:15:30Z step=reflect-rules exit=1 status=failed reason=nonzero_exit\n");
      writeFileSync(
        logPath,
        "reflect-rules starting\nError: LanceDB commit conflict: concurrent maintenance detected\nreflect-rules failed with exit code 1\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "reflect-rules",
          failureCategory: "concurrency_storage_failure",
          failureClass: "lancedb_commit_conflict",
          exitCode: 1,
        }),
      );
    });

    it("classifies database lock timeout from step log content when reason is generic nonzero_exit", () => {
      const testDir = mkdtempSync(join(tmpdir(), "cron-exit-test-"));
      const exitPath = join(testDir, "test.exit");
      const logPath = join(testDir, "test.log");

      // Realistic scenario: HM_EXIT has generic reason but log has specific error
      writeFileSync(exitPath, "2026-05-08T02:15:30Z step=consolidate exit=1 status=failed reason=nonzero_exit\n");
      writeFileSync(
        logPath,
        "consolidate starting\nError: database is locked (SQLITE_BUSY)\nconsolidate failed with exit code 1\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["consolidate"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "consolidate",
          failureCategory: "concurrency_storage_failure",
          failureClass: "db_lock_timeout",
          exitCode: 1,
        }),
      );
    });

    it("suppresses the generic nonzero_exit issue when a more specific issue exists for the same step (GlitchTip 22/29/23)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "nightly-memory-sweep.exit.txt");
      const logPath = join(tmpDir, "nightly-memory-sweep.log");
      writeFileSync(exitPath, "2026-07-23T02:15:30Z distill exit=1\n");
      writeFileSync(logPath, "distill stored=5 sessions=3 batchFailures=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({ stepName: "distill", failureClass: "distill_partial_batch_failures" }),
      );
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({ stepName: "distill", failureClass: "nonzero_exit" }),
      );
      // The surviving issue still makes clear the step also exited non-zero.
      const kept = result.reportableIssues.find((i) => i.failureClass === "distill_partial_batch_failures");
      expect(kept?.message).toMatch(/exit=1/);
      expect(kept?.exitCode).toBe(1);
    });

    it("keeps the generic nonzero_exit issue when no more specific issue exists for that step", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "some-job.exit.txt");
      const logPath = join(tmpDir, "some-job.log");
      writeFileSync(exitPath, "2026-07-23T02:15:30Z prune exit=1\n");
      writeFileSync(logPath, "prune: something broke unexpectedly\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({ stepName: "prune", failureClass: "nonzero_exit" }),
      );
    });

    it("suppresses the top-level umbrella nonzero_exit issue when a child step issue exists (GlitchTip issue 26)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "maintenance-nightly.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly.log");
      writeFileSync(exitPath, "2026-07-23T02:15:30Z distill exit=1\n2026-07-23T02:16:00Z maintenance-nightly exit=1\n");
      writeFileSync(logPath, "distill stored=5 sessions=3 batchFailures=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill", "maintenance-nightly"]);

      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({ stepName: "maintenance-nightly", failureClass: "nonzero_exit" }),
      );
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({ stepName: "distill", failureClass: "distill_partial_batch_failures" }),
      );
    });

    it("keeps the umbrella nonzero_exit issue when it is the only issue in the pass", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "maintenance-nightly.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly.log");
      writeFileSync(exitPath, "2026-07-23T02:15:30Z maintenance-nightly exit=1\n");
      writeFileSync(logPath, "maintenance-nightly: unexpected crash outside every known step check\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["maintenance-nightly"]);

      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({ stepName: "maintenance-nightly", failureClass: "nonzero_exit" }),
      );
    });

    it("classifies unknown commands with unknown_maintenance_command not missing_required_step", () => {
      const testDir = mkdtempSync(join(tmpdir(), "cron-exit-test-"));
      const exitPath = join(testDir, "test.exit");
      const logPath = join(testDir, "test.log");

      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect-rules exit=0\n");
      writeFileSync(logPath, "error: unknown command 'unknown-fancy-command'\nreflect-rules completed\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "validate-cron-exit",
          failureCategory: "mechanical_failure",
          failureClass: "unknown_maintenance_command",
          message: expect.stringContaining("unknown-fancy-command"),
        }),
      );
    });

    it("blocks guard updates when hidden LLM failures are logged without a non-zero exit", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "maintenance-nightly.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "distill: LLM call failed after retries\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["maintenance-nightly"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "maintenance",
          failureClass: "hidden_llm_failure",
        }),
      );
    });

    it("blocks guard updates when maintenance cursor did not advance", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "distill.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(logPath, "distill cursor_advanced=false scanned=1200\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "cursor",
          failureClass: "cursor_not_advanced",
        }),
      );
    });

    it("detects record-storage-sample storage_unavailable as monitoring without blocking guard", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "record-storage-sample.exit.txt");
      const logPath = join(tmpDir, "record-storage-sample.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z record-storage-sample exit=0\n");
      writeFileSync(
        logPath,
        "record-storage-sample: skipped (storage database unavailable) status=skipped_storage_unavailable reason=storage_unavailable semantic=monitoring",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["record-storage-sample"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.guardUpdated).toBe(true);
      expect(result.semanticStatus).toBe("degraded");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "record-storage-sample",
          failureClass: "record_storage_unavailable",
        }),
      );
    });

    it("detects analyze-maintenance-logs strict failures", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "analyze-maintenance-logs.exit.txt");
      const logPath = join(tmpDir, "analyze-maintenance-logs.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z analyze-maintenance-logs exit=0\n");
      writeFileSync(logPath, "analyze-maintenance-logs steps=12 findings=3 strict=fail semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["analyze-maintenance-logs"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "analyze-maintenance-logs",
          failureClass: "analyze_maintenance_logs_strict_fail",
        }),
      );
    });

    it("threads analyzer finding titles into the strict-fail issue message/tags (GlitchTip issue 24)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "analyze-maintenance-logs.exit.txt");
      const logPath = join(tmpDir, "analyze-maintenance-logs.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z analyze-maintenance-logs exit=0\n");
      writeFileSync(
        logPath,
        "analyze-maintenance-logs steps=12 findings=2 strict=fail semantic=partial findingTitles=[distill:plugin-bug, reflect:transient-llm]\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["analyze-maintenance-logs"]);

      const issue = result.reportableIssues.find((i) => i.failureClass === "analyze_maintenance_logs_strict_fail");
      expect(issue?.findingTitles).toEqual(["distill:plugin-bug", "reflect:transient-llm"]);
      expect(issue?.message).toContain("distill:plugin-bug");
      expect(issue?.message).toContain("reflect:transient-llm");
    });

    it("detects passive-observer errors as semantic failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "passive-observer.exit.txt");
      const logPath = join(tmpDir, "passive-observer.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z passive-observer exit=0\n");
      writeFileSync(logPath, "passive-observer scanned=42 errors=2 semantic=partial\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["passive-observer"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "passive-observer",
          failureClass: "passive_observer_errors",
        }),
      );
    });

    it("does not false-positive implicit-feedback collapse on generic collapse text", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "distill.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(logPath, "distill: cluster collapse avoided scanned=5000 collapsed=0\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          failureClass: "implicit_feedback_large_backlog_zero_changes",
        }),
      );
    });

    it("blocks guard updates when closed-loop analysis was interrupted", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "closed-loop.exit.txt");
      const logPath = join(tmpDir, "closed-loop.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z closed-loop-analysis exit=0\n");
      writeFileSync(
        logPath,
        "memory-hybrid: closed-loop — interrupted by wall-clock limit after 500 rows\nclosed-loop-analysis interrupted (500 rules measured, 0 deprecated, 0 boosted semantic=partial)\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["closed-loop-analysis"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "closed-loop-analysis",
          failureClass: "closed_loop_analysis_interrupted",
        }),
      );
    });

    it("blocks guard updates when cross-agent-learning reports batch errors", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "cross-agent.exit.txt");
      const logPath = join(tmpDir, "cross-agent.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z cross-agent-learning exit=0\n");
      writeFileSync(
        logPath,
        "Cross-agent learning complete:\n  Agents scanned: 3\n  Errors: 2\ncross-agent-learning: agents=3 generalised=1 errors=2 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["cross-agent-learning"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "cross-agent-learning",
          failureClass: "cross_agent_learning_errors",
        }),
      );
    });

    it("blocks guard updates when tool-effectiveness returns empty output", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "tool-effectiveness.exit.txt");
      const logPath = join(tmpDir, "tool-effectiveness.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z tool-effectiveness exit=0\n");
      writeFileSync(logPath, "tool-effectiveness: unexpected empty output\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["tool-effectiveness"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "tool-effectiveness",
          failureClass: "tool_effectiveness_empty_output",
        }),
      );
    });

    it("blocks guard updates when digest-autopilot reports partial status", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "digest-autopilot.exit.txt");
      const logPath = join(tmpDir, "digest-autopilot.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z digest-autopilot exit=0\n");
      writeFileSync(
        logPath,
        "Pending digest autopilot cron weekly-pending-digest-autopilot-20260508T082000Z\nStatus: partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["digest-autopilot"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "digest-autopilot",
          failureClass: "digest_autopilot_failed_status",
        }),
      );
    });

    it("blocks guard updates when audit-health JSON reports strict warnings on exit=0", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "audit-health.exit.txt");
      const logPath = join(tmpDir, "audit-health.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z audit-health exit=0\n");
      writeFileSync(
        logPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: "2026-05-09T15:06:34Z",
            status: "partial",
            ok: false,
            warningCount: 2,
            errorCount: 0,
            activeFacts: 42,
            exitCode: 2,
            exitReason: "strict_warnings",
            strictFailureReason: "2 warning(s) present and --strict was set",
            warnings: ["stale vector backlog", "missing storage sample"],
            errors: [],
            remediation: [],
          },
          null,
          2,
        ),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["audit-health"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "audit-health",
          failureClass: "strict_warnings",
        }),
      );
    });

    it("blocks guard updates when sensor-sweep reports errors", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "sensor-sweep.exit.txt");
      const logPath = join(tmpDir, "sensor-sweep.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z sensor-sweep exit=0\n");
      writeFileSync(
        logPath,
        "sensor-sweep tier=all: written=4 skipped=1 errors=2 semantic=partial\n  disk sensor failed\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["sensor-sweep"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "sensor-sweep",
          failureClass: "sensor_sweep_errors",
        }),
      );
    });

    it("blocks guard updates when crystallization-proposals stores are unavailable", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "crystallization-proposals.exit.txt");
      const logPath = join(tmpDir, "crystallization-proposals.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z crystallization-proposals exit=0\n");
      writeFileSync(logPath, "crystallization-proposals stores unavailable (change feed missing semantic=partial)\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["crystallization-proposals"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "crystallization-proposals",
          failureClass: "crystallization_proposals_stores_unavailable",
        }),
      );
    });

    it("blocks guard updates when crystallization-rescan reports errors", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "crystallization-rescan.exit.txt");
      const logPath = join(tmpDir, "crystallization-rescan.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z crystallization-rescan exit=0\n");
      writeFileSync(
        logPath,
        "crystallization-rescan errors=2 (skill A parse failed; skill B missing manifest semantic=partial)\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["crystallization-rescan"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "crystallization-rescan",
          failureClass: "crystallization_rescan_errors",
        }),
      );
    });

    it("blocks guard updates when implicit-feedback-collapse is interrupted", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "implicit-feedback-collapse.exit.txt");
      const logPath = join(tmpDir, "implicit-feedback-collapse.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z implicit-feedback-collapse exit=0\n");
      writeFileSync(
        logPath,
        "implicit-feedback-collapse interrupted (scanned=900 collapsed=12 interrupted=true semantic=partial)\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["implicit-feedback-collapse"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "implicit-feedback-collapse",
          failureClass: "implicit_feedback_collapse_interrupted",
        }),
      );
    });

    it("blocks guard updates when active-tasks-maintain reports reconcile failures", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "active-tasks-maintain.exit.txt");
      const logPath = join(tmpDir, "active-tasks-maintain.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z active-tasks-maintain exit=0\n");
      writeFileSync(
        logPath,
        "active-tasks-maintain partial failure (status=partial reconciled=2 failed=1 semantic=partial)\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["active-tasks-maintain"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "active-tasks-maintain",
          failureClass: "active_tasks_maintain_status_partial",
        }),
      );
    });

    it("blocks guard updates when build-languages fails in the log", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "build-languages.exit.txt");
      const logPath = join(tmpDir, "build-languages.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z build-languages exit=0\n");
      writeFileSync(
        logPath,
        "build-languages: ok=false semantic=partial error=LLM timeout\nError building language keywords: LLM timeout\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["build-languages"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "build-languages",
          failureClass: "build_languages_failed",
        }),
      );
    });

    it("labels enrich-entities-deep failures with the deep step name", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "enrich-entities-deep.exit.txt");
      const logPath = join(tmpDir, "enrich-entities-deep.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z enrich-entities-deep exit=0\n");
      writeFileSync(
        logPath,
        "enrich-entities-deep processed=10 enriched=4 llmFailures=2 stopReason=completed remaining=0 semantic=partial\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["enrich-entities-deep"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "enrich-entities-deep",
          failureClass: "enrich_entities_llm_failures",
        }),
      );
    });

    it("does not attribute passive-observer errors from unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "cross-agent.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z cross-agent-learning exit=0\n");
      writeFileSync(
        logPath,
        "passive-observer scanned=42 errors=2 semantic=partial\ncross-agent-learning: agents=3 generalised=1 errors=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["cross-agent-learning"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "passive-observer",
        }),
      );
    });

    it("does not attribute auto-classify batchFailures to distill in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "auto-classify reclassified=18/20 batchFailures=3 semantic=partial\ndistill stored=5 sessions=3 batchFailures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "distill",
          failureClass: "distill_partial_batch_failures",
        }),
      );
    });

    it("does not attribute distill vector_failures to prune in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "prune.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z prune exit=0\n");
      writeFileSync(
        logPath,
        "extract-daily stored=3 vector_failures=2 semantic=partial\nprune pruned=3 vector_failures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "prune",
          failureClass: "prune_vector_cleanup_partial",
        }),
      );
    });

    it("does not attribute self-correction parse_success=false to reflect-rules in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "reflect-rules.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect-rules exit=0\n");
      writeFileSync(
        logPath,
        "self-correction-run status=failed_partial parse_success=false analysed=0\nreflect-rules parse_success=true stored=4 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect-rules"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "reflect-rules",
        }),
      );
    });

    it("does not attribute unrelated status=failed lines to self-correction-run in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "Error: provider timeout status=failed\ndistill stored=5 sessions=3 batchFailures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "self-correction-run",
        }),
      );
    });

    it("does not attribute reflect-rules failures to reflect in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "reflect.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z reflect exit=0\n");
      writeFileSync(
        logPath,
        "reflect-rules parse_success=false stored=0 semantic=failed\nreflect patternsStored=5 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["reflect"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "reflect",
          failureClass: "reflect_embed_partial",
        }),
      );
    });

    it("does not attribute hidden LLM failures from unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "extract-directives: LLM call failed after retries semantic=partial\ndistill stored=5 sessions=3 batchFailures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          failureClass: "hidden_llm_failure",
        }),
      );
    });

    it("does not attribute cursor_not_advanced from unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "cross-agent.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z cross-agent-learning exit=0\n");
      writeFileSync(
        logPath,
        "extract-directives cursor_advanced=false semantic=partial\ncross-agent-learning: agents=3 generalised=1 errors=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["cross-agent-learning"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          failureClass: "cursor_not_advanced",
        }),
      );
    });

    it("does not attribute continuous-verification degradation to unrelated steps", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "continuous-verification checked=12 Machine status: status=degraded reason=all_uncertain errors=0 semantic=partial\ndistill stored=5 sessions=3 batchFailures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "continuous-verification",
        }),
      );
    });

    it("does not attribute closed-loop interruption to unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "tool-effectiveness.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z tool-effectiveness exit=0\n");
      writeFileSync(
        logPath,
        "memory-hybrid: closed-loop — interrupted by wall-clock limit\nclosed-loop-analysis interrupted semantic=partial\ntool-effectiveness ranked=12 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["tool-effectiveness"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "closed-loop-analysis",
        }),
      );
    });

    it("does not attribute digest-autopilot partial status to unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "prune.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z prune exit=0\n");
      writeFileSync(
        logPath,
        "Pending digest autopilot cron weekly-pending-digest-autopilot-20260508T082000Z\nStatus: partial\nprune pruned=3 vector_failures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["prune"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          stepName: "digest-autopilot",
        }),
      );
    });

    it("does not fail dream-cycle when standalone continuous-verification degraded lines appear in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "dream-cycle.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "continuous-verification checked=12 Machine status: status=degraded reason=all_uncertain errors=0 semantic=partial",
          "Dream cycle status: success=true core_success=true failed_stages=0 follow_up_failures=0",
          "[dream-cycle] pipeline complete in 120s (core=10s, follow-ups=6/6, follow-up-failures=0)",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.failedSteps.some((s) => s.step === "continuous-verification")).toBe(false);
    });

    it("does not attribute incident diagnostics artifacts to unrelated steps in combined logs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "distill.exit.txt");
      const logPath = join(tmpDir, "combined.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z distill exit=0\n");
      writeFileSync(
        logPath,
        "vm memory incident bundle created at /tmp/bundle; memory-diagnostics-live.json 0 bytes and malformed\ndistill stored=5 sessions=3 batchFailures=0 semantic=success\n",
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["distill"]);

      expect(result.maintenanceStatus).toBe("success");
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({
          failureClass: "zero_byte_memory_diagnostics",
        }),
      );
    });

    it("detects final-audit.json artifact failures for audit-health scoped runs", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-audit.exit.txt");
      const logPath = join(tmpDir, "audit.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z audit-health exit=0\n");
      writeFileSync(logPath, "audit-health wrote final-audit.json (0 bytes, malformed)\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["audit-health"]);

      expect(result.reportableIssues).toContainEqual(
        expect.objectContaining({
          stepName: "audit",
          failureClass: "missing_or_empty_required_artifact",
          artifactPaths: ["final-audit.json"],
        }),
      );
    });
  });

  describe("validateFromSummaryJson", () => {
    it("detects failed orchestrator inner steps from summary.json", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-test",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 1,
          summaryLine: "failed",
          steps: [
            {
              name: "self-correction-run",
              status: "failed",
              summary: "semantic=failed_semantic_empty",
              durationMs: 10,
              semanticOutcome: "failed_semantic_empty",
            },
          ],
          counts: { ok: 0, skipped: 0, deferred: 0, failed: 1, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=1\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.failedSteps.some((s) => s.step === "self-correction-run")).toBe(true);
    });

    it("treats ok status with failed semanticOutcome as maintenance failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-semantic-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-semantic",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with bad semantic",
          steps: [
            {
              name: "self-correction-run",
              status: "ok",
              summary: "semantic=failed_semantic_empty",
              durationMs: 10,
              semanticOutcome: "failed_semantic_empty",
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "self-correction-run")).toBe(true);
    });

    it("applies dream-cycle embedded continuous verification failures from HM_LOG in summary mode", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-dream-cycle-"));
      const summaryPath = join(tmpDir, "dream-cycle-run.summary.json");
      const exitPath = join(tmpDir, "dream-cycle-run.exit.txt");
      const logPath = join(tmpDir, "dream-cycle-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "dream-cycle-orch",
          tierLabel: "weekly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok",
          steps: [
            {
              name: "dream-cycle-core",
              status: "ok",
              summary: "semantic=success",
              durationMs: 1000,
              semanticOutcome: "success",
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z dream-cycle exit=0\n");
      writeFileSync(
        logPath,
        [
          "Continuous verification complete:",
          "  Checked: 12",
          "  Confirmed: 0",
          "  Stale: 0",
          "  Uncertain: 12",
          "  Errors: 12",
          "  Machine status: status=degraded reason=errors_present checked=12 confirmed=0 stale=0 uncertain=12 errors=12",
        ].join("\n"),
      );

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["dream-cycle"], true);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "continuous-verification")).toBe(true);
      expect(result.failedSteps.find((s) => s.step === "continuous-verification")?.failureReason).toBe(
        "errors_present",
      );
    });

    it("treats ok status with partial semanticOutcome as maintenance failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-partial-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-partial",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with partial semantic",
          steps: [
            {
              name: "self-correction-run",
              status: "ok",
              summary: "semantic=partial",
              durationMs: 10,
              semanticOutcome: "partial",
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("degraded");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "self-correction-run")).toBe(true);
    });

    it("treats repair-vectors orphan cleanup partial semantic as maintenance failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-repair-vectors-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-repair-vectors",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with orphan cleanup partial",
          steps: [
            {
              name: "repair-vectors",
              status: "ok",
              summary: "reembedded=1/1 failures=0 orphans=2 orphan_cleanup_failed=1 semantic=partial",
              durationMs: 10,
              semanticOutcome: "partial",
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["repair-vectors"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("degraded");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "repair-vectors")).toBe(true);
    });

    it("treats active-tasks-maintain partial semantic as maintenance failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-active-tasks-"));
      const summaryPath = join(tmpDir, "maintenance-cycle-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-cycle-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-cycle-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-active-tasks",
          tierLabel: "cycle",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with active tasks partial",
          steps: [
            {
              name: "active-tasks-maintain",
              status: "ok",
              summary: "status=partial reconciled=2 failed=1 semantic=partial",
              durationMs: 10,
              semanticOutcome: "partial",
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-cycle exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["active-tasks-maintain"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("degraded");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "active-tasks-maintain")).toBe(true);
    });

    it("treats ok status with legacy failed_suspect_zero_parsed in summary text as maintenance failure", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-legacy-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-legacy",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with legacy semantic in summary only",
          steps: [
            {
              name: "self-correction-run",
              status: "ok",
              summary: "incidents=3 analysed=0 jobRunId=abc semantic=failed_suspect_zero_parsed",
              durationMs: 10,
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("semantic_fail");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "self-correction-run")).toBe(true);
    });

    it("treats ok reflect-rules step with parse_success=false in summary as failure without log corroboration", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-reflect-"));
      const summaryPath = join(tmpDir, "maintenance-weekly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-weekly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-weekly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-reflect",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with reflect-rules parse failure in summary only",
          steps: [
            {
              name: "reflect-rules",
              status: "ok",
              summary:
                "rulesStored=0 rulesExtracted=0 parse_success=false zero_rules_reason=all_candidates_rejected status=partial",
              durationMs: 10,
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-weekly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["reflect-rules"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.some((s) => s.step === "reflect-rules")).toBe(true);
    });

    it("treats deferred guard-blocking required steps as failed when summary exitCode is 2", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-deferred-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-deferred",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 2,
          summaryLine: "deferred",
          steps: [
            { name: "prune", status: "ok", summary: "ok", durationMs: 10 },
            {
              name: "self-correction-run",
              status: "deferred",
              summary: "time budget exceeded",
              durationMs: 0,
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 1, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=2\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["prune", "self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.semanticStatus).toBe("degraded");
      expect(result.guardUpdated).toBe(false);
      const deferred = result.steps.find((s) => s.step === "self-correction-run");
      expect(deferred?.exitCode).toBe(2);
      expect(deferred?.status).toBe("ok");
    });

    it("fails when HM_LOG contains semantic failure patterns despite green summary.json", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-log-pattern-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-log-pattern",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok",
          steps: [
            {
              name: "self-correction-run",
              status: "ok",
              summary: "semantic=success",
              durationMs: 10,
            },
          ],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z self-correction-run exit=0\n");
      writeFileSync(
        logPath,
        "self-correction-run status=failed_suspect_zero_parsed parse_success=false incidents found=2 analysed=0\n",
      );

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["self-correction-run"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.reportableIssues?.some((i) => i.stepName === "self-correction-run")).toBe(true);
    });

    it("fails when consolidated wrapper HM_EXIT has exit=0 but status=failed", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-wrapper-failed-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-wrapper-failed",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok",
          steps: [{ name: "prune", status: "ok", summary: "pruned=1", durationMs: 10 }],
          counts: { ok: 1, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(
        exitPath,
        "2026-06-05T02:30:00Z step=maintenance-nightly exit=0 status=failed reason=tolerated_extract_daily_exit_1 duration_ms=120000\n",
      );
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["maintenance-nightly"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
    });

    it("updates guard for successful nightly summary with monitoring-only step semantics", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-monitoring-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-monitoring",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "ok with monitoring semantics",
          steps: [
            {
              name: "extract-implicit",
              status: "ok",
              summary: "128 signals (106+/22-) from 116/471 sessions semantic=monitoring",
              durationMs: 1200000,
              semanticOutcome: "monitoring",
            },
            {
              name: "audit-health",
              status: "ok",
              summary: "warnings=7 errors=0 semantic=monitoring",
              durationMs: 1200,
              semanticOutcome: "monitoring",
            },
          ],
          counts: { ok: 2, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=0\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["maintenance-nightly"], true);
      expect(result.maintenanceStatus).toBe("success");
      expect(result.semanticStatus).toBe("degraded");
      expect(result.guardUpdated).toBe(true);
      expect(result.failedSteps).toHaveLength(0);
    });

    it("falls back to HM_EXIT validation for empty consolidated summary", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-empty-consolidated-"));
      const summaryPath = join(tmpDir, "maintenance-nightly-run.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly-run.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly-run.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-empty",
          tierLabel: "nightly",
          startedAt: "2026-06-05T02:00:00.000Z",
          finishedAt: "2026-06-05T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 0,
          summaryLine: "empty",
          steps: [],
          counts: { ok: 0, skipped: 0, deferred: 0, failed: 0, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-06-05T02:30:00Z maintenance-nightly exit=1\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["maintenance-nightly"], true);
      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
    });

    it("suppresses the generic wrapper AND the umbrella issue in consolidated (summary.json) mode when a richer per-step issue already exists (GlitchTip 22/23/26/29/30)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-summary-dedup-"));
      const summaryPath = join(tmpDir, "maintenance-nightly.summary.json");
      const exitPath = join(tmpDir, "maintenance-nightly.exit.txt");
      const logPath = join(tmpDir, "maintenance-nightly.log");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId: "orch-dedup",
          tierLabel: "nightly",
          startedAt: "2026-07-23T02:00:00.000Z",
          finishedAt: "2026-07-23T02:30:00.000Z",
          durationMs: 1000,
          exitCode: 1,
          summaryLine: "failed",
          steps: [
            { name: "distill", status: "failed", summary: "stored=0 sessions=3 semantic=failed", durationMs: 10 },
          ],
          counts: { ok: 0, skipped: 0, deferred: 0, failed: 1, rateLimited: 0 },
        }),
      );
      writeFileSync(exitPath, "2026-07-23T02:30:00Z maintenance-nightly exit=1\n");
      writeFileSync(logPath, "");

      const result = validateFromSummaryJson(summaryPath, exitPath, logPath, ["maintenance-nightly"], true);

      expect(result.maintenanceStatus).toBe("failed");
      // The rich per-step detail (orchestrator_step_failed, carrying the inner step's own summary)
      // survives as the single reported issue...
      expect(result.reportableIssues).toHaveLength(1);
      expect(result.reportableIssues[0]).toMatchObject({
        stepName: "distill",
        failureClass: "orchestrator_step_failed",
      });
      // ...while both the plain "distill exited non-zero" duplicate AND the content-free
      // "maintenance-nightly exited non-zero" umbrella are suppressed, since the child issue
      // already explains what happened.
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({ stepName: "distill", failureClass: "nonzero_exit" }),
      );
      expect(result.reportableIssues).not.toContainEqual(
        expect.objectContaining({ stepName: "maintenance-nightly", failureClass: "nonzero_exit" }),
      );
    });
  });
});

describe("suppressRedundantGenericMaintenanceIssues (dedup unit tests)", () => {
  function makeIssue(overrides: Partial<MaintenanceTelemetryIssue>): MaintenanceTelemetryIssue {
    return {
      fingerprint: ["hybrid-memory-maintenance", "job", "step", "class"],
      jobName: "job",
      stepName: "step",
      failureCategory: "mechanical_failure",
      failureClass: "nonzero_exit",
      message: "job:step exited non-zero",
      semanticStatus: "unknown",
      ...overrides,
    };
  }

  it("passes through a single issue unchanged", () => {
    const issue = makeIssue({});
    expect(suppressRedundantGenericMaintenanceIssues([issue])).toEqual([issue]);
  });

  it("suppresses nonzero_exit for a step that also has a specific issue, enriching the specific message with the exit code", () => {
    const generic = makeIssue({ stepName: "distill", exitCode: 1 });
    const specific = makeIssue({
      stepName: "distill",
      failureClass: "distill_partial_batch_failures",
      failureCategory: "semantic_failure",
      message: "job:distill had partial batch failures despite a mechanically successful run",
    });

    const result = suppressRedundantGenericMaintenanceIssues([generic, specific]);

    expect(result).toHaveLength(1);
    expect(result[0].failureClass).toBe("distill_partial_batch_failures");
    expect(result[0].exitCode).toBe(1);
    expect(result[0].message).toContain("exit=1");
  });

  it("does not double-append when a specific issue's message already mentions the exit", () => {
    const generic = makeIssue({ stepName: "consolidate", exitCode: 1 });
    const specific = makeIssue({
      stepName: "consolidate",
      failureClass: "db_lock_timeout",
      failureCategory: "concurrency_storage_failure",
      message: "job:consolidate hit a database lock or timeout (exit=1)",
    });

    const result = suppressRedundantGenericMaintenanceIssues([generic, specific]);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("job:consolidate hit a database lock or timeout (exit=1)");
  });

  it("keeps a bare nonzero_exit issue when no specific sibling exists for that step", () => {
    const only = makeIssue({ stepName: "prune" });
    expect(suppressRedundantGenericMaintenanceIssues([only])).toEqual([only]);
  });

  it("suppresses the umbrella (stepName === jobName) when any other issue exists", () => {
    const umbrella = makeIssue({ jobName: "maintenance-nightly", stepName: "maintenance-nightly" });
    const other = makeIssue({ jobName: "maintenance-nightly", stepName: "distill", failureClass: "some_other_class" });

    const result = suppressRedundantGenericMaintenanceIssues([umbrella, other]);
    expect(result).toEqual([other]);
  });

  it("keeps the umbrella when it is the only issue", () => {
    const umbrella = makeIssue({ jobName: "maintenance-nightly", stepName: "maintenance-nightly" });
    expect(suppressRedundantGenericMaintenanceIssues([umbrella])).toEqual([umbrella]);
  });
});
