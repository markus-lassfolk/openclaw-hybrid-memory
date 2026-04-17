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
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { isAbortOrTransientLlmError } from "../services/chat.js";
import { capturePluginError } from "../services/error-reporter.js";
import { buildDailyNarrative } from "../src/worker/narratives.js";
import { withHookResolutionApi } from "./hook-resolution-api.js";
import { createSessionState } from "./session-state.js";
import { registerActiveTaskInjection } from "./stage-active-task.js";
import { registerAuthFailureRecall } from "./stage-auth-failure.js";
import { runCaptureStage } from "./stage-capture.js";
import {
	createStaleSweepTimer,
	getDispose,
	registerCleanupHandlers,
} from "./stage-cleanup.js";
import { registerCredentialHint } from "./stage-credential-hint.js";
import { registerFrustrationHandlers } from "./stage-frustration.js";
import {
	registerGoalStewardshipInjection,
	resolvedGoalsDirForLifecycle,
} from "./stage-goal-stewardship.js";
import { registerGoalSubagentHandlers } from "./stage-goal-subagent.js";
import { runInjectionStage } from "./stage-injection.js";
import { runRecallStage } from "./stage-recall.js";
import { runSetupStage } from "./stage-setup.js";
import type { LifecycleContext, SessionState } from "./types.js";

export type { LifecycleContext } from "./types.js";

