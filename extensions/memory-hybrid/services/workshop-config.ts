/**
 * Shared workshop feature flags and limits.
 */

import type { HybridMemoryConfig } from "../config.js";
import { BROADCAST_CHANGE_SESSION_KEY } from "./change-feed-emit.js";

export const DEFAULT_WORKSHOP_MAX_PENDING = 50;

export const DEFAULT_WORKSHOP_LIST_LIMIT = 50;

/** Smaller default for in-chat memory_workshop list to conserve context. */
export const DEFAULT_WORKSHOP_TOOL_LIST_LIMIT = 20;

export const DEFAULT_WORKSHOP_DASHBOARD_LIST_LIMIT = 100;

export const MISSION_CONTROL_SESSION_KEY = "mission-control";

/** Session key for proposed/backfill change-feed events (system-wide visibility). */
export function resolveWorkshopProposedSessionKey(): string {
  return BROADCAST_CHANGE_SESSION_KEY;
}

/** Session key for operator apply/approve actions (Mission Control default). */
export function resolveWorkshopAppliedSessionKey(cfg?: HybridMemoryConfig): string {
  return resolveWorkshopSessionKey(cfg);
}

/** Session keys shown in Mission Control change-feed panel (scoped, deduped). */
export function listWorkshopDashboardChangeFeedSessions(
  cfg?: HybridMemoryConfig,
  recentSessionKeys?: Iterable<string>,
): string[] {
  const keys = new Set<string>([BROADCAST_CHANGE_SESSION_KEY, resolveWorkshopSessionKey(cfg)]);
  if (recentSessionKeys) {
    for (const key of recentSessionKeys) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys];
}

/**
 * Master workshop switch. Auto-enables when persona, crystallization, self-extension,
 * or procedure-skill promotion is active. Set workshop.enabled: false to force-disable.
 */
export function isWorkshopEnabled(cfg?: HybridMemoryConfig): boolean {
  if (!cfg) return false;
  const explicit = cfg.workshop?.enabled;
  if (explicit === false) return false;
  if (explicit === true) return true;
  return (
    cfg.personaProposals?.enabled === true ||
    cfg.crystallization?.enabled === true ||
    cfg.selfExtension?.enabled === true ||
    cfg.procedures?.enabled === true
  );
}

export function resolveWorkshopMaxPending(cfg?: HybridMemoryConfig): number {
  const fromWorkshop = cfg?.workshop?.maxPending;
  if (typeof fromWorkshop === "number" && fromWorkshop >= 0) return Math.floor(fromWorkshop);
  const configured = cfg?.personaProposals?.workshopMaxPending;
  if (typeof configured === "number" && configured >= 0) return Math.floor(configured);
  return DEFAULT_WORKSHOP_MAX_PENDING;
}

export function resolveWorkshopSessionKey(cfg?: HybridMemoryConfig): string {
  const configured = cfg?.workshop?.sessionKey?.trim();
  return configured || MISSION_CONTROL_SESSION_KEY;
}

/** Default session for revert_by_ordinal when no chat session is in context. */
export function resolveWorkshopRevertSessionKey(
  cfg?: HybridMemoryConfig,
  explicit?: string,
  chatSessionKey?: string,
): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const chat = chatSessionKey?.trim();
  if (chat) return chat;
  return resolveWorkshopSessionKey(cfg);
}

/**
 * SECURITY: the change-feed list/revert HTTP routes and gateway RPC methods let a caller name
 * an arbitrary `session`/`sessionKey` to scope the request — but that value must never be
 * trusted as an identity claim (the same class of gap `utils/scope-filter.ts` documents for
 * fact scoping). Only the caller's own trusted session (from the plugin API's `context`, which
 * the caller cannot spoof) or the broadcast pseudo-session may be used; any other value is a
 * cross-session read/revert attempt and must be rejected. This does not apply to Mission
 * Control's dashboard collectors, which call the change-feed service directly in-process and
 * never go through these caller-facing entry points.
 */
export function isAuthorizedChangeFeedSessionKey(requested: string, trustedCallerSessionKey?: string): boolean {
  const trimmed = requested.trim();
  if (!trimmed) return false;
  if (trimmed === BROADCAST_CHANGE_SESSION_KEY) return true;
  const trustedTrimmed = trustedCallerSessionKey?.trim();
  return !!trustedTrimmed && trimmed === trustedTrimmed;
}
