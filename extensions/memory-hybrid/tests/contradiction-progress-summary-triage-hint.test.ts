import { describe, expect, it } from "vitest";
import {
  type ContradictionProgressEvaluation,
  type ContradictionProgressMetrics,
  formatContradictionProgressSummaryLine,
} from "../services/contradiction-progress-summary.js";

const metrics: ContradictionProgressMetrics = { autoResolved: 0, ambiguous: 250, totalConsidered: 250 };

const backlogAlertEvaluation: ContradictionProgressEvaluation = {
  noProgress: true,
  degradedThresholdEnabled: true,
  degradedAmbiguousThreshold: 200,
  degradedConsecutiveThreshold: 3,
  consecutiveNoProgressRuns: 3,
  degraded: true,
  exitCode: 2,
  exitReason: "degraded_backlog",
  resolutionRate: 0,
};

describe("formatContradictionProgressSummaryLine triage hint (#2055 bonus fix)", () => {
  it("suggests a triage command using only flags that resolve-contradictions actually registers", () => {
    const line = formatContradictionProgressSummaryLine("auto", metrics, backlogAlertEvaluation);
    expect(line).toContain("triage_cmd=openclaw hybrid-mem resolve-contradictions --details");
    // resolve-contradictions has no --limit option (register-reflection-pipeline.ts); the hint
    // must not suggest a nonexistent flag.
    expect(line).not.toContain("--limit");
  });
});
