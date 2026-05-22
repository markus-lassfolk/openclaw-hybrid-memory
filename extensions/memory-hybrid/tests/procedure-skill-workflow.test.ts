import { describe, expect, it } from "vitest";
import { buildActionableWorkflow, lintWorkflowActionability } from "../services/procedure-skill-workflow.js";

describe("procedure-skill-workflow", () => {
  it("builds workflow with domain and verification language", () => {
    const recipe = [
      { tool: "read", summary: "Check Moltbook notification status" },
      { tool: "exec", summary: "Run validation test and verify exit code" },
    ];
    const workflow = buildActionableWorkflow(recipe, "Check Moltbook notifications");
    expect(workflow).not.toMatch(/only for the bounded task/i);
    expect(workflow.toLowerCase()).toMatch(/moltbook|notification|verify|check/);
    const lint = lintWorkflowActionability(workflow, "Check Moltbook notifications");
    expect(lint.actionable).toBe(true);
  });

  it("flags placeholder-only workflow", () => {
    const workflow = [
      "1. Use `exec` only for the bounded task: phase 1.",
      "2. Use `read` only for the bounded task: phase 2.",
      "3. Use `memory_recall` only for the bounded task: phase 3.",
    ].join("\n");
    const lint = lintWorkflowActionability(workflow, "Check Moltbook notifications");
    expect(lint.actionable).toBe(false);
  });
});
