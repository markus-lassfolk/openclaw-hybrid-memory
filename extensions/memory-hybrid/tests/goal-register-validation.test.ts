import { describe, expect, it } from "vitest";
import { formatGoalClarityRejection, validateGoalRegisterClarity } from "../services/goal-register-validation.js";

describe("goal-register-validation", () => {
  it("rejects vague criteria and suggests improvements", () => {
    const result = validateGoalRegisterClarity({
      label: "deploy-api",
      description: "deploy",
      acceptance_criteria: ["done"],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.suggestedCriteria.length).toBeGreaterThan(0);
    expect(result.followUpQuestions.length).toBeGreaterThan(0);
    expect(formatGoalClarityRejection(result)).toContain("confirmed: true");
  });

  it("accepts measurable criteria", () => {
    const result = validateGoalRegisterClarity({
      label: "deploy-api",
      description: "Deploy the API service to production and verify health checks pass.",
      acceptance_criteria: [
        "Production deploy workflow completes with exit 0",
        "GET /health returns HTTP 200 for 24h after deploy",
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("requires two measurable criteria for high priority", () => {
    const result = validateGoalRegisterClarity({
      label: "fix-ci",
      description: "Fix CI failures on the main branch and restore green checks.",
      acceptance_criteria: ["CI pipeline on main branch is green"],
      priority: "high",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("critical/high"))).toBe(true);
  });
});
