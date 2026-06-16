import { getEnv } from "../utils/env-manager.js";
/**
 * Lifecycle Hooks (Phase 2.3: staged pipeline).
 *
 * Dispatcher: registers before_agent_start, agent_end, and frustration handlers (subagent hooks: stage-cleanup).
 * All stage logic lives in stage-*.ts and session-state.ts; this file stays <200 lines.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { getCronModelConfig, getDefaultCronModel } from "../config/index.js";
import { isAbortOrTransientLlmError } from "../services/chat.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractUserWorkflowGoal, isSystemWorkflowGoal } from "../services/workflow-goal-classifier.js";
import { redactMaintenancePrivateText } from "../utils/maintenance-privacy.js";
import { currentTurnSlice, extractToolNamesFromMessages } from "../services/workflow-message-utils.js";
import { buildDailyNarrative } from "../src/worker/narratives.js";
import { recordStartupMemoryCheckpoint } from "../services/startup-memory-attribution.js";
import { nowIso } from "../utils/dates.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { createSessionState } from "./session-state.js";
import { registerActiveTaskInjection } from "./stage-active-task.js";
import { registerAuthFailureRecall } from "./stage-auth-failure.js";
import { runCaptureStage } from "./stage-capture.js";
import { createStaleSweepTimer, getDispose, registerCleanupHandlers } from "./stage-cleanup.js";
import { registerCredentialHint } from "./stage-credential-hint.js";
import { registerFrustrationHandlers } from "./stage-frustration.js";
import { registerChangeNotifyHandler } from "./stage-change-notify.js";
import { registerChangeRevertHandler } from "./stage-change-revert.js";
import { registerGoalStewardshipInjection, resolvedGoalsDirForLifecycle } from "./stage-goal-stewardship.js";
import { registerGoalSubagentHandlers } from "./stage-goal-subagent.js";
import { registerMemoryNudgeInjection } from "./stage-memory-nudge.js";
import { runInjectionStage } from "./stage-injection.js";
import { buildDegradedFtsHotRecallStage } from "./stage-recall/degraded-recall.js";
import { runRecallStage } from "./stage-recall.js";
import { runSetupStage } from "./stage-setup.js";
import { formatPreFinalizationGuardMessage, evaluatePreFinalizationGuard } from "../services/pre-finalization-guard.js";
import { TASK_LEDGER_CATEGORY } from "../services/task-ledger-facts.js";
import { isRecallContextSuperseded, suppressStaleLifecycleDbError } from "../utils/registration-superseded.js";
import type { LifecycleContext } from "./types.js";
import { isStaleLifecycleGeneration } from "../utils/lifecycle-generation.js";

export type { LifecycleContext } from "./types.js";

export function createLifecycleHooks(ctx: LifecycleContext) {
  const sessionState = createSessionState(ctx.progressiveIndexBySession, ctx.lastAutoRecallPromptBySession);
  const staleSweepTimer = createStaleSweepTimer(sessionState, ctx.injectedFactIdsBySession);
  let firstRecallCheckpointCaptured = false;

  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const resolvedActiveTaskPath = isAbsolute(ctx.cfg.activeTask.filePath)
    ? ctx.cfg.activeTask.filePath
    : join(workspaceRoot, ctx.cfg.activeTask.filePath);

  const onAgentStart = (api: ClawdbotPluginApi) => {
    // OpenClaw typed hooks: (event, PluginHookAgentContext). Second arg must be declared so
    // sessionKey/sessionId/agentId reach resolvers via withHookResolutionApi (#1005).
    api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
      const rApi = withHookResolutionApi(api, hookCtx);
      await runSetupStage(event, rApi, ctx, sessionState);
    });

    if (ctx.cfg.autoRecall.enabled) {
      api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
        const rApi = withHookResolutionApi(api, hookCtx);
        const shouldCaptureFirstRecall = !firstRecallCheckpointCaptured;
        const capturedFirstRecallBegin =
          shouldCaptureFirstRecall &&
          recordStartupMemoryCheckpoint({
            logger: api.logger,
            subsystem: "auto-recall",
            operation: "first-recall",
            phase: "startup.first-recall.begin",
            onceKey: "startup.first-recall.begin",
          }) !== null;
        if (capturedFirstRecallBegin) {
          firstRecallCheckpointCaptured = true;
        }
        try {
          const recallStageResult = await runRecallStage(event, rApi, ctx, sessionState);
          if (isStaleLifecycleGeneration(ctx)) {
            if (capturedFirstRecallBegin) {
              firstRecallCheckpointCaptured = false;
            }
            return undefined;
          }
          if (!recallStageResult) {
            api.logger.warn?.("memory-hybrid: recall stage returned no result — attempting FTS+HOT degraded fallback");
            const degraded = await buildDegradedFtsHotRecallStage(event, rApi, ctx, sessionState, "timeout");
            if (capturedFirstRecallBegin) {
              recordStartupMemoryCheckpoint({
                logger: api.logger,
                subsystem: "auto-recall",
                operation: "first-recall",
                phase: "startup.first-recall.after",
                onceKey: "startup.first-recall.after",
                tags: {
                  resultKind: degraded.kind,
                },
              });
            }
            return degraded.prependContext ? { prependContext: degraded.prependContext } : undefined;
          }
          if (recallStageResult.kind === "degraded") {
            if (capturedFirstRecallBegin) {
              recordStartupMemoryCheckpoint({
                logger: api.logger,
                subsystem: "auto-recall",
                operation: "first-recall",
                phase: "startup.first-recall.after",
                onceKey: "startup.first-recall.after",
                tags: {
                  resultKind: recallStageResult.kind,
                },
              });
            }
            return { prependContext: recallStageResult.prependContext };
          }
          if (recallStageResult.kind === "empty") {
            if (capturedFirstRecallBegin) {
              recordStartupMemoryCheckpoint({
                logger: api.logger,
                subsystem: "auto-recall",
                operation: "first-recall",
                phase: "startup.first-recall.after",
                onceKey: "startup.first-recall.after",
                tags: {
                  resultKind: recallStageResult.kind,
                },
              });
            }
            return recallStageResult.prependContext ? { prependContext: recallStageResult.prependContext } : undefined;
          }
          const inj = await runInjectionStage(recallStageResult.result, rApi, ctx, event);
          if (isStaleLifecycleGeneration(ctx)) {
            if (capturedFirstRecallBegin) {
              firstRecallCheckpointCaptured = false;
            }
            return undefined;
          }
          if (capturedFirstRecallBegin) {
            recordStartupMemoryCheckpoint({
              logger: api.logger,
              subsystem: "auto-recall",
              operation: "first-recall",
              phase: "startup.first-recall.after",
              onceKey: "startup.first-recall.after",
              tags: {
                resultKind: recallStageResult.kind,
              },
            });
          }
          return inj ?? undefined;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            isStaleLifecycleGeneration(ctx) &&
            /not open|connection is not open|database is not open/i.test(message)
          ) {
            api.logger.debug?.("memory-hybrid: recall skipped (stale lifecycle generation)");
            return undefined;
          }
          if (isRecallContextSuperseded(ctx)) {
            api.logger.debug?.("memory-hybrid: recall skipped (registration superseded during reload)");
            return undefined;
          }
          if (
            suppressStaleLifecycleDbError(
              ctx,
              err,
              api.logger,
              "memory-hybrid: recall skipped (database closed during reload)",
            )
          ) {
            return undefined;
          }
          if (capturedFirstRecallBegin) {
            recordStartupMemoryCheckpoint({
              logger: api.logger,
              subsystem: "auto-recall",
              operation: "first-recall",
              phase: "startup.first-recall.error",
              onceKey: "startup.first-recall.error",
              tags: {
                error: err instanceof Error ? err.name : "unknown",
              },
            });
          }
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "recall",
            subsystem: "auto-recall",
          });
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
        return undefined;
      });
    }

    // Register before active-task injection so credential hints prepend ahead of task blocks
    // when OpenClaw merges before_agent_start prependContext (left-to-right concat).
    if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoDetect && ctx.cfg.verbosity !== "silent") {
      registerCredentialHint(api, ctx);
    }

    const resolvedGoalsDir = resolvedGoalsDirForLifecycle(ctx.cfg);
    registerGoalStewardshipInjection(
      api,
      ctx,
      resolvedGoalsDir,
      ctx.cfg.activeTask.enabled ? resolvedActiveTaskPath : undefined,
    );

    registerActiveTaskInjection(api, ctx, resolvedActiveTaskPath, workspaceRoot);
    registerMemoryNudgeInjection(api, ctx);
    registerGoalSubagentHandlers(api, ctx, resolvedGoalsDir);
    registerCleanupHandlers(api, ctx, sessionState, resolvedActiveTaskPath, workspaceRoot);
    // Guard experimental/optional features at the registration point — avoids registering
    // event listeners whose bodies immediately return when disabled (#581).
    if (ctx.cfg.autoRecall.enabled && ctx.cfg.autoRecall.authFailure.enabled) {
      registerAuthFailureRecall(api, ctx, sessionState);
    }
  };

  const onFrustrationDetect = (api: ClawdbotPluginApi) => {
    registerFrustrationHandlers(api, ctx, sessionState);
  };

  const onChangeNotify = (api: ClawdbotPluginApi) => {
    registerChangeRevertHandler(api, ctx, sessionState);
    registerChangeNotifyHandler(api, ctx, sessionState);
  };

  const onAgentEnd = (api: ClawdbotPluginApi) => {
    // Same typed-hook shape as before_agent_start (#1005).
    api.on("agent_end", async (event: unknown, hookCtx: unknown) => {
      const rApi = withHookResolutionApi(api, hookCtx);
      const ev = event as { messages?: unknown[]; success?: boolean };

      if (isStaleLifecycleGeneration(ctx)) return;

      // Issue #742: extract tool names from messages and record via WorkflowTracker
      // so crystallization can detect patterns from the traces table.
      if (ctx.workflowTracker && ctx.cfg.workflowTracking?.enabled) {
        try {
          const messages = ev?.messages ?? [];
          const sessionId = sessionState.resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";
          const turnMessages = currentTurnSlice(messages);

          const goal = redactMaintenancePrivateText(
            extractUserWorkflowGoal(turnMessages, ctx.cfg.crystallization?.excludeGoalPatterns),
          );

          // Get session start time from sessionLastActivity (set during before_agent_start)
          const sessionStartTime = sessionState.sessionLastActivity.get(sessionId);

          for (const toolName of extractToolNamesFromMessages(turnMessages)) {
            ctx.workflowTracker?.push(sessionId, toolName, sessionStartTime);
          }

          if (isSystemWorkflowGoal(goal, ctx.cfg.crystallization?.excludeGoalPatterns)) {
            ctx.workflowTracker?.discard(sessionId);
            api.logger.debug?.(
              `memory-hybrid: workflow trace skipped (system/cron goal) session=${sessionId} goal=${goal.slice(0, 80)}`,
            );
          } else {
            const outcome = ev?.success === true ? "success" : ev?.success === false ? "failure" : "unknown";
            const toolCount = ctx.workflowTracker?.getBuffer?.(sessionId)?.length ?? 0;
            const traceId = ctx.workflowTracker?.flush(sessionId, goal, outcome);
            if (traceId) {
              api.logger.info?.(
                `memory-hybrid: workflow trace recorded id=${traceId} session=${sessionId} outcome=${outcome} tools=${toolCount}`,
              );
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "workflow-tracking",
            operation: "agent-end-track-workflow",
            sessionId: sessionState.resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default",
          });
          api.logger.warn(`memory-hybrid: workflow tracking failed: ${String(err)}`);
        }
      }

      if (isStaleLifecycleGeneration(ctx)) {
        const sessionId = sessionState.resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";
        sessionState.clearSessionState(sessionId);
        sessionState.clearInjectedFactIdsForSession(ctx.injectedFactIdsBySession, sessionId);
        return;
      }
      await runCaptureStage(event, rApi, ctx, sessionState);
      if (isStaleLifecycleGeneration(ctx)) return;
      const sessionId = sessionState.resolveSessionKey(event, rApi) ?? ctx.currentAgentIdRef.value ?? "default";
      if (isStaleLifecycleGeneration(ctx)) return;
      if (ctx.cfg.goalStewardship?.enabled) {
        try {
          const { listActiveGoals, resolveGoalsDir } = await import("../services/goal-stewardship.js");
          const gDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
          const activeGoals = await listActiveGoals(gDir);
          if (activeGoals.length > 0) {
            api.logger.debug?.(
              `memory-hybrid: active goals at session end: ${activeGoals.map((g) => `${g.label}(${g.status})`).join(", ")}`,
            );
            try {
              ctx.eventLog?.append({
                sessionId,
                timestamp: nowIso(),
                eventType: "action_taken",
                content: {
                  kind: "goal.session_summary",
                  activeGoals: activeGoals.map((g) => ({
                    id: g.id,
                    label: g.label,
                    status: g.status,
                    assessments: g.assessmentCount,
                  })),
                },
              });
            } catch {
              /* non-fatal */
            }
          }
        } catch (err) {
          api.logger.debug?.(`memory-hybrid: goal session summary failed (non-fatal): ${String(err)}`);
        }
      }
      if (isStaleLifecycleGeneration(ctx)) return;

      try {
        await buildDailyNarrative({
          sessionId,
          eventLog: ctx.eventLog,
          workflowStore: ctx.workflowStore,
          narrativesDb: ctx.narrativesDb,
          openai: ctx.openai,
          model: getDefaultCronModel(getCronModelConfig(ctx.cfg), "nano"),
          logger: api.logger,
          fallbackModels: [],
          registrationGeneration: ctx.registrationGeneration,
          currentRegistrationGenerationRef: ctx.currentRegistrationGenerationRef,
        });
      } catch (err) {
        const transient = isAbortOrTransientLlmError(err);
        if (!transient) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "narratives",
            operation: "agent-end-build-narrative",
            sessionId,
          });
        }
        const detail = err instanceof Error ? err.message : String(err);
        if (transient) {
          api.logger.info?.(`memory-hybrid: session narrative skipped (LLM unavailable or aborted): ${detail}`);
        } else {
          api.logger.warn(`memory-hybrid: session narrative build failed: ${String(err)}`);
        }
      }
      if (isStaleLifecycleGeneration(ctx)) return;

      if (ev?.success !== false) {
        try {
          const messages = ev?.messages ?? [];
          let guard = evaluatePreFinalizationGuard(messages, { sessionKey: sessionId });
          const requiresProjectFacts =
            guard.reason === "missing_checkpoint_block" || guard.reason === "missing_checkpoint_warn";
          if (requiresProjectFacts) {
            const projectFacts = ctx.factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, 8000);
            let goalAliases: Array<{ id: string; label: string }> | undefined;
            if (ctx.cfg.goalStewardship?.enabled) {
              try {
                const { listActiveGoals, resolveGoalsDir } = await import("../services/goal-stewardship.js");
                const gDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
                const activeGoals = await listActiveGoals(gDir);
                goalAliases = activeGoals.map((g) => ({ id: g.id, label: g.label }));
              } catch {
                goalAliases = undefined;
              }
            }
            guard = evaluatePreFinalizationGuard(messages, { projectFacts, sessionKey: sessionId, goalAliases });
          }
          const guardMessage = formatPreFinalizationGuardMessage(guard);
          if (guard.reason === "explicit_bypass" || guard.reason === "checkpoint_present") {
            api.logger.info?.(`memory-hybrid: ${guardMessage}`);
          } else if (guard.action === "warn") {
            api.logger.warn?.(`memory-hybrid: ${guardMessage}`);
          } else if (guard.action === "block") {
            api.logger.warn?.(`memory-hybrid: ${guardMessage}`);
            try {
              ctx.auditStore?.append({
                agentId: ctx.currentAgentIdRef.value ?? "unknown",
                action: "cleanup:pre-finalization-guard-advisory",
                outcome: "partial",
                context: {
                  missingFields: guard.checkpoint.missingFields,
                  signals: guard.signals,
                },
              });
            } catch (auditErr) {
              api.logger.debug?.(`memory-hybrid: audit store append failed (non-fatal): ${String(auditErr)}`);
            }
            // agent_end is fail-open in OpenClaw core (hook-runner-global), so throwing here
            // only produces a spurious error-level log without actually blocking finalization.
            // Log the advisory at warn level only (#1479 Fix D).
          }
        } catch (err) {
          api.logger.debug?.(`memory-hybrid: pre-finalization guard skipped (non-fatal): ${String(err)}`);
        }
      }
    });
  };

  const dispose = getDispose(staleSweepTimer, sessionState, ctx.injectedFactIdsBySession);

  return { onAgentStart, onAgentEnd, onFrustrationDetect, onChangeNotify, dispose, sessionState };
}
