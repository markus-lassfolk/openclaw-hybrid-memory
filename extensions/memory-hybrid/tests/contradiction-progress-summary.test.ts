import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateContradictionProgress,
  persistConsecutiveNoProgressState,
  readConsecutiveNoProgressRuns,
  runContradictionMaintenanceAutoStep,
} from "../services/contradiction-progress-summary.js";

describe("contradiction-progress-summary", () => {
  let stateDir = "";

  afterEach(() => {
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  function tempOpenclawHome(): string {
    stateDir = mkdtempSync(join(tmpdir(), "hm-contradiction-progress-"));
    return stateDir;
  }

  it("requires consecutive no-progress runs before degraded exit", () => {
    const home = tempOpenclawHome();
    const metrics = { autoResolved: 0, ambiguous: 250, totalConsidered: 250 };

    const first = evaluateContradictionProgress(metrics, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      previousConsecutiveNoProgressRuns: readConsecutiveNoProgressRuns(home),
    });
    expect(first.degraded).toBe(false);
    expect(first.consecutiveNoProgressRuns).toBe(1);
    persistConsecutiveNoProgressState(metrics, first, home);

    const second = evaluateContradictionProgress(metrics, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      previousConsecutiveNoProgressRuns: readConsecutiveNoProgressRuns(home),
    });
    expect(second.degraded).toBe(false);
    expect(second.consecutiveNoProgressRuns).toBe(2);
    persistConsecutiveNoProgressState(metrics, second, home);

    const third = evaluateContradictionProgress(metrics, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      previousConsecutiveNoProgressRuns: readConsecutiveNoProgressRuns(home),
    });
    expect(third.degraded).toBe(true);
    expect(third.exitCode).toBe(2);
    expect(third.exitReason).toBe("ambiguous_backlog_no_progress");
  });

  it("resets consecutive counter when auto-resolved progress is made", () => {
    const home = tempOpenclawHome();
    const stuck = { autoResolved: 0, ambiguous: 250, totalConsidered: 250 };
    const first = evaluateContradictionProgress(stuck, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      previousConsecutiveNoProgressRuns: 0,
    });
    persistConsecutiveNoProgressState(stuck, first, home);
    expect(readConsecutiveNoProgressRuns(home)).toBe(1);

    const progress = { autoResolved: 3, ambiguous: 247, totalConsidered: 250 };
    const recovered = evaluateContradictionProgress(progress, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      previousConsecutiveNoProgressRuns: readConsecutiveNoProgressRuns(home),
    });
    expect(recovered.noProgress).toBe(false);
    expect(recovered.consecutiveNoProgressRuns).toBe(0);
    persistConsecutiveNoProgressState(progress, recovered, home);
    expect(readConsecutiveNoProgressRuns(home)).toBe(0);
  });

  it("persists state to openclaw cron guard directory", () => {
    const home = tempOpenclawHome();
    const metrics = { autoResolved: 0, ambiguous: 5, totalConsidered: 5 };
    const evaluation = evaluateContradictionProgress(metrics, {
      degradedAmbiguousThreshold: 1,
      degradedConsecutiveThreshold: 1,
      previousConsecutiveNoProgressRuns: 0,
    });
    persistConsecutiveNoProgressState(metrics, evaluation, home);

    const raw = readFileSync(join(home, "cron", "guard", "resolve-contradictions-no-progress.json"), "utf-8");
    const parsed = JSON.parse(raw) as { consecutiveNoProgressRuns: number; lastAmbiguous: number };
    expect(parsed.consecutiveNoProgressRuns).toBe(1);
    expect(parsed.lastAmbiguous).toBe(5);
  });

  it("treats degradedConsecutiveThreshold=0 as 1 in returned value", () => {
    const metrics = { autoResolved: 0, ambiguous: 250, totalConsidered: 250 };

    const evaluation = evaluateContradictionProgress(metrics, {
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 0,
      previousConsecutiveNoProgressRuns: 0,
    });

    expect(evaluation.degradedConsecutiveThreshold).toBe(1);
    expect(evaluation.consecutiveNoProgressRuns).toBe(1);
    expect(evaluation.degraded).toBe(true);
    expect(evaluation.exitCode).toBe(2);
  });

  it("runContradictionMaintenanceAutoStep persists guard state and marks degraded summaries", async () => {
    const home = tempOpenclawHome();
    const { summary, evaluation } = await runContradictionMaintenanceAutoStep({
      openclawHome: home,
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      runAuto: async () => ({
        total: 250,
        deterministic: 0,
        llm: 0,
        merged: 0,
        manualReview: 250,
        applied: true,
        decisionsApplied: 0,
        targetRate: 0.8,
        achievedRate: 0,
        targetMet: false,
        reviewItems: [],
      }),
    });
    expect(summary).toContain("mode=auto");
    expect(summary).toContain("semantic=success");
    expect(evaluation.degraded).toBe(false);
    expect(readConsecutiveNoProgressRuns(home)).toBe(1);

    const degraded = await runContradictionMaintenanceAutoStep({
      openclawHome: home,
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      runAuto: async () => ({
        total: 250,
        deterministic: 0,
        llm: 0,
        merged: 0,
        manualReview: 250,
        applied: true,
        decisionsApplied: 0,
        targetRate: 0.8,
        achievedRate: 0,
        targetMet: false,
        reviewItems: [],
      }),
    });
    expect(degraded.evaluation.degraded).toBe(false);
    expect(degraded.summary).toContain("semantic=success");

    const third = await runContradictionMaintenanceAutoStep({
      openclawHome: home,
      degradedAmbiguousThreshold: 200,
      degradedConsecutiveThreshold: 3,
      runAuto: async () => ({
        total: 250,
        deterministic: 0,
        llm: 0,
        merged: 0,
        manualReview: 250,
        applied: true,
        decisionsApplied: 0,
        targetRate: 0.8,
        achievedRate: 0,
        targetMet: false,
        reviewItems: [],
      }),
    });
    expect(third.evaluation.degraded).toBe(true);
    expect(third.summary).toContain("semantic=partial");
  });
});
