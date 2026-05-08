/**
 * Tests for cron exit ledger validation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseExitLine,
  validateMaintenanceExecution,
  checkForUnknownCommands,
  type ExitStep,
} from "../services/cron-exit-validator.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cron-exit-validator", () => {
  describe("parseExitLine", () => {
    it("should parse valid exit line", () => {
      const line = "2024-05-08T02:15:30Z prune exit=0";
      const result = parseExitLine(line);
      assert.ok(result);
      assert.equal(result.timestamp, "2024-05-08T02:15:30Z");
      assert.equal(result.step, "prune");
      assert.equal(result.exitCode, 0);
    });

    it("should parse line with non-zero exit code", () => {
      const line = "2024-05-08T02:15:30Z distill exit=1";
      const result = parseExitLine(line);
      assert.ok(result);
      assert.equal(result.exitCode, 1);
    });

    it("should return null for invalid line", () => {
      assert.equal(parseExitLine("invalid line"), null);
      assert.equal(parseExitLine(""), null);
      assert.equal(parseExitLine("2024-05-08 prune exit=0"), null);
    });

    it("should handle hyphenated step names", () => {
      const line = "2024-05-08T02:15:30Z extract-daily exit=0";
      const result = parseExitLine(line);
      assert.ok(result);
      assert.equal(result.step, "extract-daily");
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
      assert.equal(unknownCommands.length, 1);
      assert.equal(unknownCommands[0], "consolidate-episodes");
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
      assert.equal(unknownCommands.length, 2);
      assert.deepEqual(unknownCommands, ["foo", "bar"]);
    });

    it("should return empty array if no unknown commands", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const logPath = join(tmpDir, "test.log");
      writeFileSync(logPath, "Everything ok\nNo errors\n");

      const unknownCommands = checkForUnknownCommands(logPath);
      assert.equal(unknownCommands.length, 0);
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

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill", "extract-daily"],
      );

      assert.equal(result.maintenanceStatus, "success");
      assert.equal(result.guardUpdated, true);
      assert.equal(result.missingSteps.length, 0);
      assert.equal(result.failedSteps.length, 0);
      assert.equal(result.steps.length, 3);
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

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill"],
      );

      assert.equal(result.maintenanceStatus, "failed");
      assert.equal(result.guardUpdated, false);
      assert.equal(result.failedSteps.length, 1);
      assert.equal(result.failedSteps[0].step, "distill");
      assert.equal(result.failedSteps[0].exitCode, 1);
    });

    it("should report partial when steps are missing", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(
        exitPath,
        `2024-05-08T02:00:00Z prune exit=0
`,
      );

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill", "extract-daily"],
      );

      assert.equal(result.maintenanceStatus, "partial");
      assert.equal(result.guardUpdated, false);
      assert.equal(result.missingSteps.length, 2);
      assert.deepEqual(result.missingSteps, ["distill", "extract-daily"]);
    });

    it("should report skipped when all steps are missing", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
      const exitPath = join(tmpDir, "test.exit.txt");
      writeFileSync(exitPath, "");

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill"],
      );

      assert.equal(result.maintenanceStatus, "skipped");
      assert.equal(result.guardUpdated, false);
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

      assert.equal(result.maintenanceStatus, "success");
      assert.equal(result.guardUpdated, true);
      assert.equal(result.missingSteps.length, 0);
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

      const result = validateMaintenanceExecution(
        exitPath,
        logPath,
        ["prune"],
      );

      assert.equal(result.maintenanceStatus, "failed");
      assert.equal(result.guardUpdated, false);
      assert.ok(result.error?.includes("consolidate-episodes"));
    });

    it("should fail when exit file does not exist", () => {
      const result = validateMaintenanceExecution(
        "/nonexistent/path.exit.txt",
        undefined,
        ["prune"],
      );

      assert.equal(result.maintenanceStatus, "failed");
      assert.equal(result.guardUpdated, false);
      assert.ok(result.error?.includes("not found"));
    });
  });
});
