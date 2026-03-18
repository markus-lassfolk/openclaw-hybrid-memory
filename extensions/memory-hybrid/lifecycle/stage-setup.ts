/**
 * Lifecycle stage: Setup (Phase 2.3).
 * Agent detection, session touch, restart marker, event log session_start.
 * Config: always runs (no toggle). Timeout: 5s.
 */

import { existsSync, unlinkSync } from "node:fs";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { getRestartPendingPath } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";
import { withTimeout } from "../utils/timeout.js";
import type { LifecycleContext, SessionState } from "./types.js";
import { pluginLogger } from "../utils/logger.js";

const SETUP_TIMEOUT_MS = 5000;

export function runSetupStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  return withTimeout(SETUP_TIMEOUT_MS, () => runSetup(event, api, ctx, sessionState)).then(() => {});
}

async function runSetup(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  const { currentAgentIdRef, restartPendingClearedRef } = ctx;
  const { touchSession, resolveSessionKey } = sessionState;

  const touchKey = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";
  touchSession(touchKey);

  if (!restartPendingClearedRef.value && existsSync(getRestartPendingPath())) {
    restartPendingClearedRef.value = true;
    try {
      unlinkSync(getRestartPendingPath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "lifecycle",
          operation: "delete-restart-marker",
        });
        pluginLogger.warn(`Failed to delete restart marker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const e = event as { prompt?: string; agentId?: string; session?: { agentId?: string } };
  const detectedAgentId = e.agentId || e.session?.agentId || api.context?.agentId;
  if (detectedAgentId) {
    currentAgentIdRef.value = detectedAgentId;
    api.logger.debug?.(`memory-hybrid: Detected agentId: ${detectedAgentId}`);
  } else {
    api.logger.debug?.(
      "memory-hybrid: Agent detection failed - no agentId in event payload or api.context, falling back to orchestrator",
    );
    currentAgentIdRef.value = currentAgentIdRef.value || ctx.cfg.multiAgent.orchestratorId;
    if (ctx.cfg.multiAgent.defaultStoreScope === "agent" || ctx.cfg.multiAgent.defaultStoreScope === "auto") {
      api.logger.debug?.(
        `memory-hybrid: Agent detection failed but defaultStoreScope is "${ctx.cfg.multiAgent.defaultStoreScope}" - memories may be incorrectly scoped`,
      );
    }
  }

  if (ctx.eventLog) {
    const sessionId = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";
    try {
      ctx.eventLog.append({
        sessionId,
        timestamp: new Date().toISOString(),
        eventType: "action_taken",
        content: { action: "session_start", agentId: currentAgentIdRef.value },
      });
    } catch {
      // Non-fatal
    }
  }
}
