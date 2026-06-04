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
  validateMaintenanceExecution,
} from "../services/cron-exit-validator.js";

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
      expect(result.missingSteps).toEqual(["dream-cycle"]);
      expect(result.error).toContain("Missing steps");
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

    it.each([
      ["errors_present", 12],
      ["all_uncertain", 0],
    ])("fails dream-cycle validation when continuous verification reports degraded %s machine status", (reason, errors) => {
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
          "  Errors: 0",
          "  Machine status: status=degraded reason=all_uncertain checked=12 confirmed=0 stale=0 uncertain=12 errors=0",
        ].join("\n"),
      );

      const result = validateMaintenanceExecution(exitPath, logPath, ["dream-cycle"]);

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0].timestamp).toBe("1970-01-01T00:00:00Z");
      expect(Number.isNaN(Date.parse(result.failedSteps[0].timestamp))).toBe(false);
      expect(result.failedSteps[0].failureReason).toBe("all_uncertain");
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

    it("detects degraded implicit-feedback collapse backlogs that change nothing", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "weekly-implicit-feedback-collapse-20260508T021500Z-111.exit.txt");
      const logPath = join(tmpDir, "collapse.log");
      writeFileSync(exitPath, "2026-05-08T02:15:30Z implicit-feedback-collapse exit=0\n");
      writeFileSync(logPath, "weekly-implicit-feedback-collapse scanned=10432 collapsed=0 changed=0\n");

      const result = validateMaintenanceExecution(exitPath, logPath, ["implicit-feedback-collapse"]);

      expect(result.maintenanceStatus).toBe("success");
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
  });
});
