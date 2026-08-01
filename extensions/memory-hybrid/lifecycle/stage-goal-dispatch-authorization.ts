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
  if (ctx.cfg.goalStewardship.dispatchAuthorization.mode === "disabled") return;
  api.on("before_tool_call", async (event: unknown) => {
    const e = event as { toolName?: string; params?: Record<string, unknown> };
    if (e.toolName !== "sessions_spawn") return undefined;
    const { goalId, request } = dispatchRequestFromToolParams(e.params ?? {});
    // Authorization is opt-in and only applies to explicitly goal-linked work.
    if (!goalId) {
      await recordGoalDispatchPreflight(goalsDir, "unmanaged", {
        allowed: false,
        reason: "direct managed sessions_spawn has no broker provenance",
        at: new Date().toISOString(),
        request: { taskClass: "", requestedAgent: "", actualAgent: "" },
      });
      if (ctx.cfg.goalStewardship.dispatchAuthorization.mode === "audit") return undefined;
      return {
        block: true,
        blockReason:
          "Managed sessions_spawn must use goal_dispatch broker; direct calls have no trusted broker provenance.",
      };
    }
    const auditRequest = request ?? { taskClass: "", requestedAgent: "", actualAgent: "" };
    const denied = async (reason: string) => {
      await recordGoalDispatchPreflight(goalsDir, goalId, {
        allowed: false,
        reason,
        at: new Date().toISOString(),
        request: auditRequest,
      });
      if (ctx.cfg.goalStewardship.dispatchAuthorization.mode === "audit") return undefined;
      return { block: true, blockReason: `Goal dispatch denied: ${reason}` };
    };
    // A missing/malformed declaration cannot establish read-only intent. sessions_spawn is
    // otherwise capable of writes, so fail closed rather than inferring a safe class.
    if (!request) return denied("explicit goal_dispatch declaration with readOnly is required");
    // Even the compatible no-policy read-only path must bind the declared recipient
    // to the host-controlled agentId; otherwise a caller could audit one identity
    // while dispatching another.
    if (request.requestedAgent !== request.actualAgent)
      return denied("requested agent must exactly match the host agentId");
    const goal = await readGoal(goalsDir, goalId);
    if (!goal) return denied("goal not found");
    if (!goal.dispatchPolicy && request.readOnly === true) {
      const result = {
        allowed: true,
        reason: "explicit read-only goal dispatch without policy",
        at: new Date().toISOString(),
        request,
      };
      await recordGoalDispatchPreflight(goalsDir, goalId, result);
      return undefined;
    }
    const result = evaluateGoalDispatch(goal.dispatchPolicy, request);
    await recordGoalDispatchPreflight(goalsDir, goalId, result);
    if (result.allowed || ctx.cfg.goalStewardship.dispatchAuthorization.mode === "audit") return undefined;
    return { block: true, blockReason: `Goal dispatch denied: ${result.reason}` };
  });
}
