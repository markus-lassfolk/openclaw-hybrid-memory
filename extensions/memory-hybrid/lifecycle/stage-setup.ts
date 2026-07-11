/**
 * Lifecycle stage: Setup (Phase 2.3).
 * Agent detection, session touch, restart marker, event log session_start.
 * Config: always runs (no toggle). Timeout: 5s.
 */

import { existsSync, unlinkSync } from "node:fs";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  markBeforeAgentStartTurn,
  resolveBeforeAgentStartStageTimeoutMs,
} from "../services/before-agent-start-budget.js";
import { capturePluginError } from "../services/error-reporter.js";
import { clearSessionInjectionDedup } from "../services/session-injection-dedup.js";
import { getRestartPendingPath } from "../utils/constants.js";
import { nowIso } from "../utils/dates.js";
import { pluginLogger } from "../utils/logger.js";
import { withTimeout } from "../utils/timeout.js";
import { formatSessionKeyTruncated, resolveAgentIdFromHookEvent } from "./resolve-agent-id.js";
import type { LifecycleContext, SessionState } from "./types.js";

const SETUP_TIMEOUT_MS = 5000;

export function runSetupStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  markBeforeAgentStartTurn(ctx.beforeAgentStartTurnRef);
  const timeoutMs = resolveBeforeAgentStartStageTimeoutMs(ctx.beforeAgentStartTurnRef, SETUP_TIMEOUT_MS, 200);
  return withTimeout(timeoutMs, () => runSetup(event, api, ctx, sessionState)).then(() => {});
}

async function runSetup(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<void> {
  const { currentAgentIdRef, restartPendingClearedRef, prependBudgetRef } = ctx;
  const { touchSession, resolveSessionKey } = sessionState;

  if (prependBudgetRef) {
    prependBudgetRef.value = null;
  }

  const touchKey = resolveSessionKey(event, api) ?? currentAgentIdRef.value ?? "default";
  clearSessionInjectionDedup(ctx.injectedFactIdsBySession, touchKey);
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

  const detectedAgentId = resolveAgentIdFromHookEvent(event, api);
  if (detectedAgentId) {
    currentAgentIdRef.value = detectedAgentId;
    api.logger.debug?.(`memory-hybrid: Detected agentId: ${detectedAgentId}`);
  } else {
    const sk = resolveSessionKey(event, api);
    api.logger.debug?.(
      sk
        ? `memory-hybrid: Agent detection failed — no structured agentId and session key did not yield one (${formatSessionKeyTruncated(sk)}); falling back to orchestrator`
        : "memory-hybrid: Agent detection failed — no agentId in event payload or api.context and no session key; falling back to orchestrator",
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
        timestamp: nowIso(),
        eventType: "action_taken",
        content: { action: "session_start", agentId: currentAgentIdRef.value },
      });
    } catch {
      // Non-fatal
    }
  }
}