export function createLifecycleHooks(ctx: LifecycleContext) {
	const sessionState = createSessionState();
	const staleSweepTimer = createStaleSweepTimer(sessionState);

	const workspaceRoot =
		getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
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
				try {
					const recallStageResult = await runRecallStage(
						event,
						rApi,
						ctx,
						sessionState,
					);
					if (!recallStageResult) return undefined;
					if (recallStageResult.kind === "degraded") {
						return { prependContext: recallStageResult.prependContext };
					}
					if (recallStageResult.kind === "empty") {
						return recallStageResult.prependContext
							? { prependContext: recallStageResult.prependContext }
							: undefined;
					}
					const inj = await runInjectionStage(
						recallStageResult.result,
						rApi,
						ctx,
					);
					return inj ?? undefined;
				} catch (err) {
					capturePluginError(
						err instanceof Error ? err : new Error(String(err)),
						{
							operation: "recall",
							subsystem: "auto-recall",
						},
					);
					api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
				}
				return undefined;
			});
		}

		registerActiveTaskInjection(
			api,
			ctx,
			resolvedActiveTaskPath,
			workspaceRoot,
		);
		const resolvedGoalsDir = resolvedGoalsDirForLifecycle(ctx.cfg);
		registerGoalStewardshipInjection(
			api,
			ctx,
			resolvedGoalsDir,
			ctx.cfg.activeTask.enabled ? resolvedActiveTaskPath : undefined,
		);
		registerGoalSubagentHandlers(api, ctx, resolvedGoalsDir);
		registerCleanupHandlers(
			api,
			ctx,
			sessionState,
			resolvedActiveTaskPath,
			workspaceRoot,
		);
		// Guard experimental/optional features at the registration point — avoids registering
		// event listeners whose bodies immediately return when disabled (#581).
		if (ctx.cfg.autoRecall.enabled && ctx.cfg.autoRecall.authFailure.enabled) {
			registerAuthFailureRecall(api, ctx, sessionState);
		}
		// Note: credential hints are gated on verbosity !== "silent" because their output
		// (a prepended hint block) is meaningless in silent mode. This is intentional:
		// the feature adds context only when the agent can surface it. If credential detection
		// without output injection is ever needed, split the guard accordingly.
		if (
			ctx.cfg.credentials.enabled &&
			ctx.cfg.credentials.autoDetect &&
			ctx.cfg.verbosity !== "silent"
		) {
			registerCredentialHint(api, ctx);
		}
	};

	const onFrustrationDetect = (api: ClawdbotPluginApi) => {
		registerFrustrationHandlers(api, ctx, sessionState);
	};

	const onAgentEnd = (api: ClawdbotPluginApi) => {
		// Same typed-hook shape as before_agent_start (#1005).
		api.on("agent_end", async (event: unknown, hookCtx: unknown) => {
			const rApi = withHookResolutionApi(api, hookCtx);
			// Issue #742: extract tool names from messages and record via WorkflowTracker
			// so crystallization can detect patterns from the traces table.
			if (ctx.workflowTracker && ctx.cfg.workflowTracking?.enabled) {
				try {
					const ev = event as { messages?: unknown[]; success?: boolean };
					const messages = ev?.messages ?? [];
					const sessionId =
						sessionState.resolveSessionKey(event, rApi) ??
						ctx.currentAgentIdRef.value ??
						"default";

					// Extract goal from first user message (used as trace label)
					let goal = "unknown";
					for (const msg of messages) {
						if (
							msg &&
							typeof msg === "object" &&
							(msg as { role?: string }).role === "user"
						) {
							const content = (msg as { content?: unknown }).content;
							if (typeof content === "string" && content.trim()) {
								goal = content.trim().slice(0, 200);
								break;
							}
						}
					}

					// Get session start time from sessionLastActivity (set during before_agent_start)
					const sessionStartTime =
						sessionState.sessionLastActivity.get(sessionId);

					// Push each tool call onto the tracker buffer with the actual session start time
					for (const msg of messages) {
						if (!msg || typeof msg !== "object") continue;
						const msgObj = msg as Record<string, unknown>;
						if (msgObj.role !== "assistant") continue;
						const toolCalls = msgObj.tool_calls;
						if (!Array.isArray(toolCalls)) continue;
						for (const tc of toolCalls) {
							if (!tc || typeof tc !== "object") continue;
							const fn = (tc as Record<string, unknown>).function as
								| Record<string, unknown>
								| undefined;
							if (fn && typeof fn.name === "string") {
								ctx.workflowTracker?.push(sessionId, fn.name, sessionStartTime);
							}
						}
					}

					// Flush buffer to workflow-traces.db
					const outcome =
						ev?.success === true
							? "success"
							: ev?.success === false
								? "failure"
								: "unknown";
					const traceId = ctx.workflowTracker?.flush(sessionId, goal, outcome);
					if (traceId) {
						api.logger.debug?.(
							`memory-hybrid: workflow trace recorded id=${traceId} session=${sessionId}`,
						);
					}
				} catch (err) {
					capturePluginError(
						err instanceof Error ? err : new Error(String(err)),
						{
							subsystem: "workflow-tracking",
							operation: "agent-end-track-workflow",
							sessionId:
								sessionState.resolveSessionKey(event, rApi) ??
								ctx.currentAgentIdRef.value ??
								"default",
						},
					);
					api.logger.warn(
						`memory-hybrid: workflow tracking failed: ${String(err)}`,
					);
				}
			}

			await runCaptureStage(event, rApi, ctx, sessionState);
			const sessionId =
				sessionState.resolveSessionKey(event, rApi) ??
				ctx.currentAgentIdRef.value ??
				"default";
			if (ctx.cfg.goalStewardship?.enabled) {
				try {
					const { listActiveGoals, resolveGoalsDir } = await import(
						"../services/goal-stewardship.js"
					);
					const gDir = resolveGoalsDir(
						workspaceRoot,
						ctx.cfg.goalStewardship.goalsDir,
					);
					const activeGoals = await listActiveGoals(gDir);
					if (activeGoals.length > 0) {
						api.logger.debug?.(
							`memory-hybrid: active goals at session end: ${activeGoals.map((g) => `${g.label}(${g.status})`).join(", ")}`,
						);
						try {
							ctx.eventLog?.append({
								sessionId,
								timestamp: new Date().toISOString(),
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
					api.logger.debug?.(
						`memory-hybrid: goal session summary failed (non-fatal): ${String(err)}`,
					);
				}
			}

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
				});
			} catch (err) {
				const transient = isAbortOrTransientLlmError(err);
				if (!transient) {
					capturePluginError(
						err instanceof Error ? err : new Error(String(err)),
						{
							subsystem: "narratives",
							operation: "agent-end-build-narrative",
							sessionId,
						},
					);
				}
				const detail = err instanceof Error ? err.message : String(err);
				if (transient) {
					api.logger.info?.(
						`memory-hybrid: session narrative skipped (LLM unavailable or aborted): ${detail}`,
					);
				} else {
					api.logger.warn(
						`memory-hybrid: session narrative build failed: ${String(err)}`,
					);
				}
			}
		});
	};

	const dispose = getDispose(staleSweepTimer, sessionState);

	return { onAgentStart, onAgentEnd, onFrustrationDetect, dispose };
}
