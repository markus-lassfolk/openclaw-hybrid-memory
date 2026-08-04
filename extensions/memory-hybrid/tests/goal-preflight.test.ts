import { describe, expect, it } from "vitest";
import { evaluateGoalPrerequisites, validateMaxIterations } from "../services/goal-preflight.js";

describe("goal prerequisite preflight", () => {
  it("rejects implementation without authorization and verification", () => {
    const result = evaluateGoalPrerequisites({
      description: "Implement a repository fix",
      acceptanceCriteria: ["Tests pass with exit zero"],
    });
    expect(result.status).toBe("hitl");
    expect(result.reasons.join(" ")).toMatch(/dispatch policy.*verification/);
  });
  it("keeps discovery as the first phase of the same implementation goal", () => {
    const result = evaluateGoalPrerequisites({
      description: "Implement a repository fix",
      acceptanceCriteria: ["Tests pass with exit zero"],
      verification: { type: "command_exit_zero", target: "npm test" },
      dispatchPolicy: {
        version: 1,
        classes: {
          write: {
            allowedAgents: ["forge"],
            readOnly: false,
            canonical: { repository: "o/r", prNumber: 1, branch: "fix", remoteHead: "abc" },
            writeScope: ["src"],
            forbidNewPr: true,
            forbidNewBranch: true,
          },
          discovery: { allowedAgents: ["forge"], readOnly: true },
        },
      },
    });
    expect(result.status).toBe("discovery_required");
    expect(result.phase).toBe("discovery");
  });
  it("allows read-only advisory goals without a write policy", () =>
    expect(
      evaluateGoalPrerequisites({
        description: "Review current metrics and report findings",
        acceptanceCriteria: ["A report file exists with cited metrics"],
      }).status,
    ).toBe("ready"));
  it("defaults and bounds iterations", () => {
    expect(validateMaxIterations(undefined)).toBe(20);
    expect(validateMaxIterations(7)).toBe(7);
    expect(validateMaxIterations(0)).toBeUndefined();
    expect(validateMaxIterations(Infinity)).toBeUndefined();
  });
});
