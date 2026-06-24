/**
 * SQL fragments for memory scope filtering (Issue #954).
 * ⚠️ SECURITY: Callers MUST derive scope filter values from trusted runtime identity.
 */
import type { SQLInputValue } from "node:sqlite";

import type { MemoryScope, ScopeFilter } from "../../types/memory.js";

/** True when a scoped row is visible under the caller's scope filter (global always visible). */
export function scopedRowMatchesFilter(
  scope: MemoryScope | null | undefined,
  scopeTarget: string | null | undefined,
  filter: ScopeFilter | null | undefined,
): boolean {
  const effectiveScope = scope ?? "global";
  if (effectiveScope === "global") return true;
  if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
    return false;
  }
  const target = scopeTarget ?? null;
  return (
    (effectiveScope === "user" && (filter.userId ?? null) === target) ||
    (effectiveScope === "agent" && (filter.agentId ?? null) === target) ||
    (effectiveScope === "session" && (filter.sessionId ?? null) === target)
  );
}

/** Scope SQL for episode causal candidate queries: global-only source → global candidates; scoped → global + compatible scope. */
export function episodeCandidateScopeClause(episode: { scope?: MemoryScope | null; scopeTarget?: string | null }): {
  clause: string;
  params: SQLInputValue[];
} {
  const scope = episode.scope ?? "global";
  if (scope === "global") {
    return { clause: " AND scope = 'global'", params: [] };
  }
  const filter: ScopeFilter =
    scope === "user"
      ? { userId: episode.scopeTarget ?? null }
      : scope === "agent"
        ? { agentId: episode.scopeTarget ?? null }
        : { sessionId: episode.scopeTarget ?? null };
  return scopeFilterClausePositional(filter);
}

/** Positional scope clause for a table alias (e.g. f_new, f_old). */
export function scopeFilterClauseForAlias(
  filter: ScopeFilter | null | undefined,
  alias: string,
): { clause: string; params: SQLInputValue[] } {
  if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
    return { clause: "", params: [] };
  }
  const parts: string[] = ["("];
  parts.push(`${alias}.scope = 'global'`);
  const params: SQLInputValue[] = [];
  if (filter.userId) {
    parts.push(`OR (${alias}.scope = 'user' AND ${alias}.scope_target = ?)`);
    params.push(filter.userId);
  }
  if (filter.agentId) {
    parts.push(`OR (${alias}.scope = 'agent' AND ${alias}.scope_target = ?)`);
    params.push(filter.agentId);
  }
  if (filter.sessionId) {
    parts.push(`OR (${alias}.scope = 'session' AND ${alias}.scope_target = ?)`);
    params.push(filter.sessionId);
  }
  parts.push(")");
  return { clause: ` AND ${parts.join(" ")}`, params };
}

/** Named params @scopeUserId, @scopeAgentId, @scopeSessionId. */
export function scopeFilterClauseNamed(filter: ScopeFilter | null | undefined): {
  clause: string;
  params: Record<string, unknown>;
} {
  if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
    return { clause: "", params: {} };
  }
  const parts: string[] = ["("];
  parts.push("scope = 'global'");
  const params: Record<string, unknown> = {};
  if (filter.userId) {
    parts.push("OR (scope = 'user' AND scope_target = @scopeUserId)");
    params["@scopeUserId"] = filter.userId;
  }
  if (filter.agentId) {
    parts.push("OR (scope = 'agent' AND scope_target = @scopeAgentId)");
    params["@scopeAgentId"] = filter.agentId;
  }
  if (filter.sessionId) {
    parts.push("OR (scope = 'session' AND scope_target = @scopeSessionId)");
    params["@scopeSessionId"] = filter.sessionId;
  }
  parts.push(")");
  return { clause: `AND ${parts.join(" ")}`, params };
}

/** Positional params (for lookup/getAll). */
export function scopeFilterClausePositional(filter: ScopeFilter | null | undefined): {
  clause: string;
  params: SQLInputValue[];
} {
  if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
    return { clause: "", params: [] };
  }
  const parts: string[] = ["("];
  parts.push("scope = 'global'");
  const params: SQLInputValue[] = [];
  if (filter.userId) {
    parts.push("OR (scope = 'user' AND scope_target = ?)");
    params.push(filter.userId);
  }
  if (filter.agentId) {
    parts.push("OR (scope = 'agent' AND scope_target = ?)");
    params.push(filter.agentId);
  }
  if (filter.sessionId) {
    parts.push("OR (scope = 'session' AND scope_target = ?)");
    params.push(filter.sessionId);
  }
  parts.push(")");
  return { clause: ` AND ${parts.join(" ")}`, params };
}
