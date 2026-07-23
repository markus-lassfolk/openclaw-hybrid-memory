/**
 * Permission-scoped Dream session attachment (#2174).
 *
 * Fail closed: unresolved ACL → exclude. Personal mode may treat all as one boundary.
 */

import type { DreamPermissionBoundary } from "../config/types/dreaming.js";

export type DreamSessionAcl = {
  sessionId: string;
  /** Effective ACL / scope of the transcript content. */
  effectiveScope: "session" | "agent" | "user" | "global";
  /** Optional agent / user owners for cross-agent checks. */
  agentId?: string | null;
  userId?: string | null;
};

const SCOPE_RANK: Record<DreamSessionAcl["effectiveScope"], number> = {
  session: 0,
  agent: 1,
  user: 2,
  global: 3,
};

/** True when session ACL is ⊆ target (session ⊆ agent ⊆ user ⊆ global). */
export function aclFitsTarget(
  sessionScope: DreamSessionAcl["effectiveScope"],
  targetScope: DreamPermissionBoundary["targetScope"],
): boolean {
  return SCOPE_RANK[sessionScope] <= SCOPE_RANK[targetScope];
}

export type SelectDreamSessionsResult = {
  included: string[];
  excluded: Array<{ sessionId: string; reason: string }>;
};

/**
 * Select sessions that may be attached to a Dream for the given permission boundary.
 */
export function selectDreamSessions(
  candidates: Array<DreamSessionAcl | { sessionId: string; effectiveScope?: string | null }>,
  boundary: DreamPermissionBoundary,
  maxSessions: number,
): SelectDreamSessionsResult {
  const included: string[] = [];
  const excluded: Array<{ sessionId: string; reason: string }> = [];
  const cap = Math.max(1, Math.min(100, Math.floor(maxSessions)));

  if (boundary.personalMode || !boundary.enforce) {
    for (const c of candidates) {
      if (included.length >= cap) {
        excluded.push({ sessionId: c.sessionId, reason: "max_sessions" });
        continue;
      }
      included.push(c.sessionId);
    }
    return { included, excluded };
  }

  for (const c of candidates) {
    if (included.length >= cap) {
      excluded.push({ sessionId: c.sessionId, reason: "max_sessions" });
      continue;
    }
    const scope = c.effectiveScope;
    if (scope !== "session" && scope !== "agent" && scope !== "user" && scope !== "global") {
      excluded.push({ sessionId: c.sessionId, reason: "unresolved_acl" });
      continue;
    }
    if (!aclFitsTarget(scope, boundary.targetScope)) {
      excluded.push({
        sessionId: c.sessionId,
        reason: `acl_${scope}_not_subseteq_${boundary.targetScope}`,
      });
      continue;
    }
    included.push(c.sessionId);
  }

  return { included, excluded };
}
