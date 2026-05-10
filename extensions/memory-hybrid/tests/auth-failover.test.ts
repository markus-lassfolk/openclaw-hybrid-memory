import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKOFF_MINUTES,
  DEFAULT_RESET_AFTER_HOURS,
  isOAuthInBackoff,
  recordOAuthFailure,
  resetAllBackoff,
} from "../utils/auth-failover.js";

describe("auth-failover", () => {
  let testDir: string;
  let statePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `auth-failover-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    statePath = join(testDir, "auth-failover-state.json");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("constants", () => {
    it("should have default backoff schedule", () => {
      expect(DEFAULT_BACKOFF_MINUTES).toEqual([5, 30, 60, 120, 240]);
    });

    it("should have default reset period", () => {
      expect(DEFAULT_RESET_AFTER_HOURS).toBe(24);
    });
  });

  describe("isOAuthInBackoff", () => {
    it("should return false when no failures recorded", () => {
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(false);
    });

    it("should return true when provider is in backoff period", () => {
      // Record a failure
      recordOAuthFailure("openai", { statePath });

      // Check immediately - should be in backoff
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(true);
    });

    it("should return false when backoff period has expired", () => {
      // Record a failure with very short backoff
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: [0] }); // 0 minutes = immediate expiry

      // Check - should not be in backoff
      const result = isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: [0] });
      expect(result).toBe(false);
    });

    it("should reset backoff after resetBackoffAfterHours", () => {
      // Create state with old lastResetTs
      const oldState = {
        lastResetTs: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
        providers: {
          openai: { backoffUntil: Date.now() + 5 * 60 * 1000, level: 0 },
        },
      };
      writeFileSync(statePath, JSON.stringify(oldState), "utf-8");

      // Check - should reset and return false
      const result = isOAuthInBackoff("openai", { statePath, resetBackoffAfterHours: 24 });
      expect(result).toBe(false);
    });

    it("should work without statePath (in-memory only)", () => {
      const result = isOAuthInBackoff("openai");
      expect(result).toBe(false);
    });

    it("should handle different providers independently", () => {
      recordOAuthFailure("openai", { statePath });
      recordOAuthFailure("anthropic", { statePath });

      expect(isOAuthInBackoff("openai", { statePath })).toBe(true);
      expect(isOAuthInBackoff("anthropic", { statePath })).toBe(true);
      expect(isOAuthInBackoff("google", { statePath })).toBe(false);
    });
  });

  describe("recordOAuthFailure", () => {
    it("should create state file on first failure", () => {
      expect(existsSync(statePath)).toBe(false);

      recordOAuthFailure("openai", { statePath });

      expect(existsSync(statePath)).toBe(true);
    });

    it("should start at level 0 for first failure", () => {
      recordOAuthFailure("openai", { statePath });

      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(true);
    });

    it("should advance backoff level on subsequent failures", () => {
      const shortSchedule = [0, 0, 5]; // First two expire immediately, third is 5 minutes

      // First failure (level 0, 0 minutes)
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: shortSchedule });
      expect(isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: shortSchedule })).toBe(false);

      // Second failure (level 1, 0 minutes)
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: shortSchedule });
      expect(isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: shortSchedule })).toBe(false);

      // Third failure (level 2, 5 minutes)
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: shortSchedule });
      expect(isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: shortSchedule })).toBe(true);
    });

    it("should cap backoff level at schedule length - 1", () => {
      const shortSchedule = [1, 2]; // Only 2 levels

      // Record many failures
      for (let i = 0; i < 10; i++) {
        recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: shortSchedule });
      }

      // Should still be in backoff (capped at level 1 = 2 minutes)
      const result = isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: shortSchedule });
      expect(result).toBe(true);
    });

    it("should work without statePath (in-memory only)", () => {
      // Should not throw
      expect(() => recordOAuthFailure("openai")).not.toThrow();
    });

    it("should calculate correct backoff duration", () => {
      const schedule = [5]; // 5 minutes
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: schedule });

      // Read state file to check backoffUntil
      const stateContent = require("node:fs").readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);

      const expectedBackoffUntil = state.providers.openai.backoffUntil;
      const now = Date.now();
      const diff = expectedBackoffUntil - now;

      // Should be approximately 5 minutes (allowing 1 second tolerance)
      expect(diff).toBeGreaterThan(5 * 60 * 1000 - 1000);
      expect(diff).toBeLessThanOrEqual(5 * 60 * 1000);
    });

    it("should persist state across function calls", () => {
      recordOAuthFailure("openai", { statePath });

      // Read state in a new call
      const inBackoff = isOAuthInBackoff("openai", { statePath });
      expect(inBackoff).toBe(true);
    });
  });

  describe("resetAllBackoff", () => {
    it("should clear all provider backoff state", () => {
      recordOAuthFailure("openai", { statePath });
      recordOAuthFailure("anthropic", { statePath });

      expect(isOAuthInBackoff("openai", { statePath })).toBe(true);
      expect(isOAuthInBackoff("anthropic", { statePath })).toBe(true);

      resetAllBackoff({ statePath });

      expect(isOAuthInBackoff("openai", { statePath })).toBe(false);
      expect(isOAuthInBackoff("anthropic", { statePath })).toBe(false);
    });

    it("should reset lastResetTs by default", () => {
      // Create state with old lastResetTs
      const oldTs = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      const oldState = {
        lastResetTs: oldTs,
        providers: { openai: { backoffUntil: Date.now() + 5 * 60 * 1000, level: 0 } },
      };
      writeFileSync(statePath, JSON.stringify(oldState), "utf-8");

      resetAllBackoff({ statePath });

      // Verify lastResetTs was updated
      const stateContent = require("node:fs").readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);
      expect(state.lastResetTs).toBeGreaterThan(oldTs);
    });

    it("should optionally preserve lastResetTs", () => {
      // Create state with specific lastResetTs
      const oldTs = Date.now() - 1000;
      const oldState = {
        lastResetTs: oldTs,
        providers: { openai: { backoffUntil: Date.now() + 5 * 60 * 1000, level: 0 } },
      };
      writeFileSync(statePath, JSON.stringify(oldState), "utf-8");

      resetAllBackoff({ statePath, resetTimer: false });

      // Verify lastResetTs was preserved
      const stateContent = require("node:fs").readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);
      expect(state.lastResetTs).toBe(oldTs);
    });

    it("should work without statePath", () => {
      // Should not throw
      expect(() => resetAllBackoff()).not.toThrow();
    });

    it("should persist cleared state to file", () => {
      recordOAuthFailure("openai", { statePath });
      resetAllBackoff({ statePath });

      // Verify state file exists and has empty providers
      expect(existsSync(statePath)).toBe(true);
      const stateContent = require("node:fs").readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);
      expect(state.providers).toEqual({});
    });
  });

  describe("state persistence", () => {
    it("should handle missing state file", () => {
      // Should not throw and return false
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(false);
    });

    it("should handle corrupted state file", () => {
      writeFileSync(statePath, "invalid json{{{", "utf-8");

      // Should not throw and return false
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(false);
    });

    it("should handle state file with wrong structure", () => {
      writeFileSync(statePath, JSON.stringify({ wrong: "structure" }), "utf-8");

      // Should not throw and return false
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(false);
    });

    it("should handle state file with missing fields", () => {
      writeFileSync(statePath, JSON.stringify({ providers: {} }), "utf-8");

      // Should not throw and return false
      const result = isOAuthInBackoff("openai", { statePath });
      expect(result).toBe(false);
    });
  });

  describe("custom options", () => {
    it("should support custom backoff schedule", () => {
      const customSchedule = [1, 2, 3];
      recordOAuthFailure("openai", { statePath, backoffScheduleMinutes: customSchedule });

      expect(isOAuthInBackoff("openai", { statePath, backoffScheduleMinutes: customSchedule })).toBe(true);
    });

    it("should support custom reset period", () => {
      const customResetHours = 1;

      // Create state with old lastResetTs (2 hours ago)
      const oldState = {
        lastResetTs: Date.now() - 2 * 60 * 60 * 1000,
        providers: { openai: { backoffUntil: Date.now() + 5 * 60 * 1000, level: 0 } },
      };
      writeFileSync(statePath, JSON.stringify(oldState), "utf-8");

      // Should reset because 2 hours > 1 hour custom reset period
      const result = isOAuthInBackoff("openai", { statePath, resetBackoffAfterHours: customResetHours });
      expect(result).toBe(false);
    });
  });
});
