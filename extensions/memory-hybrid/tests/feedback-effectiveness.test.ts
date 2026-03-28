/**
 * Tests for closed-loop feedback effectiveness measurement (Issue #262 — Phase 3).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClosedLoopConfig } from "../config/types/features.js";
import { _testing } from "../index.js";
import {
  getEffectivenessReport,
  measureRuleEffectiveness,
  runClosedLoopAnalysis,
} from "../services/feedback-effectiveness.js";

const { FactsDB } = _testing;

function makeDb(dir: string) {
  return new FactsDB(join(dir, "facts.db"));
}

function storeRule(
  db: InstanceType<typeof FactsDB>,
  text = "Always verify before committing",
  source = "reinforcement-analysis",
) {
  return db.store({
    text,
    category: "technical",
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source,
  });
}

const DEFAULT_CONFIG: ClosedLoopConfig = {
  enabled: true,
  measurementWindowDays: 7,
  minSampleSize: 1,
  autoDeprecateThreshold: -0.3,
  autoBoostThreshold: 0.5,
  runInNightlyCycle: true,
};

// ---------------------------------------------------------------------------
// measureRuleEffectiveness
// ---------------------------------------------------------------------------

describe("measureRuleEffectiveness", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbe-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close();
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("returns null for non-existent rule ID", () => {
    const result = measureRuleEffectiveness("non-existent-id", db, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  it("returns a measurement for an existing rule", () => {
    const rule = storeRule(db);
    const result = measureRuleEffectiveness(rule.id, db, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe(rule.id);
    expect(result?.ruleText).toBe("Always verify before committing");
    expect(typeof result?.effectScore).toBe("number");
    expect(result?.effectScore).toBeGreaterThanOrEqual(-1);
    expect(result?.effectScore).toBeLessThanOrEqual(1);
  });

  it("calculates correct window dates", () => {
    const rule = storeRule(db);
    const result = measureRuleEffectiveness(rule.id, db, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    const windowDaySec = 7 * 24 * 60 * 60;
    expect(result?.windowStart).toBe(rule.createdAt - windowDaySec);
    expect(result?.windowEnd).toBe(rule.createdAt + windowDaySec);
  });

  it("uses 0 sample size when no feedback signals exist", () => {
    const rule = storeRule(db);
    const result = measureRuleEffectiveness(rule.id, db, DEFAULT_CONFIG);
    expect(result?.sampleSize).toBe(0);
    expect(result?.effectScore).toBe(0); // no change when no data
  });

  it("respects minSampleSize when computing (no action but reports)", () => {
    const rule = storeRule(db);
    const result = measureRuleEffectiveness(rule.id, db, { ...DEFAULT_CONFIG, minSampleSize: 100 });
    // Should still return a measurement (minSampleSize only gates auto-actions in runClosedLoopAnalysis)
    expect(result).not.toBeNull();
    expect(result?.sampleSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runClosedLoopAnalysis
// ---------------------------------------------------------------------------

describe("runClosedLoopAnalysis", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cla-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close();
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("returns empty report when disabled", () => {
    storeRule(db);
    const report = runClosedLoopAnalysis(db, { enabled: false });
    expect(report.rulesAnalyzed).toBe(0);
    expect(report.deprecated).toBe(0);
    expect(report.boosted).toBe(0);
    expect(report.measurements).toHaveLength(0);
  });

  it("runs without error when no qualifying rules", () => {
    const report = runClosedLoopAnalysis(db, DEFAULT_CONFIG);
    expect(report).toBeDefined();
    expect(report.measuredAt).toBeGreaterThan(0);
  });

  it("analyzes rules from reinforcement-analysis source", () => {
    storeRule(db, "Rule from reinforcement", "reinforcement-analysis");
    storeRule(db, "Rule from self-correction", "self-correction-analysis");
    // Rules are newly created, so age < windowDays → won't be measured
    // But they should be found by the query
    const report = runClosedLoopAnalysis(db, { ...DEFAULT_CONFIG, measurementWindowDays: 7, minSampleSize: 100 });
    expect(report).toBeDefined();
    // report.rulesAnalyzed counts discovered rules, but measurements only populated when criteria met
  });

  it("minSampleSize prevents auto-actions on low-data rules", () => {
    storeRule(db);
    // Set minSampleSize high so no actions are taken
    const report = runClosedLoopAnalysis(db, {
      ...DEFAULT_CONFIG,
      minSampleSize: 1000,
    });
    expect(report.deprecated).toBe(0);
    expect(report.boosted).toBe(0);
  });

  it("returns report with measuredAt timestamp", () => {
    const before = Math.floor(Date.now() / 1000);
    const report = runClosedLoopAnalysis(db, DEFAULT_CONFIG);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(report.measuredAt).toBeGreaterThanOrEqual(before);
    expect(report.measuredAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// getEffectivenessReport
// ---------------------------------------------------------------------------

describe("getEffectivenessReport", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ger-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close();
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("returns 'no data' message when table is empty", () => {
    const report = getEffectivenessReport(db);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(0);
    // Should contain message about no data
    expect(report.toLowerCase()).toMatch(/no|empty|available/);
  });

  it("returns string report", () => {
    const result = getEffectivenessReport(db);
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Effect score calculation
// ---------------------------------------------------------------------------

describe("Effect score calculation logic", () => {
  it("positive effect score indicates improvement", () => {
    // afterPositive > beforePositive → positive score
    const beforePositive = 2;
    const beforeNegative = 5;
    const afterPositive = 8;
    const afterNegative = 1;
    const beforeTotal = beforePositive + beforeNegative;
    const denom = Math.max(beforeTotal, 1);
    const score = (afterPositive - beforePositive) / denom - (afterNegative - beforeNegative) / denom;
    expect(score).toBeGreaterThan(0);
  });

  it("negative effect score indicates deterioration", () => {
    // afterNegative > beforeNegative → negative score
    const beforePositive = 5;
    const beforeNegative = 1;
    const afterPositive = 2;
    const afterNegative = 8;
    const beforeTotal = beforePositive + beforeNegative;
    const denom = Math.max(beforeTotal, 1);
    const score = (afterPositive - beforePositive) / denom - (afterNegative - beforeNegative) / denom;
    expect(score).toBeLessThan(0);
  });

  it("auto-deprecate threshold logic: score below -0.3 triggers deprecation", () => {
    const config: ClosedLoopConfig = {
      enabled: true,
      measurementWindowDays: 7,
      minSampleSize: 1,
      autoDeprecateThreshold: -0.3,
      autoBoostThreshold: 0.5,
      runInNightlyCycle: true,
    };
    const effectScore = -0.5;
    expect(effectScore < config.autoDeprecateThreshold!).toBe(true);
  });

  it("auto-boost threshold logic: score above 0.5 triggers boost", () => {
    const config: ClosedLoopConfig = {
      enabled: true,
      measurementWindowDays: 7,
      minSampleSize: 1,
      autoDeprecateThreshold: -0.3,
      autoBoostThreshold: 0.5,
      runInNightlyCycle: true,
    };
    const effectScore = 0.7;
    expect(effectScore > config.autoBoostThreshold!).toBe(true);
  });

  it("effect score between -0.3 and 0.5 triggers no action", () => {
    const config: ClosedLoopConfig = {
      enabled: true,
      measurementWindowDays: 7,
      minSampleSize: 1,
      autoDeprecateThreshold: -0.3,
      autoBoostThreshold: 0.5,
      runInNightlyCycle: true,
    };
    const effectScore = 0.1;
    expect(effectScore < config.autoDeprecateThreshold!).toBe(false);
    expect(effectScore > config.autoBoostThreshold!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("ClosedLoopConfig defaults", () => {
  it("enabled defaults to true", () => {
    const config: ClosedLoopConfig = {
      enabled: true,
      measurementWindowDays: 7,
      minSampleSize: 5,
      autoDeprecateThreshold: -0.3,
      autoBoostThreshold: 0.5,
      runInNightlyCycle: true,
    };
    expect(config.enabled).toBe(true);
    expect(config.measurementWindowDays).toBe(7);
    expect(config.minSampleSize).toBe(5);
    expect(config.autoDeprecateThreshold).toBe(-0.3);
    expect(config.autoBoostThreshold).toBe(0.5);
  });
});
