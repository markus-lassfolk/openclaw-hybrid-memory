import type { MultiAgentConfig } from "../config/types/agents.js";

export type ResolvedStoreScope = { scope: "global" | "agent"; scopeTarget: string | null };

/**
 * Resolve the scope for a new fact when no explicit scope was supplied by the caller,
 * per `multiAgent.defaultStoreScope` (Issue #1574 / FR-006). Mirrors the auto-resolve
 * branch in `tools/memory/register-store-tools.ts` so every write path — explicit
 * `memory_store` calls and background auto-capture alike — honors the same
 * agent-isolation policy instead of defaulting to "global".
 *
 * Non-throwing: background capture paths shouldn't crash the hook pipeline on a
 * detection failure, so `strictAgentScoping` degrades to a warning + orchestrator
 * fallback here rather than throwing (unlike the explicit-tool call site, which still
 * throws directly so the caller gets immediate feedback).
 */
export function resolveDefaultStoreScope(
  cfg: { multiAgent?: MultiAgentConfig },
  currentAgentId: string | null,
  warn?: (message: string) => void,
): ResolvedStoreScope {
  const multiAgent = cfg.multiAgent;
  // No multiAgent config resolved (e.g. a caller built on a partial config) — preserve the
  // previous unconditional-global behavior rather than guessing.
  if (!multiAgent) return { scope: "global", scopeTarget: null };

  const agentId = currentAgentId || multiAgent.orchestratorId;
  const isOrchestrator = agentId === multiAgent.orchestratorId;

  if (
    multiAgent.strictAgentScoping &&
    !currentAgentId &&
    (multiAgent.defaultStoreScope === "agent" || multiAgent.defaultStoreScope === "auto")
  ) {
    warn?.(
      `memory-hybrid: Agent detection failed (currentAgentId is null) and multiAgent.strictAgentScoping is enabled. ` +
        `Cannot auto-determine scope for defaultStoreScope="${multiAgent.defaultStoreScope}" — falling back to orchestrator scope for this write.`,
    );
  }

  if (multiAgent.defaultStoreScope === "global") {
    return { scope: "global", scopeTarget: null };
  }
  if (multiAgent.defaultStoreScope === "agent") {
    return { scope: "agent", scopeTarget: agentId };
  }
  if (isOrchestrator) {
    return { scope: "global", scopeTarget: null };
  }
  return { scope: "agent", scopeTarget: agentId };
}
