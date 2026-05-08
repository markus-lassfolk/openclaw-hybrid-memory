import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Goal stewardship injection on heartbeat (before_agent_start).
 */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HybridMemoryConfig } from "../config.js";
import { refreshActiveTaskMirrorWithGoals } from "../services/goal-active-task-mirror.js";
import {
  buildMultiGoalStewardshipPrepend,
  heuristicNeedsHeavyAttention,
  matchesHeartbeat,
} from "../services/goal-stewardship-heartbeat.js";
import { llmTriageNeedsHeavy } from "../services/goal-stewardship-llm-triage.js";
import { isGlobalRateLimited, listActiveGoals, resolveGoalsDir } from "../services/goal-stewardship.js";
import { parseDuration } from "../utils/duration.js";
import { getEnv } from "../utils/env-manager.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import type { LifecycleContext } from "./types.js";

export function registerGoalStewardshipInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  goalsDir: string,
  resolvedActiveTaskPath: string | undefined,
): void {
  const gs = ctx.cfg.goalStewardship;
  if (!gs.enabled || !gs.heartbeatStewardship) return;

  api.on("before_agent_start", async (event: unknown) => {
    try {
      const userText = extractLastUserMessageText(event);
      if (!userText || !matchesHeartbeat(userText, gs)) return undefined;

      const goals = await listActiveGoals(goalsDir);
      if (goals.length === 0) return undefined;

      if (isGlobalRateLimited(gs.globalLimits.maxDispatchesPerHour)) {
        api.logger?.warn?.("memory-hybrid: goal stewardship skipped — global dispatch rate limit");
        return {
          prependContext:
            "<goal-stewardship>Global goal dispatch rate limit reached this hour. Assess without spawning if possible.</goal-stewardship>\n\n",
        };
      }

      if (
        gs.heartbeatRefreshActiveTask &&
        ctx.cfg.activeTask.enabled &&
        resolvedActiveTaskPath &&
        ctx.cfg.verbosity !== "silent"
      ) {
        const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
        await refreshActiveTaskMirrorWithGoals({
          activeTaskPath: resolvedActiveTaskPath,
          goals,
          staleMinutes,
          logger: api.logger,
        });
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
      if (!built) return undefined;

      api.logger?.info?.(
        `memory-hybrid: goal stewardship bundle (${built.goalsIncluded.length} goal(s), heavyHint=${built.suggestHeavy})`,
      );
      return { prependContext: built.prepend };
    } catch (err) {
      api.logger?.warn?.(`memory-hybrid: goal stewardship injection error: ${String(err)}`);
      return undefined;
    }
  });
}

export function resolvedGoalsDirForLifecycle(cfg: HybridMemoryConfig): string {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  return resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
}
