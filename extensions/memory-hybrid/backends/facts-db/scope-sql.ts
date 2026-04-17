/**
 * SQL fragments for memory scope filtering (Issue #954).
 * ⚠️ SECURITY: Callers MUST derive scope filter values from trusted runtime identity.
 */
import type { SQLInputValue } from "node:sqlite";

import type { ScopeFilter } from "../../types/memory.js";

/** Named params @scopeUserId, @scopeAgentId, @scopeSessionId. */
export function scopeFilterClauseNamed(
	filter: ScopeFilter | null | undefined,
): {
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
export function scopeFilterClausePositional(
	filter: ScopeFilter | null | undefined,
): {
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
