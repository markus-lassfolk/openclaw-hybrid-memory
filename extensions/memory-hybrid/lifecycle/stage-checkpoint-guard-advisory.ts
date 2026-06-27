/**
 * Inject pre-finalization guard advisory from the prior turn (fail-open follow-up).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import type { LifecycleContext, SessionState } from "./types.js";

export function registerCheckpointGuardAdvisoryInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): void {
  if (ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(ctx.beforeAgentStartTurnRef, "checkpoint-guard-advisory", api.logger, async () => {
    const resolvedApi = withHookResolutionApi(api, hookCtx);
    const sessionKey = resolveSessionKeyFromHookEvent(event, resolvedApi);
    if (!sessionKey) return undefined;

    const advisory = sessionState.pendingCheckpointGuardBySession.get(sessionKey);
    if (!advisory?.trim()) return undefined;

    sessionState.pendingCheckpointGuardBySession.delete(sessionKey);
    const block = `<checkpoint-guard-advisory priority="high">
${advisory.trim()}

REQUIRED before ending this turn: call active_task_checkpoint with status, next, relatedSession, and fresh task state. If the task is goal-backed (related_goal), also call goal_assess in this turn.
OpenClaw cannot block finalization from this hook — you must checkpoint explicitly or pending external work will be lost on resume.
</checkpoint-guard-advisory>

`;
    const prepend = applyPrependBudget(ctx.prependBudgetRef, block);
    if (!prepend) return undefined;
    api.logger?.warn?.(`memory-hybrid: injecting checkpoint guard advisory for session ${sessionKey}`);
    return { prependContext: prepend };
  }),
  );
}

/** Store advisory for next turn when guard detected missing checkpoint. */
export function queueCheckpointGuardAdvisory(
  sessionState: SessionState,
  sessionKey: string,
  message: string,
): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  sessionState.pendingCheckpointGuardBySession.set(sessionKey, trimmed);
}
