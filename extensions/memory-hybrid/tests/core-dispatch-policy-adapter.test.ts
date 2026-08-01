import { describe, expect, it } from "vitest";
import {
  CORE_DISPATCH_AUTHORIZATION_ABI_VERSION,
  type CoreDispatchContext,
} from "../contracts/core-dispatch-authorization.js";
import {
  HybridMemoryGoalDispatchPolicyAdapter,
  requestedBudgetForCore,
} from "../services/core-dispatch-policy-adapter.js";
import type { GoalDispatchPolicy } from "../services/goal-dispatch-authorization.js";

const policy: GoalDispatchPolicy = {
  version: 1,
  classes: {
    write: {
      allowedAgents: ["forge"],
      readOnly: false,
      canonical: { prNumber: 2232, branch: "fix/goal-dispatch-authorization", remoteHead: "head" },
      writeScope: ["extensions/memory-hybrid"],
      forbidNewPr: true,
      forbidNewBranch: true,
    },
  },
};
const context = (overrides: Partial<CoreDispatchContext> = {}): CoreDispatchContext => ({
  abiVersion: CORE_DISPATCH_AUTHORIZATION_ABI_VERSION,
  traceId: "trace-1",
  origin: "sessions_spawn_acp",
  requester: { sessionId: "parent" },
  parentRunId: "run-parent",
  parentSessionId: "parent",
  target: { agentId: "forge", runtime: "acp" },
  goalId: "goal-1",
  requestedBudget: { maxTotalTokens: 1_000, maxDispatchTokens: 250, maxWallTimeMs: 30_000, maxDispatches: 1 },
  attributes: {
    goal_dispatch: {
      taskClass: "write",
      requestedAgent: "forge",
      prNumber: 2232,
      branch: "fix/goal-dispatch-authorization",
      liveRemoteHead: "head",
      writeScope: ["extensions/memory-hybrid"],
      createsPr: false,
      createsBranch: false,
      readOnly: false,
    },
  },
  ...overrides,
});

describe("HybridMemoryGoalDispatchPolicyAdapter", () => {
  it("returns abstain without a goal so core default behavior stays backward compatible", async () => {
    const adapter = new HybridMemoryGoalDispatchPolicyAdapter(async () => policy);
    await expect(adapter.authorize(context({ goalId: undefined }))).resolves.toMatchObject({ kind: "abstain" });
  });
  it("denies before child allocation when policy or host-bound agent authorization fails", async () => {
    const adapter = new HybridMemoryGoalDispatchPolicyAdapter(async () => policy);
    await expect(adapter.authorize(context({ target: { agentId: "scholar", runtime: "acp" } }))).resolves.toMatchObject(
      { kind: "deny" },
    );
    await expect(
      new HybridMemoryGoalDispatchPolicyAdapter(async () => undefined).authorize(context()),
    ).resolves.toMatchObject({ kind: "deny" });
  });
  it("returns a short-lived opaque grant and preserves core-owned budget dimensions", async () => {
    const adapter = new HybridMemoryGoalDispatchPolicyAdapter(
      async () => policy,
      () => new Date("2026-08-01T00:00:00.000Z"),
      () => "opaque-grant",
    );
    await expect(adapter.authorize(context())).resolves.toEqual({
      kind: "allow",
      grant: {
        id: "opaque-grant",
        expiresAt: "2026-08-01T00:05:00.000Z",
        budget: context().requestedBudget,
        policyRef: "goal:goal-1:v1",
      },
    });
    expect(requestedBudgetForCore(context())).toEqual(context().requestedBudget);
  });
  it.each(["sessions_spawn_native", "sessions_spawn_acp", "cron_agent_turn", "gateway_direct"] as const)(
    "accepts the immutable core ABI context for %s",
    async (origin) => {
      const adapter = new HybridMemoryGoalDispatchPolicyAdapter(
        async () => policy,
        () => new Date(),
        () => "grant",
      );
      await expect(adapter.authorize(context({ origin }))).resolves.toMatchObject({ kind: "allow" });
    },
  );
});
