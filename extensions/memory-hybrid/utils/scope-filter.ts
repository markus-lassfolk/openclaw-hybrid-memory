/**
 * Helper to build scope filter for tool handlers (memory_recall, memory_recall_procedures).
 * Handles explicit parameters, agent-scoped filtering, and orchestrator fallback.
 *
 * ⚠️ SECURITY: By default, tool scope params (userId, agentId, sessionId) are IGNORED to prevent
 * cross-user memory access in multi-tenant setups. Set multiAgent.trustToolScopeParams=true to enable.
 */

import { addOperationBreadcrumb } from "../services/error-reporter.js";
import type { ScopeFilter } from "../types/memory.js";

export function buildToolScopeFilter(
  params: {
    userId?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    /** When multiAgent.trustToolScopeParams is true, must be true to apply caller scope (#874). */
    confirmCrossTenantScope?: boolean;
  },
  currentAgent: string | null,
  config: {
    multiAgent: { orchestratorId: string; trustToolScopeParams?: boolean };
    autoRecall: { scopeFilter?: ScopeFilter };
  },
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
