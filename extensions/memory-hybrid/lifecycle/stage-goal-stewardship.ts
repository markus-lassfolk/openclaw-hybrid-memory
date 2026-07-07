import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Goal stewardship injection on heartbeat (before_agent_start).
 */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HybridMemoryConfig } from "../config.js";
import { isSubagentSession } from "../services/active-task.js";
import { buildCompactActiveGoalsPrepend, buildSubagentLinkedGoalsPrepend, resolveGoalsForSubagentContext } from "../services/goal-context-injection.js";
import { refreshActiveTaskMirrorWithGoals } from "../services/goal-active-task-mirror.js";
import {
  buildMultiGoalStewardshipPrepend,
  heuristicNeedsHeavyAttention,
  matchesHeartbeat,
} from "../services/goal-stewardship-heartbeat.js";
import { llmTriageNeedsHeavy } from "../services/goal-stewardship-llm-triage.js";
import { isGlobalRateLimited, isGoalStewardshipInjectionEnabled, listActiveGoals, resolveGoalsDir } from "../services/goal-stewardship.js";
import { renderActiveTaskMarkdownFile } from "../services/task-ledger-facts.js";
import { parseDuration } from "../utils/duration.js";
import { getEnv } from "../utils/env-manager.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import { applyPrependBudget } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import type { LifecycleContext } from "./types.js";

export function registerGoalStewardshipInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  goalsDir: string,
  resolvedActiveTaskPath: string | undefined,
): void {
  const gs = ctx.cfg.goalStewardship;
  if (!gs.heartbeatStewardship || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(
      ctx.beforeAgentStartTurnRef,
      "goal-stewardship",
      api.logger,
      async () => {
    try {
      const injectionEnabled = await isGoalStewardshipInjectionEnabled(ctx.cfg, goalsDir);
      if (!injectionEnabled) return undefined;

      const userText = extractLastUserMessageText(event);
      if (!userText) {
        api.logger?.debug?.(
          "memory-hybrid: goal stewardship skipped — no user text in hook event (expected event.prompt or messages)",
        );
        return undefined;
      }
      if (!matchesHeartbeat(userText, gs)) return undefined;
      const resolvedApi = withHookResolutionApi(api, hookCtx);
      const sessionKey = resolveSessionKeyFromHookEvent(event, resolvedApi);
      const subagent = isSubagentSession(sessionKey ?? undefined);
      if (subagent && sessionKey) {
        const scopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
        const linkedGoals = await resolveGoalsForSubagentContext(sessionKey, goalsDir, ctx.factsDb, ctx.cfg, scopeFilter);
        if (linkedGoals.length === 0) {
          api.logger?.info?.("memory-hybrid: goal stewardship skipped — subagent session without linked goals");
          return undefined;
        }
        const compact = buildSubagentLinkedGoalsPrepend(linkedGoals, { maxChars: gs.everyTurnGoalMaxChars });
        if (!compact?.trim()) return undefined;
        const prepend = applyPrependBudget(ctx.prependBudgetRef, compact);
        if (!prepend) return undefined;
        api.logger?.info?.(`memory-hybrid: subagent goal context injected (${linkedGoals.length} linked goal(s))`);
        return { prependContext: prepend };
      }

      const goals = await listActiveGoals(goalsDir);

      if (
        gs.heartbeatRefreshActiveTask &&
        ctx.cfg.activeTask.enabled &&
        resolvedActiveTaskPath &&
        ctx.cfg.verbosity !== "silent"
      ) {
        const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
        if (ctx.cfg.activeTask.ledger === "facts") {
          await renderActiveTaskMarkdownFile(
            ctx.factsDb,
            staleMinutes,
            resolvedActiveTaskPath,
            ctx.cfg.activeTask.projection,
            api.logger,
            { goals },
          );
        } else {
          await refreshActiveTaskMirrorWithGoals({
            activeTaskPath: resolvedActiveTaskPath,
            goals,
            staleMinutes,
            logger: api.logger,
          });
        }
      }

      if (goals.length === 0) {
        api.logger?.info?.("memory-hybrid: goal stewardship skipped — no active goals");
        return undefined;
      }

      if (isGlobalRateLimited(gs.globalLimits.maxDispatchesPerHour, goalsDir)) {
        api.logger?.warn?.("memory-hybrid: goal stewardship skipped — global dispatch rate limit");
        const compact = buildCompactActiveGoalsPrepend(goals, {
          maxChars: gs.everyTurnGoalMaxChars,
          maxGoals: gs.everyTurnGoalMaxGoals,
        });
        const rateBlock =
          "<goal-stewardship>Global goal dispatch rate limit reached this hour. Assess without spawning if possible.</goal-stewardship>";
        const combined = [rateBlock, compact ?? ""].filter(Boolean).join("\n\n");
        const prepend = applyPrependBudget(ctx.prependBudgetRef, `${combined}\n\n`);
        if (!prepend) return undefined;
        return { prependContext: prepend };
      }

      let triageHeavy = heuristicNeedsHeavyAttention(goals);
      if (gs.llmTriageOnHeartbeat && ctx.openai) {
        const summary = goals
          .map((g) => `${g.label} [${g.priority}]: ${g.status} blockers=${g.currentBlockers.length}`)
          .join("\n");
        const llmH = await llmTriageNeedsHeavy(ctx.openai, ctx.cfg, summary);
        if (llmH !== null) triageHeavy = llmH;
      }

      const built = await buildMultiGoalStewardshipPrepend(goalsDir, gs, goals, {
        suggestHeavyDirective: gs.triageSuggestHeavyDirective,
        triageHeavy,
      });
      if (!built) {
        api.logger?.info?.("memory-hybrid: goal stewardship skipped — no candidate goals past cooldown/budget filters");
        const compactFallback = buildCompactActiveGoalsPrepend(goals, {
          maxChars: gs.everyTurnGoalMaxChars,
          maxGoals: gs.everyTurnGoalMaxGoals,
        });
        if (!compactFallback) return undefined;
        const prepend = applyPrependBudget(ctx.prependBudgetRef, compactFallback);
        if (!prepend) return undefined;
        api.logger?.debug?.("memory-hybrid: heartbeat goal fallback — compact active-goals summary");
        return { prependContext: prepend };
      }

      api.logger?.info?.(
        `memory-hybrid: goal stewardship bundle (${built.goalsIncluded.length} goal(s), heavyHint=${built.suggestHeavy})`,
      );
      const prepend = applyPrependBudget(ctx.prependBudgetRef, built.prepend);
      if (!prepend) return undefined;
      return { prependContext: prepend };
    } catch (err) {
      api.logger?.warn?.(`memory-hybrid: goal stewardship injection error: ${String(err)}`);
      return undefined;
    }
  },
      { timeoutMs: 5000 },
    ),
  );
}

export function resolvedGoalsDirForLifecycle(cfg: HybridMemoryConfig): string {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  return resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
}
