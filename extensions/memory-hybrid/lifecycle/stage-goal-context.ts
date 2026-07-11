/**
 * Inject compact active-goals summary on every turn (when enabled).
 * Heartbeat turns rely on full stewardship bundle from stage-goal-stewardship.ts.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { isSubagentSession } from "../services/active-task.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  buildCompactActiveGoalsPrepend,
  buildLightweightStewardshipDirective,
  buildSubagentLinkedGoalsPrepend,
  resolveGoalsForSubagentContext,
} from "../services/goal-context-injection.js";
import { isGoalStewardshipInjectionEnabled, listActiveGoals } from "../services/goal-stewardship.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import type { LifecycleContext } from "./types.js";

export function registerGoalContextInjection(api: ClawdbotPluginApi, ctx: LifecycleContext, goalsDir: string): void {
  const gs = ctx.cfg.goalStewardship;
  if (!gs.injectActiveGoalsEveryTurn || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(
      ctx.beforeAgentStartTurnRef,
      "goal-context",
      api.logger,
      async () => {
        try {
          const injectionEnabled = await isGoalStewardshipInjectionEnabled(ctx.cfg, goalsDir);
          if (!injectionEnabled) return undefined;

          const userText = extractLastUserMessageText(event);
          if (userText && matchesHeartbeat(userText, gs)) {
            return undefined;
          }

          const resolvedApi = withHookResolutionApi(api, hookCtx);
          const sessionKey = resolveSessionKeyFromHookEvent(event, resolvedApi);
          const subagent = isSubagentSession(sessionKey ?? undefined);

          let built: string | null;
          if (subagent && sessionKey) {
            const scopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
            const linkedGoals = await resolveGoalsForSubagentContext(
              sessionKey,
              goalsDir,
              ctx.factsDb,
              ctx.cfg,
              scopeFilter,
            );
            if (linkedGoals.length === 0) return undefined;
            built = buildSubagentLinkedGoalsPrepend(linkedGoals, { maxChars: gs.everyTurnGoalMaxChars });
          } else {
            const goals = await listActiveGoals(goalsDir);
            built = buildCompactActiveGoalsPrepend(goals, {
              maxChars: gs.everyTurnGoalMaxChars,
              maxGoals: gs.everyTurnGoalMaxGoals,
            });
            if (!built) built = "";
            const directive = buildLightweightStewardshipDirective(goals);
            if (directive) built = `${built}${directive}`;
          }

          if (!built?.trim()) return undefined;

          const prepend = applyPrependBudget(ctx.prependBudgetRef, built);
          if (!prepend?.trim()) return undefined;

          api.logger?.debug?.(
            `memory-hybrid: active-goals summary injected (${subagent ? "subagent-linked" : "main"}, cap=${gs.everyTurnGoalMaxChars} chars)`,
          );
          return { prependContext: prepend };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "goal-context-injection",
            subsystem: "goal-stewardship",
          });
          api.logger?.warn?.(`memory-hybrid: goal context injection failed: ${String(err)}`);
          return undefined;
        }
      },
      { timeoutMs: 4000 },
    ),
  );
}
