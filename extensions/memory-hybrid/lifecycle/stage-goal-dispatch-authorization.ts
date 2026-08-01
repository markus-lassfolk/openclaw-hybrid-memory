/** Hard gate for goal-linked subagent spawn calls. */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { readGoal } from "../services/goal-registry.js";
import {
  dispatchRequestFromToolParams,
  evaluateGoalDispatch,
  recordGoalDispatchPreflight,
} from "../services/goal-dispatch-authorization.js";
import type { LifecycleContext } from "./types.js";

export function registerGoalDispatchAuthorization(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  goalsDir: string,
): void {
  if (!ctx.cfg.goalStewardship.dispatchAuthorization.enabled) return;
  api.on("before_tool_call", async (event: unknown) => {
    const e = event as { toolName?: string; params?: Record<string, unknown> };
    if (e.toolName !== "sessions_spawn") return undefined;
    const { goalId, request } = dispatchRequestFromToolParams(e.params ?? {});
    const denied = async (reason: string) => {
      const result = {
        allowed: false,
        reason,
        at: new Date().toISOString(),
        request: request ?? { taskClass: "implementation", requestedAgent: "", actualAgent: "" },
      };
      if (goalId) await recordGoalDispatchPreflight(goalsDir, goalId, result);
      return { block: true, blockReason: `Goal dispatch denied: ${reason}` };
    };
    if (!goalId || !request) return denied("explicit goal_dispatch declaration required");
    const goal = await readGoal(goalsDir, goalId);
    if (!goal) return denied("goal not found");
    const result = evaluateGoalDispatch(goal.dispatchPolicy, request);
    await recordGoalDispatchPreflight(goalsDir, goalId, result);
    return result.allowed ? undefined : { block: true, blockReason: `Goal dispatch denied: ${result.reason}` };
  });
}
