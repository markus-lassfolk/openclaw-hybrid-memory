/**
 * Lifecycle stage: Setup (Phase 2.3).
 * Agent detection, session touch, restart marker, event log session_start.
 * Config: always runs (no toggle). Timeout: 5s.
 */

import { existsSync, unlinkSync } from "node:fs";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { getRestartPendingPath } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { LifecycleContext, SessionState, SetupResult } from "./types.js";
import type { ScopeFilter } from "../types/memory.js";

const SETUP_TIMEOUT_MS = 5000;

export function runSetupStage(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<SetupResult | null> {
  return withTimeout(SETUP_TIMEOUT_MS, () => runSetup(event, api, ctx, sessionState));
}

async function runSetup(
  event: unknown,
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  sessionState: SessionState,
): Promise<SetupResult> {
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
        console.warn("Failed to delete restart marker:", err);
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

  const tierFilter: "warm" | "all" = ctx.cfg.memoryTiering.enabled ? "warm" : "all";
  let scopeFilter: ScopeFilter | undefined;
  if (currentAgentIdRef.value && currentAgentIdRef.value !== ctx.cfg.multiAgent.orchestratorId) {
    scopeFilter = {
      userId: ctx.cfg.autoRecall.scopeFilter?.userId ?? null,
      agentId: currentAgentIdRef.value,
      sessionId: ctx.cfg.autoRecall.scopeFilter?.sessionId ?? null,
    };
  } else if (
    ctx.cfg.autoRecall.scopeFilter &&
    (ctx.cfg.autoRecall.scopeFilter.userId ||
      ctx.cfg.autoRecall.scopeFilter.agentId ||
      ctx.cfg.autoRecall.scopeFilter.sessionId)
  ) {
    scopeFilter = {
      userId: ctx.cfg.autoRecall.scopeFilter.userId ?? null,
      agentId: ctx.cfg.autoRecall.scopeFilter.agentId ?? null,
      sessionId: ctx.cfg.autoRecall.scopeFilter.sessionId ?? null,
    };
  }
  return { scopeFilter, sessionKey: touchKey, tierFilter };
}

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T | null> {
  return Promise.race([
    fn(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
