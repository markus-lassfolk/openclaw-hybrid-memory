import { describe, expect, it } from "vitest";
import type { ActiveTaskEntry } from "../services/active-task.js";
import {
  buildLongRunningTaskDraft,
  buildLongRunningTaskRegistrationBlock,
  buildGoalEscalationHeartbeatBlock,
  buildHeartbeatTaskHygieneBlock,
  buildProposeGoalDraftFromTask,
  detectLongRunningWorkflowProposal,
  shouldAutoRegisterLongRunningTask,
} from "../services/task-hygiene.js";

function baseTask(over: Partial<ActiveTaskEntry> = {}): ActiveTaskEntry {
  return {
    label: "t1",
    description: "desc",
    status: "In progress",
    started: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

describe("task-hygiene", () => {
  it("buildHeartbeatTaskHygieneBlock includes stale labels", () => {
    const tasks = [baseTask({ label: "a", stale: true }), baseTask({ label: "b", stale: false })];
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 2500,
      suggestGoalAfterTaskAgeDays: 0,
    });
    expect(block).toContain("<task-hygiene>");
    expect(block).toContain("[a]");
    expect(block).not.toContain("[b]");
    expect(block).toContain("</task-hygiene>");
  });

  it("buildHeartbeatTaskHygieneBlock suggests goal when task is old enough", () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const tasks = [baseTask({ label: "long", updated: old })];
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 2500,
      suggestGoalAfterTaskAgeDays: 7,
    });
    expect(block).toContain("Long-running");
    expect(block).toContain("active_task_propose_goal");
  });

  it("buildHeartbeatTaskHygieneBlock truncates when over maxChars", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => baseTask({ label: `x${i}`, stale: true }));
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 400,
      suggestGoalAfterTaskAgeDays: 0,
    });
    expect(block.length).toBeLessThanOrEqual(420);
    expect(block).toContain("truncated");
  });

  it("buildGoalEscalationHeartbeatBlock lists blocked and stalled goals", () => {
    const block = buildGoalEscalationHeartbeatBlock(
      [
        { label: "g1", status: "blocked" },
        { label: "g2", status: "active" },
        { label: "g3", status: "stalled" },
      ],
      { maxChars: 2500 },
    );
    expect(block).toContain("<goal-escalation>");
    expect(block).toContain("[g1]");
    expect(block).toContain("[g3]");
    expect(block).not.toContain("[g2]");
    expect(block).toContain("HEARTBEAT_OK");
    expect(block).toContain("</goal-escalation>");
  });

  it("buildGoalEscalationHeartbeatBlock returns empty when no blocked/stalled", () => {
    expect(buildGoalEscalationHeartbeatBlock([{ label: "a", status: "active" }], { maxChars: 500 })).toBe("");
  });

  it("buildGoalEscalationHeartbeatBlock truncates correctly and forms well-formed markup", () => {
    // Very small maxChars to force truncation branch
    const goals = Array.from({ length: 20 }, (_, i) => ({ label: `goal-${i}`, status: "blocked" as const }));
    const block = buildGoalEscalationHeartbeatBlock(goals, { maxChars: 80 });
    // Must end with a single well-formed closing tag (not partial + second tag)
    expect(block).toMatch(/^<goal-escalation>/);
    expect(block).toMatch(/<\/goal-escalation>$/);
    // Must not contain double closing tags
    expect((block.match(/<\/goal-escalation>/g) || []).length).toBe(1);
    // Length must respect maxChars (with room for suffix)
    expect(block.length).toBeLessThanOrEqual(90);
    expect(block).toContain("truncated");
  });

  it("buildGoalEscalationHeartbeatBlock never produces negative slice index", () => {
    const goals = [{ label: "tiny", status: "blocked" as const }];
    // maxChars smaller than the suffix itself
    const block = buildGoalEscalationHeartbeatBlock(goals, { maxChars: 5 });
    expect(block).toContain("<goal-escalation>");
    // Must not crash and must produce a string (possibly very short, but valid)
    expect(typeof block).toBe("string");
  });

  it("buildProposeGoalDraftFromTask maps row to draft", () => {
    const draft = buildProposeGoalDraftFromTask(
      baseTask({ label: "my-task", next: "Run tests", description: "Ship feature" }),
    );
    expect(draft.suggestedLabel).toBe("my-task");
    expect(draft.suggestedDescription).toBe("Ship feature");
    expect(draft.suggestedCriteria.some((c) => c.includes("Run tests"))).toBe(true);
  });

  it("detectLongRunningWorkflowProposal detects PR queue and includes repo-stable label", () => {
    const proposal = detectLongRunningWorkflowProposal(
      "Please process PR queue for markus-lassfolk/openclaw-hybrid-memory",
      "/tmp/workspace",
    );
    expect(proposal).toBeTruthy();
    expect(proposal?.kind).toBe("pr_queue");
    expect(proposal?.label).toContain("pr-queue");
    expect(proposal?.label).toContain("markus-lassfolk-openclaw-hybrid-memory");
  });

  it("detectLongRunningWorkflowProposal detects deployment workflows", () => {
    const proposal = detectLongRunningWorkflowProposal("Monitor deployment to production and report rollout health");
    expect(proposal).toBeTruthy();
    expect(proposal?.kind).toBe("deployment");
    expect(proposal?.label).toContain("deploy-production");
  });

  it("buildLongRunningTaskRegistrationBlock includes payload and goal handoff hint", () => {
    const proposal = detectLongRunningWorkflowProposal("monitor CI for repo foo/bar");
    expect(proposal).toBeTruthy();
    if (!proposal) return;
    const draft = buildLongRunningTaskDraft(proposal, "2026-05-10T00:00:00.000Z");
    const block = buildLongRunningTaskRegistrationBlock(proposal, draft, {
      mode: "suggest",
      autoCreated: false,
      alreadyActive: false,
      sessionKey: "agent:main:main",
    });
    expect(block).toContain("<active-task-registration>");
    expect(block).toContain('"label"');
    expect(block).toContain("active_task_propose_goal");
  });

  it("shouldAutoRegisterLongRunningTask is limited to main/private sessions", () => {
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", "agent:main:main")).toBe(true);
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", "agent:private:session-1")).toBe(true);
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", "agent:forge:main")).toBe(false);
    expect(shouldAutoRegisterLongRunningTask("suggest", "agent:main:main")).toBe(false);
  });
});
