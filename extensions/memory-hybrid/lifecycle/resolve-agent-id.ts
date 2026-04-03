/**
 * Resolve the active agent id for lifecycle hooks (`before_agent_start`, etc.).
 *
 * OpenClaw should populate `api.context.agentId` for routed channels; some builds
 * only pass identity on the event payload. This module centralizes best-effort
 * extraction so WhatsApp and similar routes can be recognized without duplicating
 * ad-hoc field checks across stages.
 *
 * Cron / embedded runs may omit structured `agentId` while still using session keys
 * like `agent:<id>:cron:<jobId>` — see #990 and `tryParseAgentIdFromOpenClawSessionKey`.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HookAgentContextSlice } from "./types.js";
import { resolveSessionKeyFromHookEvent } from "./session-state.js";

const SESSION_KEY_TRUNCATE_MAX = 120;

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function formatSessionKeyTruncated(sessionKey: string): string {
  if (sessionKey.length <= SESSION_KEY_TRUNCATE_MAX) return sessionKey;
  return `${sessionKey.slice(0, SESSION_KEY_TRUNCATE_MAX - 3)}...`;
}

/**
 * Parse OpenClaw-style session keys: `agent:<agentId>:<suffix...>`
 * (e.g. `agent:main:main`, `agent:ralph:cron:job-1`, `agent:forge:subagent:uuid`).
 *
 * @returns The agent id segment, or `null` if the key does not match (including
 * bare `cron:<jobId>` keys, which carry no agent prefix).
 */
export function tryParseAgentIdFromOpenClawSessionKey(sessionKey: string): string | null {
  const t = sessionKey.trim();
  if (!t.startsWith("agent:")) return null;
  const parts = t.split(":");
  if (parts.length < 3) return null;
  const id = parts[1]?.trim();
  return id && id.length > 0 ? id : null;
}

/**
 * @returns Detected agent id, or `null` if nothing usable was found.
 */
export function resolveAgentIdFromHookEvent(
  event: unknown,
  api: ClawdbotPluginApi,
  hookAgentCtx?: HookAgentContextSlice,
): string | null {
  const ev = event as Record<string, unknown>;
  const session = ev.session as Record<string, unknown> | undefined;
  const run = ev.run as Record<string, unknown> | undefined;
  const payloadCtx = ev.context as Record<string, unknown> | undefined;
  const activeAgent = session?.activeAgent;

  const explicit =
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
    nonEmptyString(hookAgentCtx?.agentId) ??
    nonEmptyString(api.context?.agentId);

  if (explicit) return explicit;

  const sessionKey = resolveSessionKeyFromHookEvent(event, api, hookAgentCtx);
  const fromSessionKey = sessionKey ? tryParseAgentIdFromOpenClawSessionKey(sessionKey) : null;
  if (fromSessionKey && sessionKey) {
    api.logger?.debug?.(
      `memory-hybrid: Resolved agentId "${fromSessionKey}" from session key pattern (${formatSessionKeyTruncated(sessionKey)})`,
    );
  }
  return fromSessionKey;
}
