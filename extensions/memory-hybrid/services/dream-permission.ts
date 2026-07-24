/**
 * Permission-scoped Dream session attachment (#2174).
 *
 * Fail closed: unresolved ACL → exclude.
 * Private content must not feed a wider dream target by default:
 * content is attachable only when it is at least as public as the dream target
 * (SCOPE_RANK[source] >= SCOPE_RANK[target]), or personalMode is on.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DreamPermissionBoundary } from "../config/types/dreaming.js";
import { locateSessionTranscriptSync } from "./openclaw-session-artifact.js";

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

/** Candidate for attachment; `effectiveScope` may be unresolved (null) → fail closed at select. */
export type DreamSessionAclCandidate = {
  sessionId: string;
  effectiveScope?: string | null;
  agentId?: string | null;
};

function asDreamWriteScope(raw: string | null | undefined): DreamWriteScope | null {
  return raw === "session" || raw === "agent" || raw === "user" || raw === "global" ? raw : null;
}

function morePrivate(a: DreamWriteScope, b: DreamWriteScope): DreamWriteScope {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

/**
 * Resolve effective transcript ACL for a session (#2174).
 *
 * Rules (fail closed — never invent `global` from fact writes alone):
 * - Session/agent/user-scoped facts for this session contribute that scope (most private wins).
 * - `scope=global` facts only prove the session existed; they do **not** mark the transcript public.
 * - If still unresolved and a JSONL exists under `agents/<id>/sessions/`, floor to `agent`.
 * - Otherwise leave null → `selectDreamSessions` excludes as `unresolved_acl`.
 * - Explicit CLI `--session-scopes id:global` remains the upgrade path for global attachment.
 */
export function resolveSessionEffectiveAcl(
  scopesSeen: Array<string | null | undefined>,
  sessionId: string,
  opts?: { openclawHome?: string; resolveArtifact?: boolean },
): { effectiveScope: DreamWriteScope | null; agentId?: string | null } {
  let resolved: DreamWriteScope | null = null;
  for (const raw of scopesSeen) {
    const scope = asDreamWriteScope(raw);
    // Never treat global fact writes as proof the transcript ACL is global.
    if (!scope || scope === "global") continue;
    resolved = resolved ? morePrivate(resolved, scope) : scope;
  }

  if (resolved) return { effectiveScope: resolved };

  if (opts?.resolveArtifact === false) {
    return { effectiveScope: null };
  }

  const hit = locateSessionTranscriptSync(sessionId, opts?.openclawHome);
  if (hit) return { effectiveScope: "agent", agentId: hit.agentId };

  return { effectiveScope: null };
}

/**
 * Discover recent session ids + effective ACL for nightly Dream (#2174).
 * Prefer provenance_session; fall back to session-scoped scope_target.
 */
export function discoverDreamSessionAcls(
  db: DatabaseSync,
  opts?: {
    lookbackDays?: number;
    limit?: number;
    nowSec?: number;
    openclawHome?: string;
    resolveArtifact?: boolean;
  },
): DreamSessionAclCandidate[] {
  const lookbackDays = Math.max(1, Math.min(90, Math.floor(opts?.lookbackDays ?? 7)));
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 40)));
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - lookbackDays * 24 * 3600;

  type Row = {
    session_id: string | null;
    scope: string | null;
  };

  let rows: Row[] = [];
  try {
    rows = db
      .prepare(
        `SELECT
           COALESCE(
             NULLIF(provenance_session, ''),
             CASE WHEN scope = 'session' THEN scope_target ELSE NULL END
           ) AS session_id,
           scope
         FROM facts
         WHERE created_at >= ?
           AND superseded_at IS NULL
           AND (
             (provenance_session IS NOT NULL AND provenance_session != '')
             OR (scope = 'session' AND scope_target IS NOT NULL AND scope_target != '')
           )
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceSec, limit * 4) as Row[];
  } catch {
    return [];
  }

  const scopesBySession = new Map<string, Array<string | null>>();
  for (const row of rows) {
    const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
    if (!sessionId) continue;
    const list = scopesBySession.get(sessionId) ?? [];
    list.push(row.scope);
    scopesBySession.set(sessionId, list);
  }

  const out: DreamSessionAclCandidate[] = [];
  for (const [sessionId, scopes] of scopesBySession) {
    const resolved = resolveSessionEffectiveAcl(scopes, sessionId, {
      openclawHome: opts?.openclawHome,
      resolveArtifact: opts?.resolveArtifact,
    });
    out.push({
      sessionId,
      effectiveScope: resolved.effectiveScope,
      agentId: resolved.agentId ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}
