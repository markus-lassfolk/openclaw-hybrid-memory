import { describe, expect, it } from "vitest";
import {
  extractUserWorkflowGoal,
  extractUserMessageText,
  filterUserFacingGoals,
  isSystemWorkflowGoal,
  patternHasUserFacingGoal,
} from "../services/workflow-goal-classifier.js";

describe("workflow-goal-classifier", () => {
  it("flags cron and retry prompts as system goals", () => {
    expect(isSystemWorkflowGoal("[cron:abc openclaw-hybrid-memory-pr-stewardship")).toBe(true);
    expect(isSystemWorkflowGoal("[Retry after the previous model attempt failed or timed out]")).toBe(true);
    expect(isSystemWorkflowGoal("<!-- memory-hybrid: capability hints -->")).toBe(true);
    expect(isSystemWorkflowGoal("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context")).toBe(true);
    expect(isSystemWorkflowGoal("[Inter-session message] sourceSession=agent:main:subagent:abc")).toBe(true);
    expect(
      isSystemWorkflowGoal("A spawned subagent task was interrupted by a gateway restart or connection loss."),
    ).toBe(true);
  });

  it("accepts normal user tasks", () => {
    expect(isSystemWorkflowGoal("deploy the staging API and verify health checks")).toBe(false);
    expect(isSystemWorkflowGoal("fix the flaky test in workflow-store.test.ts")).toBe(false);
  });

  it("extractUserWorkflowGoal skips system injections for the first real user turn", () => {
    const goal = extractUserWorkflowGoal([
      { role: "user", content: "[cron:abc] run maintenance pulse" },
      { role: "user", content: "Review PR #1043 and summarize blockers" },
    ]);
    expect(goal).toBe("Review PR #1043 and summarize blockers");
  });

  it("returns unknown when all user messages are system prompts", () => {
    const goal = extractUserWorkflowGoal([
      { role: "user", content: "[cron:abc] maintenance" },
      { role: "assistant", content: "ok" },
    ]);
    expect(goal).toBe("unknown");
  });

  it("extractUserMessageText reads flattened session JSONL text field", () => {
    const text = extractUserMessageText({
      role: "user",
      text: "Deploy the staging API",
    });
    expect(text).toBe("Deploy the staging API");
  });

  it("extractUserMessageText reads array text blocks", () => {
    const text = extractUserMessageText({
      role: "user",
      content: [{ type: "text", text: "Deploy the staging API" }],
    });
    expect(text).toBe("Deploy the staging API");
  });

  it("filterUserFacingGoals removes cron goals", () => {
    expect(filterUserFacingGoals(["[cron:x]", "ship hotfix"])).toEqual(["ship hotfix"]);
  });

  it("patternHasUserFacingGoal requires at least one non-system goal by default", () => {
    expect(patternHasUserFacingGoal(["[cron:x]", "[Retry after the previous model]"])).toBe(false);
    expect(patternHasUserFacingGoal(["[cron:x]", "ship the hotfix"])).toBe(true);
    expect(patternHasUserFacingGoal(["[cron:x]"], { excludeSystemGoals: false })).toBe(true);
  });
});
