/**
 * Helper to build scope filter for tool handlers (memory_recall, memory_recall_procedures).
 * Handles explicit parameters, agent-scoped filtering, and orchestrator fallback.
 *
 * ⚠️ SECURITY: By default, tool scope params (userId, agentId, sessionId) are IGNORED to prevent
 * cross-user memory access in multi-tenant setups. Set multiAgent.trustToolScopeParams=true to enable.
 */

import { addOperationBreadcrumb } from "../services/error-reporter.js";
import type { MemoryScope, ScopeFilter } from "../types/memory.js";

/** Sentinel agentId: matches no agent-scoped rows — global facts only. */
export const GLOBAL_ONLY_SCOPE_SENTINEL = "__public_api_unscoped__";

export function globalOnlyScopeFilter(): ScopeFilter {
  return { agentId: GLOBAL_ONLY_SCOPE_SENTINEL };
}

/**
 * Resolve a ScopeFilter from the `x-openclaw-{user,agent,session}-id` identity headers, shared
 * by every HTTP-adjacent entry point (REST public API, GraphQL) so they enforce the same
 * fail-closed default.
 *
 * SECURITY: identity headers must be populated by trusted gateway middleware. Missing identity
 * defaults to global-only visibility — callers must never let arbitrary client-controlled scope
 * params reach here directly.
 */
export function scopeFilterFromIdentityHeaders(getHeader: (name: string) => string | null | undefined): ScopeFilter {
  const trim = (v: string | null | undefined) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const userId = trim(getHeader("x-openclaw-user-id"));
  const agentId = trim(getHeader("x-openclaw-agent-id"));
  const sessionId = trim(getHeader("x-openclaw-session-id"));

  if (!userId && !agentId && !sessionId) {
    return globalOnlyScopeFilter();
  }

  return { userId: userId ?? undefined, agentId: agentId ?? undefined, sessionId: sessionId ?? undefined };
}

type ScopeConfig = {
  multiAgent: { orchestratorId: string; trustToolScopeParams?: boolean };
  autoRecall: { scopeFilter?: ScopeFilter };
};

function readGatewayIdentity(api: {
  context?: {
    userId?: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
  };
}): { userId: string | null; agentId: string | null; sessionId: string | null } {
  const userId = typeof api.context?.userId === "string" ? api.context.userId.trim() || null : null;
  const agentId = typeof api.context?.agentId === "string" ? api.context.agentId.trim() || null : null;
  // `|| null` (not just the `??` below) on each branch, matching userId/agentId above: without it,
  // an empty-string sessionId is falsy-but-not-null, so `??` never falls through to sessionKey --
  // silently widening a session-scoped RPC/corpus read to the caller's entire user-level history
  // instead of one session (#2067-followup).
  const sessionId =
    (typeof api.context?.sessionId === "string" ? api.context.sessionId.trim() || null : null) ??
    (typeof api.context?.sessionKey === "string" ? api.context.sessionKey.trim() || null : null) ??
    null;
  return { userId, agentId, sessionId };
}

/** Resolve trusted scope for gateway RPC / corpus reads; defaults to global-only. */
export function resolveGatewayScopeFilter(
  api: Parameters<typeof readGatewayIdentity>[0],
  cfg: ScopeConfig,
): ScopeFilter {
  const { userId, agentId, sessionId } = readGatewayIdentity(api);
  if (!userId && !agentId && !sessionId) {
    return globalOnlyScopeFilter();
  }
  if (agentId && agentId === cfg.multiAgent.orchestratorId) {
    // The orchestrator gets the configured/global fallback rather than a narrow scope -- it's
    // the top-level coordinating agent, not a per-session worker.
    return cfg.autoRecall.scopeFilter ?? globalOnlyScopeFilter();
  }
  // Unlike buildToolScopeFilter's untrusted-tool-param path, gateway identity (api.context) is
  // already verified by trusted middleware, so userId/sessionId must be applied as-is instead of
  // being replaced by a static autoRecall.scopeFilter value -- otherwise every session under the
  // same non-orchestrator agent collapses onto one shared scope (#security).
  return { userId, agentId, sessionId };
}

/** Resolve corpus supplement scope from session key or static config filter. */
export function resolveCorpusScopeFilter(
  agentSessionKey: string | undefined,
  configured?: ScopeFilter | null,
): ScopeFilter {
  if (configured && (configured.userId || configured.agentId || configured.sessionId)) {
    return configured;
  }
  const sessionKey = agentSessionKey?.trim();
  if (sessionKey) {
    return { sessionId: sessionKey };
  }
  return globalOnlyScopeFilter();
}

export function scopeFieldsFromFilter(filter: ScopeFilter): {
  scope: MemoryScope;
  scopeTarget?: string;
} {
  if (filter.sessionId) return { scope: "session", scopeTarget: filter.sessionId };
  if (filter.userId) return { scope: "user", scopeTarget: filter.userId };
  if (filter.agentId && filter.agentId !== GLOBAL_ONLY_SCOPE_SENTINEL) {
    return { scope: "agent", scopeTarget: filter.agentId };
  }
  return { scope: "global" };
}

export function scopeFieldsFromEntry(entry: { scope?: MemoryScope | null; scopeTarget?: string | null }): {
  scope: MemoryScope;
  scopeTarget?: string;
} {
  const scope = entry.scope ?? "global";
  if (scope === "global") return { scope: "global" };
  return { scope, scopeTarget: entry.scopeTarget ?? undefined };
}

export function buildToolScopeFilter(
  params: {
    userId?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    /** When multiAgent.trustToolScopeParams is true, must be true to apply caller scope (#874). */
    confirmCrossTenantScope?: boolean;
  },
  currentAgent: string | null,
  config: ScopeConfig,
): ScopeFilter | undefined {
  const { userId, agentId, sessionId, confirmCrossTenantScope } = params;

  // Security: Only trust tool params if explicitly enabled in config
  const trustParams = config.multiAgent.trustToolScopeParams === true;
  const hasScopeParams = Boolean(userId || agentId || sessionId);
  if (hasScopeParams && trustParams && confirmCrossTenantScope) {
    return { userId: userId ?? null, agentId: agentId ?? null, sessionId: sessionId ?? null };
  }
  if (hasScopeParams && (!trustParams || !confirmCrossTenantScope)) {
    // Debug: Log when explicit scope params are ignored for security
    addOperationBreadcrumb("scope-filter", "params-ignored-security");
  }

  if (currentAgent && currentAgent !== config.multiAgent.orchestratorId) {
    return {
      userId: config.autoRecall.scopeFilter?.userId ?? null,
      agentId: currentAgent,
      sessionId: config.autoRecall.scopeFilter?.sessionId ?? null,
    };
  }

  if (config.autoRecall.scopeFilter) {
    return config.autoRecall.scopeFilter;
  }
  return undefined;
}
