/**
 * Helper to build scope filter for tool handlers (memory_recall, memory_recall_procedures).
 * Handles explicit parameters, agent-scoped filtering, and orchestrator fallback.
 */

import type { ScopeFilter } from "../types/memory.js";

export function buildToolScopeFilter(
  params: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
  currentAgent: string | null,
  config: { multiAgent: { orchestratorId: string }; autoRecall: { scopeFilter?: ScopeFilter } }
): ScopeFilter | undefined {
  const { userId, agentId, sessionId } = params;
  if (userId || agentId || sessionId) {
    return { userId: userId ?? null, agentId: agentId ?? null, sessionId: sessionId ?? null };
  } else if (currentAgent && currentAgent !== config.multiAgent.orchestratorId) {
    return {
      userId: config.autoRecall.scopeFilter?.userId ?? null,
      agentId: currentAgent,
      sessionId: config.autoRecall.scopeFilter?.sessionId ?? null
    };
  } else {
    return undefined;
  }
}
