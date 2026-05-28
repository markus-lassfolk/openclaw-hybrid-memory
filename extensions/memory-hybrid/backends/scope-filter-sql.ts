import type { ScopeFilter } from "../types/memory.js";

export function normalizeScopeValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hasAnyScopeFilter(scopeFilter?: ScopeFilter): boolean {
  return Boolean(
    normalizeScopeValue(scopeFilter?.userId) ||
      normalizeScopeValue(scopeFilter?.agentId) ||
      normalizeScopeValue(scopeFilter?.sessionId),
  );
}

export function buildExactScopeWhereClause(scopeFilter?: ScopeFilter): {
  whereClause: string;
  andClause: string;
  params: string[];
} {
  const userId = normalizeScopeValue(scopeFilter?.userId);
  const agentId = normalizeScopeValue(scopeFilter?.agentId);
  const sessionId = normalizeScopeValue(scopeFilter?.sessionId);
  if (!userId && !agentId && !sessionId) {
    return { whereClause: "", andClause: "", params: [] };
  }
  const clauses: string[] = [];
  const params: string[] = [];
  if (userId) {
    clauses.push("scope_user_id = ?");
    params.push(userId);
  } else {
    clauses.push("scope_user_id IS NULL");
  }
  if (agentId) {
    clauses.push("scope_agent_id = ?");
    params.push(agentId);
  } else {
    clauses.push("scope_agent_id IS NULL");
  }
  if (sessionId) {
    clauses.push("scope_session_id = ?");
    params.push(sessionId);
  } else {
    clauses.push("scope_session_id IS NULL");
  }
  const condition = clauses.join(" AND ");
  return {
    whereClause: ` WHERE ${condition}`,
    andClause: ` AND ${condition}`,
    params,
  };
}
