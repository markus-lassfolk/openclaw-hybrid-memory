/**
 * Fold OpenClaw typed-hook context (`PluginHookAgentContext`, 2nd callback arg) into
 * `api.context` so session/agent resolvers use `(event, api)` only (#1005).
 *
 * **Merge vs previous `api.context`:** for each of `sessionId`, `sessionKey`, and
 * `agentId`, a non-empty hook value replaces the same field on `api.context`. This mirrors
 * “hook before bare api.context” in the old three-argument resolver.
 *
 * **End-to-end identity:** event/session/payload fields still win over merged `api.context`
 * in `resolveSessionKeyFromHookEvent` and `resolveAgentIdFromHookEvent`, so structured
 * payloads cannot be overridden by hook context (symmetric for session key and agent id).
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
      // Order matches resolveSessionKeyFromHookEvent: sessionId before sessionKey on api.context.
      sessionId: slice.sessionId ?? c.sessionId,
      sessionKey: slice.sessionKey ?? c.sessionKey,
      agentId: slice.agentId ?? c.agentId,
    },
  } as ClawdbotPluginApi;
}
