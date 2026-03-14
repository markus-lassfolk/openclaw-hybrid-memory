/**
 * Session state for the lifecycle pipeline (Phase 2.3).
 * Creates per-session maps and helpers: touchSession, clearSessionState, pruneSessionMaps, resolveSessionKey.
 */

import type { SessionSeenFacts } from "../services/ambient-retrieval.js";
import type { FrustrationConversationTurn } from "../services/frustration-detector.js";
import type { SessionState } from "./types.js";

const MAX_TRACKED_SESSIONS = 200;

export function createSessionState(): SessionState {
  const authFailureRecallsThisSession = new Map<string, number>();
  const sessionStartSeen = new Set<string>();
  const frustrationStateMap = new Map<string, { level: number; turns: FrustrationConversationTurn[] }>();
  const ambientSeenFactsMap = new Map<string, SessionSeenFacts>();
  const ambientLastEmbeddingMap = new Map<string, number[] | null>();
  const sessionLastActivity = new Map<string, number>();

  function touchSession(sessionKey: string): void {
    sessionLastActivity.set(sessionKey, Date.now());
  }

  function clearSessionState(sessionKey: string): void {
    sessionStartSeen.delete(sessionKey);
    ambientSeenFactsMap.delete(sessionKey);
    ambientLastEmbeddingMap.delete(sessionKey);
    frustrationStateMap.delete(sessionKey);
    sessionLastActivity.delete(sessionKey);
    const prefix = `${sessionKey}:`;
    for (const key of authFailureRecallsThisSession.keys()) {
      if (key.startsWith(prefix)) authFailureRecallsThisSession.delete(key);
    }
  }

  function pruneSessionMaps(): void {
    if (ambientSeenFactsMap.size > MAX_TRACKED_SESSIONS) {
      const excess = ambientSeenFactsMap.size - MAX_TRACKED_SESSIONS;
      const keys = ambientSeenFactsMap.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) {
          ambientSeenFactsMap.delete(value);
          ambientLastEmbeddingMap.delete(value);
        }
      }
    }
    if (frustrationStateMap.size > MAX_TRACKED_SESSIONS) {
      const excess = frustrationStateMap.size - MAX_TRACKED_SESSIONS;
      const keys = frustrationStateMap.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) frustrationStateMap.delete(value);
      }
    }
    if (sessionStartSeen.size > MAX_TRACKED_SESSIONS) {
      const excess = sessionStartSeen.size - MAX_TRACKED_SESSIONS;
      const keys = sessionStartSeen.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) sessionStartSeen.delete(value);
      }
    }
    if (authFailureRecallsThisSession.size > MAX_TRACKED_SESSIONS * 3) {
      const excess = authFailureRecallsThisSession.size - MAX_TRACKED_SESSIONS * 3;
      const keys = authFailureRecallsThisSession.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) authFailureRecallsThisSession.delete(value);
      }
    }
    if (sessionLastActivity.size > MAX_TRACKED_SESSIONS) {
      const excess = sessionLastActivity.size - MAX_TRACKED_SESSIONS;
      const keys = sessionLastActivity.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) sessionLastActivity.delete(value);
      }
    }
  }

  function resolveSessionKey(event: unknown, api?: { context?: { sessionId?: string } }): string | null {
    const ev = event as { session?: Record<string, unknown>; sessionKey?: string };
    const sessionId =
      ev?.session?.id ??
      ev?.session?.sessionId ??
      ev?.session?.key ??
      ev?.session?.label ??
      ev?.sessionKey ??
      api?.context?.sessionId ??
      null;
    return sessionId ? String(sessionId) : null;
  }

  const clearAll = (): void => {
    sessionStartSeen.clear();
    ambientSeenFactsMap.clear();
    ambientLastEmbeddingMap.clear();
    frustrationStateMap.clear();
    authFailureRecallsThisSession.clear();
    sessionLastActivity.clear();
  };

  return {
    sessionStartSeen,
    ambientSeenFactsMap,
    ambientLastEmbeddingMap,
    frustrationStateMap,
    authFailureRecallsThisSession,
    sessionLastActivity,
    touchSession,
    clearSessionState,
    pruneSessionMaps,
    resolveSessionKey,
    MAX_TRACKED_SESSIONS,
    clearAll,
  };
}
