import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getStepGuardFilePath,
  readStepGuardTimestampMs,
  stepGuardEligible,
  writeStepGuardTimestampMs,
} from "../services/cron-guard.js";

describe("cron-guard step helpers (#1934)", () => {
  let openclawDir: string;

  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("writeStepGuardTimestampMs writes step--{name}.ms under cron/guard", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const ts = Date.now();
    writeStepGuardTimestampMs("test-step", ts, openclawDir);
    expect(readStepGuardTimestampMs("test-step", openclawDir)).toBe(ts);
    expect(getStepGuardFilePath("test-step", openclawDir)).toContain("step--test-step.ms");
  });

  it("stepGuardEligible allows first run when guard file is missing", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const now = Date.now();
    expect(stepGuardEligible("test-step", 60_000, openclawDir, now)).toEqual({
      eligible: true,
      lastRunMs: null,
      nextEligibleMs: null,
    });
  });

  it("stepGuardEligible blocks rerun inside guard interval", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const started = Date.now();
    writeStepGuardTimestampMs("test-step", started, openclawDir);
    const guardMs = 60 * 60 * 1000;
    const insideWindow = stepGuardEligible("test-step", guardMs, openclawDir, started + 30 * 60 * 1000);
    expect(insideWindow.eligible).toBe(false);
    expect(insideWindow.lastRunMs).toBe(started);
    expect(insideWindow.nextEligibleMs).toBe(started + guardMs);

    const afterWindow = stepGuardEligible("test-step", guardMs, openclawDir, started + guardMs);
    expect(afterWindow.eligible).toBe(true);
  });

  it("stepGuardEligible always allows when guard interval is zero", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    writeStepGuardTimestampMs("test-step", Date.now(), openclawDir);
    expect(stepGuardEligible("test-step", 0, openclawDir).eligible).toBe(true);
  });
});
