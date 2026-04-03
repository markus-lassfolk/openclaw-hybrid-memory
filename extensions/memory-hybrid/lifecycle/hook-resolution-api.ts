/**
 * Fold OpenClaw typed-hook context (`PluginHookAgentContext`, 2nd callback arg) into
 * `api.context` so session/agent resolvers use `(event, api)` only (#1005).
 *
 * Per-field precedence vs existing `api.context`: hook slice wins (matches
 * `resolveSessionKeyFromHookEvent` ordering before `api.context`).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HookAgentContextSlice } from "./types.js";

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Pick session/agent fields from an unknown hook context object. */
export function sliceHookAgentContext(hookCtx: unknown): HookAgentContextSlice | undefined {
  if (!hookCtx || typeof hookCtx !== "object") return undefined;
  const o = hookCtx as Record<string, unknown>;
  const agentId = nonEmptyString(o.agentId);
  const sessionKey = nonEmptyString(o.sessionKey);
  const sessionId = nonEmptyString(o.sessionId);
  if (!agentId && !sessionKey && !sessionId) return undefined;
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(sessionKey !== undefined ? { sessionKey } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * Returns `api` unchanged when `hookCtx` carries no usable slice; otherwise a shallow
 * clone with `context` merged so hook fields override the same keys on `api.context`.
 */
export function withHookResolutionApi(api: ClawdbotPluginApi, hookCtx: unknown): ClawdbotPluginApi {
  const slice = sliceHookAgentContext(hookCtx);
  if (!slice) return api;
  const c = api.context ?? {};
  return {
    ...api,
    context: {
      ...c,
      sessionId: slice.sessionId ?? c.sessionId,
      sessionKey: slice.sessionKey ?? c.sessionKey,
      agentId: slice.agentId ?? c.agentId,
    },
  } as ClawdbotPluginApi;
}
