/**
 * Permission-scoped Dream session attachment (#2174).
 *
 * Fail closed: unresolved ACL → exclude.
 * Private content must not feed a wider dream target by default:
 * content is attachable only when it is at least as public as the dream target
 * (SCOPE_RANK[source] >= SCOPE_RANK[target]), or personalMode is on.
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

export type DreamWriteScope = DreamSessionAcl["effectiveScope"];

const SCOPE_RANK: Record<DreamWriteScope, number> = {
  session: 0,
  agent: 1,
  user: 2,
  global: 3,
};

/**
 * True when transcript content may be attached to a dream targeting `targetScope`.
 * More-private sources (lower rank) cannot feed more-public dreams (higher rank).
 */
export function aclFitsTarget(
  sessionScope: DreamWriteScope,
  targetScope: DreamPermissionBoundary["targetScope"],
  personalMode = false,
): boolean {
  if (personalMode) return true;
  return SCOPE_RANK[sessionScope] >= SCOPE_RANK[targetScope];
}

/** True when a candidate write scope does not exceed the dream permission boundary. */
export function writeScopeWithinBoundary(
  writeScope: string | null | undefined,
  boundary: DreamPermissionBoundary,
): boolean {
  if (boundary.personalMode || !boundary.enforce) return true;
  const scope =
    writeScope === "session" || writeScope === "agent" || writeScope === "user" || writeScope === "global"
      ? writeScope
      : "global";
  // Writes may only target scopes ≤ dream target (session write into global dream is OK;
  // global write into session dream is not).
  return SCOPE_RANK[scope] <= SCOPE_RANK[boundary.targetScope];
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

  if (!boundary.enforce) {
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
    if (!aclFitsTarget(scope, boundary.targetScope, boundary.personalMode)) {
      excluded.push({
        sessionId: c.sessionId,
        reason: `acl_${scope}_too_private_for_${boundary.targetScope}`,
      });
      continue;
    }
    included.push(c.sessionId);
  }

  return { included, excluded };
}
