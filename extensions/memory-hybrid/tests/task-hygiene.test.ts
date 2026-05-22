import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ActiveTaskEntry } from "../services/active-task.js";
import {
  buildLongRunningTaskDraft,
  buildLongRunningTaskRegistrationBlock,
  buildGoalEscalationHeartbeatBlock,
  buildHeartbeatTaskHygieneBlock,
  buildProposeGoalDraftFromTask,
  detectLongRunningWorkflowProposal,
  fetchLivePrBlockerStatus,
  shouldAutoRegisterLongRunningTask,
} from "../services/task-hygiene.js";

// fetchLivePrBlockerStatus mock for planActiveTaskHygiene integration tests.
// hoisted so it is initialized before vi.mock() runs.
const fetchLivePrBlockerStatusMock = vi.hoisted(() =>
  vi.fn<() => Promise<"unresolved_review_threads" | "red_ci" | "pending_ci" | "merge_conflict" | "human_approval" | "no_live_blocker">>(),
);

// Partial mock of task-hygiene.js: keep all exports, replace only fetchLivePrBlockerStatus
vi.mock("../services/task-hygiene.js", async () => {
  const actual = await vi.importMock("../services/task-hygiene.js");
  return {
    ...(actual as Record<string, unknown>),
    fetchLivePrBlockerStatus: fetchLivePrBlockerStatusMock,
  };
});

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

  it("detectLongRunningWorkflowProposal detects direct deploy commands", () => {
    const proposal = detectLongRunningWorkflowProposal("Deploy to production after smoke tests pass");
    expect(proposal).toBeTruthy();
    expect(proposal?.kind).toBe("deployment");
    expect(proposal?.label).toContain("deploy-production");
  });

  it("detectLongRunningWorkflowProposal does not classify generic release-note work as deployment", () => {
    const proposal = detectLongRunningWorkflowProposal("Please draft release notes for this branch and/or docs");
    expect(proposal).toBeNull();
  });

  it("detectLongRunningWorkflowProposal extracts repo context from GitHub URLs", () => {
    const proposal = detectLongRunningWorkflowProposal(
      "Process PR queue for https://github.com/openai/openclaw-hybrid-memory/pulls",
    );
    expect(proposal).toBeTruthy();
    expect(proposal?.label).toContain("wf-openai-openclaw-hybrid-memory-pr-queue");
    expect(proposal?.label).not.toContain("wf-github-com-openai");
  });

  it("detectLongRunningWorkflowProposal strips .git suffix in GitHub URL repo context", () => {
    const proposal = detectLongRunningWorkflowProposal(
      "Process PR queue for https://github.com/openai/openclaw-hybrid-memory.git",
    );
    expect(proposal).toBeTruthy();
    expect(proposal?.label).toContain("wf-openai-openclaw-hybrid-memory-pr-queue");
    expect(proposal?.label).not.toContain("-git-pr-queue");
  });

  it("detectLongRunningWorkflowProposal preserves repo separators for label stability", () => {
    const dotted = detectLongRunningWorkflowProposal("Process PR queue for https://github.com/acme/foo.bar");
    const dashed = detectLongRunningWorkflowProposal("Process PR queue for https://github.com/acme/foo-bar");
    expect(dotted).toBeTruthy();
    expect(dashed).toBeTruthy();
    expect(dotted?.label).toContain("wf-acme-foo.bar-pr-queue");
    expect(dashed?.label).toContain("wf-acme-foo-bar-pr-queue");
    expect(dotted?.label).not.toBe(dashed?.label);
  });

  it("detectLongRunningWorkflowProposal detects repo-wide issue sweep requests", () => {
    const proposal = detectLongRunningWorkflowProposal("Fix all open issues in this repository");
    expect(proposal).toBeTruthy();
    expect(proposal?.kind).toBe("issue_sweep");
    expect(proposal?.label).toContain("issue-sweep");
  });

  it("detectLongRunningWorkflowProposal ignores scoped issue-fix requests", () => {
    const proposal = detectLongRunningWorkflowProposal("Fix all issues with the login page in auth service");
    expect(proposal).toBeNull();
  });

  it("detectLongRunningWorkflowProposal ignores slash-noise tokens and picks explicit repo", () => {
    const proposal = detectLongRunningWorkflowProposal(
      "Process the PR queue and/or review open PRs for my-org/my-repo",
      "/tmp/workspace",
    );
    expect(proposal).toBeTruthy();
    expect(proposal?.label).toContain("wf-my-org-my-repo-pr-queue");
    expect(proposal?.label).not.toContain("wf-and-or");
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
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", "agent:main:subagent:abc123")).toBe(false);
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", "agent:forge:main")).toBe(false);
    expect(shouldAutoRegisterLongRunningTask("auto_main_private", null)).toBe(false);
    expect(shouldAutoRegisterLongRunningTask("suggest", "agent:main:main")).toBe(false);
  });

  describe("fetchLivePrBlockerStatus", () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
    });

    afterEach(() => {
      process.env = OLD_ENV;
      vi.restoreAllMocks();
    });

    it("returns no_live_blocker when no GitHub token is available", async () => {
      // Without a token, the function must be conservative and return no_live_blocker
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      const result = await fetchLivePrBlockerStatus("owner", "repo", 123);
      expect(result).toBe("no_live_blocker");
    });
  });

  describe("planActiveTaskHygiene PR live blocker integration", () => {
    // These tests exercise the PR blocker check at the integration level by
    // mocking fetchLivePrBlockerStatus (the function that calls GitHub).

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "REGRESSION: hygiene must NOT mark waiting/blocked when PR has unresolved review threads\n" +
        "    (green checks + BLOCKED mergeStateStatus + unresolved threads = Stage 4 feedback work, not abandoned)",
      async () => {
        const { planActiveTaskHygiene } = await import("../services/task-ledger-facts.js");

        // PR has green CI but mergeStateStatus=BLOCKED and unresolved review threads
        fetchLivePrBlockerStatusMock.mockResolvedValueOnce("unresolved_review_threads");

        const tasks: ActiveTaskEntry[] = [
          {
            label: "markus-lassfolk/openclaw-hybrid-memory#1549",
            description: "Drive PR #1549",
            status: "Waiting",
            started: "2026-05-20T00:00:00.000Z",
            updated: "2026-05-20T00:00:00.000Z",
          },
        ];

        const plan = await planActiveTaskHygiene(tasks, {
          olderThanMinutes: 1,
          checkPrLiveBlocker: true,
        });

        // The PR has unresolved review threads → should be classified as pr-live-blocker
        // NOT as stale-failed or dead-session
        const action = plan.actions.find((a) => a.label === tasks[0].label);
        expect(action).toBeDefined();
        expect(action?.kind).toBe("pr-live-blocker");
        expect(action?.toStatus).toBe("stage-4-feedback");
        expect(fetchLivePrBlockerStatusMock).toHaveBeenCalledWith(
          "markus-lassfolk",
          "openclaw-hybrid-memory",
          1549,
        );
      },
    );

    it("hygiene skips PR blocker check when checkPrLiveBlocker is false", async () => {
      const { planActiveTaskHygiene } = await import("../services/task-ledger-facts.js");

      fetchLivePrBlockerStatusMock.mockResolvedValueOnce("unresolved_review_threads");

      const tasks: ActiveTaskEntry[] = [
        {
          label: "markus-lassfolk/openclaw-hybrid-memory#1549",
          description: "Drive PR #1549",
          status: "Waiting",
          started: "2026-05-20T00:00:00.000Z",
          updated: "2026-05-20T00:00:00.000Z",
        },
      ];

      const plan = await planActiveTaskHygiene(tasks, {
        olderThanMinutes: 1,
        checkPrLiveBlocker: false, // explicitly disabled
      });

      // Should NOT have called the GitHub helper
      expect(fetchLivePrBlockerStatusMock).not.toHaveBeenCalled();
      // No actions since task is not stale (not older than 1 minute)
      expect(plan.actions).toHaveLength(0);
    });

    it("hygiene records red_ci from GitHub API and does not abandon the task", async () => {
      const { planActiveTaskHygiene } = await import("../services/task-ledger-facts.js");

      fetchLivePrBlockerStatusMock.mockResolvedValueOnce("red_ci");

      const tasks: ActiveTaskEntry[] = [
        {
          label: "markus-lassfolk/openclaw-hybrid-memory#1550",
          description: "Drive PR #1550",
          status: "In progress",
          started: "2026-05-20T00:00:00.000Z",
          updated: "2026-05-20T00:00:00.000Z",
        },
      ];

      const plan = await planActiveTaskHygiene(tasks, {
        olderThanMinutes: 1,
        checkPrLiveBlocker: true,
      });

      const action = plan.actions.find((a) => a.label === tasks[0].label);
      expect(action?.kind).toBe("pr-live-blocker");
      expect(action?.toStatus).toBe("stage-4-feedback");
    });

    it("hygiene records no_live_blocker — no action taken", async () => {
      const { planActiveTaskHygiene } = await import("../services/task-ledger-facts.js");

      fetchLivePrBlockerStatusMock.mockResolvedValueOnce("no_live_blocker");

      const tasks: ActiveTaskEntry[] = [
        {
          label: "markus-lassfolk/openclaw-hybrid-memory#1551",
          description: "Drive PR #1551",
          status: "Waiting",
          started: "2026-05-20T00:00:00.000Z",
          updated: "2026-05-20T00:00:00.000Z",
        },
      ];

      const plan = await planActiveTaskHygiene(tasks, {
        olderThanMinutes: 1,
        checkPrLiveBlocker: true,
      });

      // No action: hygiene should NOT mark this task abandoned when live state is clean
      const action = plan.actions.find((a) => a.label === tasks[0].label);
      expect(action).toBeUndefined();
    });
  });
});
