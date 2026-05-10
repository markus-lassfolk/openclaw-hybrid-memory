/**
 * Lifecycle: active-task injection (Phase 2.3).
 * Registers before_agent_start to inject ACTIVE-TASKS.md summary when enabled.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  buildActiveTaskInjection,
  buildStaleWarningInjection,
  readActiveTaskFile,
  upsertTask,
  writeActiveTaskFileGuarded,
} from "../services/active-task.js";
import { capturePluginError } from "../services/error-reporter.js";
import { listGoals, resolveGoalsDir } from "../services/goal-registry.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import {
  buildGoalEscalationHeartbeatBlock,
  buildHeartbeatTaskHygieneBlock,
  buildLongRunningTaskDraft,
  buildLongRunningTaskRegistrationBlock,
  detectLongRunningWorkflowProposal,
  shouldAutoRegisterLongRunningTask,
} from "../services/task-hygiene.js";
import { readActiveTaskRowsFromFacts, syncActiveTaskEntryToFacts } from "../services/task-ledger-facts.js";
import { parseDuration } from "../utils/duration.js";
import { extractLastUserMessageText } from "../utils/extract-last-user-message.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";
import type { LifecycleContext } from "./types.js";

export function registerActiveTaskInjection(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  resolvedActiveTaskPath: string,
  workspaceRoot: string,
): void {
  if (!ctx.cfg.activeTask.enabled || ctx.cfg.verbosity === "silent") return;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
    try {
      const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
      let activeForInjection: import("../services/active-task.js").ActiveTaskEntry[] = [];
      let completedForWrite: import("../services/active-task.js").ActiveTaskEntry[] = [];
      const userText = extractLastUserMessageText(event);
      const longRunningMode = ctx.cfg.activeTask.taskHygiene.longRunningRegistration?.mode ?? "suggest";
      const proposal =
        userText && longRunningMode !== "off" ? detectLongRunningWorkflowProposal(userText, workspaceRoot) : null;
      const resolvedApi = withHookResolutionApi(api, hookCtx);
      const sessionKey = resolveSessionKeyFromHookEvent(event, resolvedApi);

      if (ctx.cfg.activeTask.ledger === "facts") {
        const { active } = readActiveTaskRowsFromFacts(ctx.factsDb, staleMinutes);
        activeForInjection = active;
      } else {
        const taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
        activeForInjection = taskFile?.active ?? [];
        completedForWrite = taskFile?.completed ?? [];
      }

      let longRunningBlock = "";
      if (proposal) {
        const draft = buildLongRunningTaskDraft(proposal);
        const alreadyActive = activeForInjection.some((t) => t.label === draft.label);
        let autoCreated = false;

        if (!alreadyActive && shouldAutoRegisterLongRunningTask(longRunningMode, sessionKey)) {
          if (ctx.cfg.activeTask.ledger === "facts") {
            await syncActiveTaskEntryToFacts(ctx.factsDb, ctx.vectorDb, ctx.embeddings, draft, api.logger);
          } else {
            const updated = upsertTask(activeForInjection, draft, true);
            const writeResult = await writeActiveTaskFileGuarded(
              resolvedActiveTaskPath,
              updated,
              completedForWrite,
              sessionKey ?? undefined,
            );
            if (writeResult.skipped) {
              api.logger.debug?.(`memory-hybrid: skipped long-running task auto-registration: ${writeResult.reason}`);
            } else {
              activeForInjection = updated;
              autoCreated = true;
            }
          }
          if (ctx.cfg.activeTask.ledger === "facts") {
            activeForInjection = upsertTask(activeForInjection, draft, true);
            autoCreated = true;
          }
        }

        longRunningBlock = buildLongRunningTaskRegistrationBlock(proposal, draft, {
          mode: longRunningMode,
          autoCreated,
          alreadyActive,
          sessionKey,
        });
      }

      if (activeForInjection.length === 0 && !longRunningBlock) return undefined;

      const injection =
        activeForInjection.length > 0 ? buildActiveTaskInjection(activeForInjection, ctx.cfg.activeTask.injectionBudget) : "";
      let staleWarningBlock = "";
      if (ctx.cfg.activeTask.staleWarning.enabled && activeForInjection.length > 0) {
        const injectionChars = injection.length;
        const budgetChars = ctx.cfg.activeTask.injectionBudget * 4;
        const remainingChars = Math.max(0, budgetChars - injectionChars);
        staleWarningBlock = buildStaleWarningInjection(activeForInjection, staleMinutes, remainingChars);
      }

      const th = ctx.cfg.activeTask.taskHygiene;
      let hygieneBlock = "";
      let goalEscalationBlock = "";
      if (
        th.heartbeatEscalation &&
        ctx.cfg.goalStewardship.enabled &&
        userText &&
        matchesHeartbeat(userText, ctx.cfg.goalStewardship) &&
        activeForInjection.length > 0
      ) {
        hygieneBlock = buildHeartbeatTaskHygieneBlock(activeForInjection, {
          maxChars: th.heartbeatNudgeMaxChars,
          suggestGoalAfterTaskAgeDays: th.suggestGoalAfterTaskAgeDays,
        });
        if (ctx.cfg.goalStewardship.enabled && ctx.cfg.goalStewardship.escalationPolicy.taskHygieneOnBlockedGoals) {
          const goalsDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
          const goals = await listGoals(goalsDir);
          goalEscalationBlock = buildGoalEscalationHeartbeatBlock(goals, {
            maxChars: Math.min(1200, th.heartbeatNudgeMaxChars),
          });
        }
        api.logger?.info?.("memory-hybrid: task hygiene block appended (heartbeat match)");
      }

      const parts = [injection, staleWarningBlock, longRunningBlock, hygieneBlock, goalEscalationBlock].filter(Boolean);
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
