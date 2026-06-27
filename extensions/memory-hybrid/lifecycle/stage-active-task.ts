/**
 * Lifecycle: active-task injection (Phase 2.3).
 * Registers before_agent_start to inject ACTIVE-TASKS.md summary when enabled.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  detectStaleTasks,
  isSubagentSession,
  readActiveTaskFile,
  upsertTask,
  writeActiveTaskFileGuarded,
} from "../services/active-task.js";
import { buildActiveTaskContextBundle } from "../services/active-task-injection.js";
import { capturePluginError } from "../services/error-reporter.js";
import { listGoals, resolveGoalsDir } from "../services/goal-registry.js";
import { matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";
import {
  buildGoalEscalationHeartbeatBlock,
  buildLongRunningTaskDraft,
  buildLongRunningTaskRegistrationBlock,
  detectLongRunningWorkflowProposal,
  shouldAutoRegisterLongRunningTask,
} from "../services/task-hygiene.js";
import { loadTaskLedgerFromFactsWithMetrics, syncActiveTaskEntryToFacts, flushActiveTaskCoherenceRepairs } from "../services/task-ledger-facts.js";
import { recordStartupMemoryCheckpoint } from "../services/startup-memory-attribution.js";
import { applyPrependBudget, capBudgetToPrependRemaining } from "../services/prepend-budget.js";
import { runOptionalBeforeAgentStartStage } from "../services/before-agent-start-budget.js";
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
  let firstActiveTaskProjectionCaptured = false;

  api.on("before_agent_start", async (event: unknown, hookCtx: unknown) =>
    runOptionalBeforeAgentStartStage(
      ctx.beforeAgentStartTurnRef,
      "active-task-injection",
      api.logger,
      async () => {
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
      const isSubagent = isSubagentSession(sessionKey ?? undefined);
      let factsSelectionMetrics: import("../services/task-ledger-facts.js").ActiveTaskLedgerSelectionMetrics | null =
        null;
      let factsSelectionStartMs: number | null = null;
      let staleSkippedFromFacts = 0;

      if (ctx.cfg.activeTask.ledger === "facts") {
        const coherence = await flushActiveTaskCoherenceRepairs(ctx.factsDb, ctx.vectorDb, ctx.embeddings, {
          maxRepairs: 3,
          log: api.logger,
        });
        if (coherence.repaired > 0) {
          api.logger?.info?.(
            `memory-hybrid: persisted ${coherence.repaired} incoherent active-task row(s) before injection`,
          );
        }
        factsSelectionStartMs = Date.now();
        const { active, metrics } = loadTaskLedgerFromFactsWithMetrics(ctx.factsDb);
        activeForInjection = detectStaleTasks(active, staleMinutes);
        factsSelectionMetrics = metrics;
        staleSkippedFromFacts = activeForInjection.filter((task) => task.stale).length;
      } else {
        const taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
        activeForInjection = taskFile?.active ?? [];
        completedForWrite = taskFile?.completed ?? [];
      }

      const logFactsSelection = (injectedCount: number): void => {
        if (!factsSelectionMetrics || factsSelectionStartMs === null) return;
        api.logger?.debug?.(
          `memory-hybrid: active-task selection rowsFetched=${factsSelectionMetrics.projectRowsFetched} groupedEntities=${factsSelectionMetrics.groupedEntityCount} duplicatesCollapsed=${factsSelectionMetrics.duplicateRowsCollapsed} activeCandidates=${factsSelectionMetrics.activeCandidates} staleSkipped=${staleSkippedFromFacts} injected=${injectedCount} elapsedMs=${Date.now() - factsSelectionStartMs}`,
        );
      };
      const logStartupProjectionCheckpoint = (phase: string, injectedCount: number): void => {
        if (firstActiveTaskProjectionCaptured) return;
        firstActiveTaskProjectionCaptured = true;
        recordStartupMemoryCheckpoint({
          logger: api.logger,
          subsystem: "active-task",
          operation: "first-projection",
          phase,
          onceKey: "startup.first-active-task-projection",
          tags: {
            ledger: ctx.cfg.activeTask.ledger,
            activeCandidates: activeForInjection.length,
            staleCandidates: staleSkippedFromFacts,
            injectedCount,
          },
        });
      };

      let longRunningBlock = "";
      if (proposal) {
        const draft = buildLongRunningTaskDraft(proposal);
        const alreadyActive = activeForInjection.some((t) => t.label.toLowerCase() === draft.label.toLowerCase());
        let autoCreated = false;

        if (!alreadyActive && shouldAutoRegisterLongRunningTask(longRunningMode, sessionKey)) {
          if (ctx.cfg.activeTask.ledger === "facts") {
            await syncActiveTaskEntryToFacts(ctx.factsDb, ctx.vectorDb, ctx.embeddings, draft, api.logger);
            activeForInjection = upsertTask(activeForInjection, draft, true);
            autoCreated = true;
          } else {
            const updated = upsertTask(activeForInjection, draft, true);
            const writeResult = await writeActiveTaskFileGuarded(
              resolvedActiveTaskPath,
              updated,
              completedForWrite,
              sessionKey ?? undefined,
            );
            if (writeResult.skipped) {
              api.logger?.debug?.(`memory-hybrid: skipped long-running task auto-registration: ${writeResult.reason}`);
            } else {
              activeForInjection = updated;
              autoCreated = true;
            }
          }
        }

        longRunningBlock = buildLongRunningTaskRegistrationBlock(proposal, draft, {
          mode: longRunningMode,
          autoCreated,
          alreadyActive,
          sessionKey,
        });
      }

      if (activeForInjection.length === 0 && !longRunningBlock) {
        logStartupProjectionCheckpoint("startup.first-active-task-projection.empty", 0);
        logFactsSelection(0);
        return undefined;
      }

      const th = ctx.cfg.activeTask.taskHygiene;
      const isHeartbeat =
        !isSubagent &&
        th.heartbeatEscalation &&
        ctx.cfg.goalStewardship.enabled &&
        !!userText &&
        matchesHeartbeat(userText, ctx.cfg.goalStewardship);

      let goalEscalationPrebuilt = "";
      if (
        isHeartbeat &&
        activeForInjection.length > 0 &&
        ctx.cfg.goalStewardship.escalationPolicy.taskHygieneOnBlockedGoals
      ) {
        const goalsDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
        const goals = await listGoals(goalsDir);
        goalEscalationPrebuilt = buildGoalEscalationHeartbeatBlock(goals, {
          maxChars: Math.min(1200, th.heartbeatNudgeMaxChars),
        });
      }

      const injectionBudgetTokens = capBudgetToPrependRemaining(
        ctx.prependBudgetRef,
        ctx.cfg.activeTask.injectionBudget,
      );
      if (injectionBudgetTokens <= 0) {
        logFactsSelection(0);
        return undefined;
      }

      const bundle = buildActiveTaskContextBundle({
        ledgerTasks: activeForInjection,
        injectionBudgetTokens,
        staleMinutes,
        staleWarningEnabled: ctx.cfg.activeTask.staleWarning.enabled,
        projection: ctx.cfg.activeTask.projection,
        injectionMaxTasks: ctx.cfg.activeTask.injectionMaxTasks,
        userText: userText ?? undefined,
        sessionKey: sessionKey ?? undefined,
        heartbeatHygiene:
          isHeartbeat && activeForInjection.length > 0
            ? {
                maxChars: th.heartbeatNudgeMaxChars,
                suggestGoalAfterTaskAgeDays: th.suggestGoalAfterTaskAgeDays,
              }
            : undefined,
        goalEscalationBlock: goalEscalationPrebuilt || undefined,
      });

      if (isHeartbeat && bundle.parts.some((p) => p.includes("<task-hygiene>"))) {
        api.logger?.info?.("memory-hybrid: task hygiene block appended (heartbeat match)");
      }

      logFactsSelection(bundle.injectedTaskCount);
      logStartupProjectionCheckpoint("startup.first-active-task-projection.after", bundle.injectedTaskCount);

      const parts = [...bundle.parts, longRunningBlock].filter(Boolean);
      if (parts.length === 0) return undefined;

      const prepend = applyPrependBudget(ctx.prependBudgetRef, `${parts.join("\n\n")}\n\n`);
      if (!prepend?.trim()) return undefined;
      const staleCount = activeForInjection.filter((t) => t.stale).length;
      const src = ctx.cfg.activeTask.ledger === "facts" ? "category:project facts" : "ACTIVE-TASKS.md";
      api.logger?.info?.(
        `memory-hybrid: active-task injection from ${src}: ledger=${bundle.ledgerActiveCount} filtered=${bundle.filteredActiveCount} injected=${bundle.injectedTaskCount} (~${bundle.injectedTokens} tok)${staleCount > 0 ? ` (${staleCount} stale in ledger)` : ""}`,
      );
      return { prependContext: prepend };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-injection",
        subsystem: "active-task",
      });
      api.logger?.warn?.(`memory-hybrid: active task injection failed: ${err}`);
    }
  },
      { timeoutMs: 4000 },
    ),
  );
}
