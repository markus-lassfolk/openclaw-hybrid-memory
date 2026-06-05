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
  const sessionId =
    (typeof api.context?.sessionId === "string" ? api.context.sessionId.trim() : null) ??
    (typeof api.context?.sessionKey === "string" ? api.context.sessionKey.trim() : null) ??
    null;
  return { userId, agentId, sessionId };
}

/** Resolve trusted scope for gateway RPC / corpus reads; defaults to global-only. */
export function resolveGatewayScopeFilter(
  api: Parameters<typeof readGatewayIdentity>[0],
  cfg: ScopeConfig,
): ScopeFilter {
  const { userId, agentId, sessionId } = readGatewayIdentity(api);
  const built = buildToolScopeFilter({ userId, agentId, sessionId }, agentId, cfg);
  return built ?? globalOnlyScopeFilter();
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

export function scopeFieldsFromEntry(entry: {
  scope?: MemoryScope | null;
  scopeTarget?: string | null;
}): { scope: MemoryScope; scopeTarget?: string } {
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
