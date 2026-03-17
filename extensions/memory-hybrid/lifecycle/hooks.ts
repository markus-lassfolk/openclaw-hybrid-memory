/**
 * Lifecycle Hooks (Phase 2.3: staged pipeline).
 *
 * Dispatcher: registers before_agent_start, agent_end, subagent, and frustration handlers.
 * All stage logic lives in stage-*.ts and session-state.ts; this file stays <200 lines.
 */

import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { runSetupStage } from "./stage-setup.js";
import { runRecallStage } from "./stage-recall.js";
import { runInjectionStage } from "./stage-injection.js";
import { runCaptureStage } from "./stage-capture.js";
import { registerCleanupHandlers, createStaleSweepTimer, getDispose } from "./stage-cleanup.js";
import { registerActiveTaskInjection } from "./stage-active-task.js";
import { registerAuthFailureRecall } from "./stage-auth-failure.js";
import { registerCredentialHint } from "./stage-credential-hint.js";
import { registerFrustrationHandlers } from "./stage-frustration.js";
import { createSessionState } from "./session-state.js";
import type { LifecycleContext, SessionState } from "./types.js";
import { capturePluginError } from "../services/error-reporter.js";

export type { LifecycleContext } from "./types.js";

export function createLifecycleHooks(ctx: LifecycleContext) {
  const sessionState = createSessionState();
  const staleSweepTimer = createStaleSweepTimer(sessionState);

  const workspaceRoot = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const resolvedActiveTaskPath = isAbsolute(ctx.cfg.activeTask.filePath)
    ? ctx.cfg.activeTask.filePath
    : join(workspaceRoot, ctx.cfg.activeTask.filePath);

  const onAgentStart = (api: ClawdbotPluginApi) => {
    api.on("before_agent_start", async (event: unknown) => {
      await runSetupStage(event, api, ctx, sessionState);
    });

    if (ctx.cfg.autoRecall.enabled && ctx.cfg.verbosity !== "silent") {
      api.on("before_agent_start", async (event: unknown) => {
        try {
          const recallStageResult = await runRecallStage(event, api, ctx, sessionState);
          if (!recallStageResult) return undefined;
          if (recallStageResult.kind === "degraded") {
            return { prependContext: recallStageResult.prependContext };
          }
          if (recallStageResult.kind === "empty") {
            return recallStageResult.prependContext ? { prependContext: recallStageResult.prependContext } : undefined;
          }
          const inj = await runInjectionStage(recallStageResult.result, api, ctx);
          return inj ?? undefined;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "recall",
            subsystem: "auto-recall",
          });
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
        return undefined;
      });
    }

    registerActiveTaskInjection(api, ctx, resolvedActiveTaskPath);
    registerCleanupHandlers(api, ctx, sessionState, resolvedActiveTaskPath, workspaceRoot);
    // Guard experimental/optional features at the registration point — avoids registering
    // event listeners whose bodies immediately return when disabled (#581).
    if (ctx.cfg.autoRecall.authFailure.enabled) {
      registerAuthFailureRecall(api, ctx, sessionState);
    }
    if (ctx.cfg.credentials.enabled && ctx.cfg.credentials.autoDetect) {
      registerCredentialHint(api, ctx);
    }
  };

  const onFrustrationDetect = (api: ClawdbotPluginApi) => {
    registerFrustrationHandlers(api, ctx, sessionState);
  };

  const onAgentEnd = (api: ClawdbotPluginApi) => {
    api.on("agent_end", async (event: unknown) => {
      await runCaptureStage(event, api, ctx, sessionState);
    });
  };

  const dispose = getDispose(staleSweepTimer, sessionState);

  return { onAgentStart, onAgentEnd, onFrustrationDetect, dispose };
}
