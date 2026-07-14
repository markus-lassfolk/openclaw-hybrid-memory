/**
 * Tests for the deterministic serendipity decision policy (Issue #2119).
 */

import { describe, expect, it } from "vitest";
import {
  buildSerendipityPolicySummary,
  type DecidableFinding,
  decideSerendipityAction,
  describeLevel,
} from "../services/serendipity-policy.js";

function f(overrides: Partial<DecidableFinding> = {}): DecidableFinding {
  return {
    findingType: "low_risk_cleanup",
    riskLevel: "low",
    reversibility: "easy",
    adjacency: "direct",
    estimatedHumanLoadReduction: "small",
    confidence: 0.8,
    external: false,
    destructive: false,
    privacySensitive: false,
    ...overrides,
  };
}

describe("decideSerendipityAction — guardrails", () => {
  it("always asks the user for destructive/external/privacy/irreversible, even at level 4", () => {
    expect(decideSerendipityAction(f({ destructive: true }), 4).action).toBe("ask_user");
    expect(decideSerendipityAction(f({ external: true }), 4).action).toBe("ask_user");
    expect(decideSerendipityAction(f({ privacySensitive: true }), 4).action).toBe("ask_user");
    expect(decideSerendipityAction(f({ reversibility: "irreversible" }), 4).action).toBe("ask_user");
  });
});

describe("decideSerendipityAction — level 0", () => {
  it("ignores non-safety and remembers safety", () => {
    expect(decideSerendipityAction(f(), 0).action).toBe("ignore");
    expect(decideSerendipityAction(f({ findingType: "unsafe_default" }), 0).action).toBe("remember");
  });
});

describe("decideSerendipityAction — safety", () => {
  it("fixes a trivially-safe safety issue and files the rest", () => {
    expect(
      decideSerendipityAction(f({ findingType: "packaging_defect", riskLevel: "low", reversibility: "easy" }), 1)
        .action,
    ).toBe("fix_now");
    expect(decideSerendipityAction(f({ findingType: "packaging_defect", riskLevel: "high" }), 1).action).toBe(
      "file_issue",
    );
  });
});

describe("decideSerendipityAction — adjacent cleanup (level 2)", () => {
  it("fixes low-risk direct, files near, remembers broad", () => {
    expect(decideSerendipityAction(f({ adjacency: "direct", riskLevel: "low" }), 2).action).toBe("fix_now");
    expect(decideSerendipityAction(f({ adjacency: "near" }), 2).action).toBe("file_issue");
    expect(decideSerendipityAction(f({ adjacency: "broad" }), 2).action).toBe("remember");
  });

  it("downgrades a would-be fix to remember when confidence is low", () => {
    expect(decideSerendipityAction(f({ confidence: 0.2 }), 2).action).toBe("remember");
  });
});

describe("decideSerendipityAction — improvement scout (level 3+)", () => {
  it("proposes skills for recurring friction and tasks for large leverage", () => {
    expect(decideSerendipityAction(f({ findingType: "repeated_friction" }), 3).action).toBe("propose_skill");
    expect(
      decideSerendipityAction(f({ findingType: "load_reduction_opportunity", estimatedHumanLoadReduction: "large" }), 3)
        .action,
    ).toBe("create_task");
  });
});

describe("decideSerendipityAction — steward (level 4)", () => {
  it("files broad findings rather than expanding scope silently", () => {
    expect(decideSerendipityAction(f({ adjacency: "broad", findingType: "documentation_mismatch" }), 4).action).toBe(
      "file_issue",
    );
  });
});

describe("policy summary + labels", () => {
  it("labels levels and truncates the summary to the cap", () => {
    expect(describeLevel(0)).toBe("requested-only");
    expect(describeLevel(2.5)).toBe("adjacent-cleanup");
    expect(describeLevel(4)).toBe("steward");
    const summary = buildSerendipityPolicySummary(2.5, 60);
    expect(summary.length).toBeLessThanOrEqual(60);
    expect(summary).toContain("2.5");
  });
});
