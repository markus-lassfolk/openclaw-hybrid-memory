/**
 * Lifecycle: active-task injection (Phase 2.3).
 * Registers before_agent_start to inject ACTIVE-TASK.md summary when enabled.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { capturePluginError } from "../services/error-reporter.js";
import { parseDuration } from "../utils/duration.js";
import {
  readActiveTaskFile,
  buildActiveTaskInjection,
  buildStaleWarningInjection,
} from "../services/active-task.js";
import type { LifecycleContext } from "./types.js";

export function registerActiveTaskInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  resolvedActiveTaskPath: string,
): void {
  if (!ctx.cfg.activeTask.enabled || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async () => {
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

      if (!injection && !staleWarningBlock) return undefined;

      const context = [injection, staleWarningBlock].filter(Boolean).join("\n\n");
      const staleCount = taskFile.active.filter((t) => t.stale).length;
      api.logger.info?.(
        `memory-hybrid: injecting ${taskFile.active.length} active task(s) from ACTIVE-TASK.md` +
          (staleCount > 0 ? ` (${staleCount} stale)` : ""),
      );
      return { prependContext: context + "\n\n" };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-injection",
        subsystem: "active-task",
      });
      api.logger.warn(`memory-hybrid: active task injection failed: ${err}`);
    }
  });
}
