/**
 * Tests for cron exit ledger validation.
 */

import { describe, it, expect } from "vitest";
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

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill", "extract-daily"],
      );

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

      const result = validateMaintenanceExecution(
        exitPath,
        undefined,
        ["prune", "distill"],
      );

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.failedSteps.length).toBe(1);
      expect(result.failedSteps[0].step).toBe("distill");
      expect(result.failedSteps[0].exitCode).toBe(1);
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

      expect(result.maintenanceStatus).toBe("partial");
      expect(result.guardUpdated).toBe(false);
      expect(result.missingSteps.length).toBe(2);
      expect(result.missingSteps).toEqual(["distill", "extract-daily"]);
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

      expect(result.maintenanceStatus).toBe("skipped");
      expect(result.guardUpdated).toBe(false);
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

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("consolidate-episodes");
    });

    it("should fail when exit file does not exist", () => {
      const result = validateMaintenanceExecution(
        "/nonexistent/path.exit.txt",
        undefined,
        ["prune"],
      );

      expect(result.maintenanceStatus).toBe("failed");
      expect(result.guardUpdated).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
});
