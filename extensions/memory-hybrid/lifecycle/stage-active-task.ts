/**
 * Lifecycle: active-task injection (Phase 2.3).
 * Registers before_agent_start to inject ACTIVE-TASKS.md summary when enabled.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { buildActiveTaskInjection, buildStaleWarningInjection, readActiveTaskFile } from "../services/active-task.js";
import { capturePluginError } from "../services/error-reporter.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import { readActiveTaskRowsFromFacts } from "../services/task-ledger-facts.js";
import { buildHeartbeatTaskHygieneBlock } from "../services/task-hygiene.js";
import { parseDuration } from "../utils/duration.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
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
      let activeForInjection: import("../services/active-task.js").ActiveTaskEntry[] = [];

      if (ctx.cfg.activeTask.ledger === "facts") {
        const { active } = readActiveTaskRowsFromFacts(ctx.factsDb, staleMinutes);
        activeForInjection = active;
      } else {
        const taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
        if (!taskFile || taskFile.active.length === 0) return undefined;
        activeForInjection = taskFile.active;
      }

      if (activeForInjection.length === 0) return undefined;

      const injection = buildActiveTaskInjection(activeForInjection, ctx.cfg.activeTask.injectionBudget);
      let staleWarningBlock = "";
      if (ctx.cfg.activeTask.staleWarning.enabled) {
        const injectionChars = injection.length;
        const budgetChars = ctx.cfg.activeTask.injectionBudget * 4;
        const remainingChars = Math.max(0, budgetChars - injectionChars);
        staleWarningBlock = buildStaleWarningInjection(activeForInjection, staleMinutes, remainingChars);
      }

      const th = ctx.cfg.activeTask.taskHygiene;
      let hygieneBlock = "";
      const userText = extractLastUserMessageText(event);
      if (
        th.heartbeatEscalation &&
        userText &&
        matchesHeartbeat(userText, ctx.cfg.goalStewardship) &&
        activeForInjection.length > 0
      ) {
        hygieneBlock = buildHeartbeatTaskHygieneBlock(activeForInjection, {
          maxChars: th.heartbeatNudgeMaxChars,
          suggestGoalAfterTaskAgeDays: th.suggestGoalAfterTaskAgeDays,
        });
        api.logger?.info?.("memory-hybrid: task hygiene block appended (heartbeat match)");
      }

      const parts = [injection, staleWarningBlock, hygieneBlock].filter(Boolean);
      if (parts.length === 0) return undefined;

      const context = parts.join("\n\n");
      const staleCount = activeForInjection.filter((t) => t.stale).length;
      const src = ctx.cfg.activeTask.ledger === "facts" ? "category:project facts" : "ACTIVE-TASKS.md";
      api.logger?.info?.(
        `memory-hybrid: injecting ${activeForInjection.length} active task(s) from ${src}${staleCount > 0 ? ` (${staleCount} stale)` : ""}`,
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
