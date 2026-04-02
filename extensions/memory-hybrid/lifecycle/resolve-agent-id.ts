/**
 * Resolve the active agent id for lifecycle hooks (`before_agent_start`, etc.).
 *
 * OpenClaw should populate `api.context.agentId` for routed channels; some builds
 * only pass identity on the event payload. This module centralizes best-effort
 * extraction so WhatsApp and similar routes can be recognized without duplicating
 * ad-hoc field checks across stages.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * @returns Detected agent id, or `null` if nothing usable was found.
 */
export function resolveAgentIdFromHookEvent(event: unknown, api: ClawdbotPluginApi): string | null {
  const ev = event as Record<string, unknown>;
  const session = ev.session as Record<string, unknown> | undefined;
  const run = ev.run as Record<string, unknown> | undefined;
  const payloadCtx = ev.context as Record<string, unknown> | undefined;
  const activeAgent = session?.activeAgent;

  return (
    nonEmptyString(ev.agentId) ??
    nonEmptyString(session?.agentId) ??
    nonEmptyString(session?.agent) ??
    nonEmptyString(session?.activeAgentId) ??
    nonEmptyString(session?.botId) ??
    nonEmptyString(session?.routedAgentId) ??
    (activeAgent && typeof activeAgent === "object"
      ? nonEmptyString((activeAgent as Record<string, unknown>).id)
      : null) ??
    nonEmptyString(run?.agentId) ??
    nonEmptyString(payloadCtx?.agentId) ??
    nonEmptyString(api.context?.agentId)
  );
}
