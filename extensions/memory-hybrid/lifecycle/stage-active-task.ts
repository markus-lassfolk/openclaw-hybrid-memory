/**
 * Lifecycle: active-task injection (Phase 2.3).
 * Registers before_agent_start to inject ACTIVE-TASK.md summary when enabled.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import { parseDuration } from "../utils/duration.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import { buildHeartbeatTaskHygieneBlock } from "../services/task-hygiene.js";
import { readActiveTaskFile, buildActiveTaskInjection, buildStaleWarningInjection } from "../services/active-task.js";
import type { LifecycleContext } from "./types.js";

export function registerActiveTaskInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  resolvedActiveTaskPath: string,
): void {
  if (!ctx.cfg.activeTask.enabled || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown) => {
    try {
      const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
      const taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
      if (!taskFile || taskFile.active.length === 0) return undefined;

      const injection = buildActiveTaskInjection(taskFile.active, ctx.cfg.activeTask.injectionBudget);
      let staleWarningBlock = "";
      if (ctx.cfg.activeTask.staleWarning.enabled) {
        const injectionChars = injection.length;
        const budgetChars = ctx.cfg.activeTask.injectionBudget * 4;
        const remainingChars = Math.max(0, budgetChars - injectionChars);
        staleWarningBlock = buildStaleWarningInjection(taskFile.active, staleMinutes, remainingChars);
      }

      const th = ctx.cfg.activeTask.taskHygiene;
      let hygieneBlock = "";
      const userText = extractLastUserMessageText(event);
      if (
        th.heartbeatEscalation &&
        ctx.cfg.goalStewardship.enabled &&
        userText &&
        matchesHeartbeat(userText, ctx.cfg.goalStewardship) &&
        taskFile.active.length > 0
      ) {
        hygieneBlock = buildHeartbeatTaskHygieneBlock(taskFile.active, {
          maxChars: th.heartbeatNudgeMaxChars,
          suggestGoalAfterTaskAgeDays: th.suggestGoalAfterTaskAgeDays,
        });
        api.logger?.info?.("memory-hybrid: task hygiene block appended (heartbeat match)");
      }

      const parts = [injection, staleWarningBlock, hygieneBlock].filter(Boolean);
      if (parts.length === 0) return undefined;

      const context = parts.join("\n\n");
      const staleCount = taskFile.active.filter((t) => t.stale).length;
      api.logger?.info?.(
        `memory-hybrid: injecting ${taskFile.active.length} active task(s) from ACTIVE-TASK.md${staleCount > 0 ? ` (${staleCount} stale)` : ""}`,
      );
      return { prependContext: `${context}\n\n` };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-injection",
        subsystem: "active-task",
      });
      api.logger?.warn?.(`memory-hybrid: active task injection failed: ${err}`);
    }
  });
}
