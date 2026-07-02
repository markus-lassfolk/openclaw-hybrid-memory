/**
 * Session state for the lifecycle pipeline (Phase 2.3).
 * Creates per-session maps and helpers: touchSession, clearSessionState, pruneSessionMaps, resolveSessionKey.
 *
 * Typed-hook identity (`PluginHookAgentContext`) is merged into `api` at the dispatcher via
 * `withHookResolutionApi` in `hook-resolution-api.ts` (#1005).
 */

import type { SessionSeenFacts } from "../services/ambient-retrieval.js";
import type { FrustrationConversationTurn } from "../services/frustration-detector.js";
import { clearIntentSessionCache } from "../services/intent-classifier.js";
import { clearNudgeSessionState } from "../services/memory-nudge.js";
import type { SessionState } from "./types.js";

const MAX_TRACKED_SESSIONS = 200;

/** Insertion-order eviction fallback: trims a Map down to `limit` entries, oldest-inserted first. */
function pruneMapToLimit<K, V>(map: Map<K, V>, limit: number): void {
  if (map.size <= limit) return;
  const excess = map.size - limit;
  const keys = map.keys();
  for (let i = 0; i < excess; i++) {
    const { value } = keys.next();
    if (value !== undefined) map.delete(value);
  }
}

/** Insertion-order eviction fallback: trims a Set down to `limit` entries, oldest-inserted first. */
function pruneSetToLimit<T>(set: Set<T>, limit: number): void {
  if (set.size <= limit) return;
  const excess = set.size - limit;
  const values = set.values();
  for (let i = 0; i < excess; i++) {
    const { value } = values.next();
    if (value !== undefined) set.delete(value);
  }
}

/** API slice used when resolving the current session key from a hook event (#990). */
export type SessionKeyHookApi = { context?: { sessionId?: string; sessionKey?: string } };

/**
 * Best-effort session key string for lifecycle hooks — same precedence as
 * {@link createSessionState}'s `resolveSessionKey` (exported for agent id parsing and tests).
 *
 * **Precedence (first hit wins):** `event.session` / top-level session-ish fields /
 * `event.context`, then `api.context.sessionId`, then `api.context.sessionKey`.
 * Callers pass `withHookResolutionApi(api, hookCtx)` so hook `sessionId`/`sessionKey` land on
 * `api.context` and are consulted only after the event payload (#1005).
 */
export function resolveSessionKeyFromHookEvent(event: unknown, api?: SessionKeyHookApi): string | null {
  const ev = event as {
    session?: Record<string, unknown>;
    sessionKey?: string;
    context?: Record<string, unknown>;
  };
  const payloadCtx = ev?.context;
  const sessionId =
    ev?.session?.id ??
    ev?.session?.sessionId ??
    ev?.session?.key ??
    ev?.session?.label ??
    ev?.sessionKey ??
    (payloadCtx?.sessionId as string | undefined) ??
    (payloadCtx?.sessionKey as string | undefined) ??
    (payloadCtx?.key as string | undefined) ??
    (payloadCtx?.id as string | undefined) ??
    (payloadCtx?.label as string | undefined) ??
    api?.context?.sessionId ??
    api?.context?.sessionKey ??
    null;
  return sessionId ? String(sessionId) : null;
}

export function createSessionState(
  progressiveIndexBySession?: Map<string, string[]>,
  lastAutoRecallPromptBySession?: Map<string, string>,
): SessionState {
  const authFailureRecallsThisSession = new Map<string, number>();
  const sessionStartSeen = new Set<string>();
  const frustrationStateMap = new Map<string, { level: number; turns: FrustrationConversationTurn[] }>();
  const frustrationThresholdBandMap = new Map<string, "none" | "medium" | "high" | "critical">();
  const changeNotifyStateMap = new Map<string, { lastNotifiedOrdinal: number; lastNotifiedBroadcastOrdinal: number }>();
  const displayRevertMap = new Map<string, Map<number, string>>();
  const ambientSeenFactsMap = new Map<string, SessionSeenFacts>();
  const ambientLastEmbeddingMap = new Map<string, number[] | null>();
  const sessionLastActivity = new Map<string, number>();
  const capabilityHintsSessionsSeen = new Set<string>();
  const recallInFlightBySession = new Map<string, number>();
  const pendingCheckpointGuardBySession = new Map<string, string>();

  function touchSession(sessionKey: string): void {
    sessionLastActivity.set(sessionKey, Date.now());
  }

  function clearSessionState(sessionKey: string): void {
    sessionStartSeen.delete(sessionKey);
    ambientSeenFactsMap.delete(sessionKey);
    ambientLastEmbeddingMap.delete(sessionKey);
    frustrationStateMap.delete(sessionKey);
    frustrationThresholdBandMap.delete(sessionKey);
    changeNotifyStateMap.delete(sessionKey);
    displayRevertMap.delete(sessionKey);
    sessionLastActivity.delete(sessionKey);
    // Do NOT clear capabilityHintsSessionsSeen here — that set persists across agent turns
    // within the same chat session so "session" mode injects once per chat, not once per turn.
    const prefix = `${sessionKey}:`;
    for (const key of authFailureRecallsThisSession.keys()) {
      if (key.startsWith(prefix)) authFailureRecallsThisSession.delete(key);
    }
    recallInFlightBySession.delete(sessionKey);
    pendingCheckpointGuardBySession.delete(sessionKey);
    progressiveIndexBySession?.delete(sessionKey);
    lastAutoRecallPromptBySession?.delete(sessionKey);
    clearIntentSessionCache(sessionKey);
    clearNudgeSessionState(sessionKey);
  }

  function clearInjectedFactIdsForSession(
    injectedFactIdsBySession: Map<string, Set<string>> | undefined,
    sessionKey: string,
  ): void {
    injectedFactIdsBySession?.delete(sessionKey);
  }

  function pruneSessionMaps(injectedFactIdsBySession?: Map<string, Set<string>>): void {
    // Recency-based, single-decision eviction for every session-keyed map declared in this
    // closure. touchSession() does `sessionLastActivity.set(key, Date.now())`, which updates the
    // value on an existing key WITHOUT moving it in Map iteration order (insertion order is
    // unaffected by re-setting an existing key, per the JS Map spec) — pruning each map
    // independently by its own `.keys()` iteration order therefore evicted oldest-INSERTED
    // sessions, not least-recently-ACTIVE ones, letting a still-hot session be evicted ahead of
    // an idle one. touchSession is called once per turn (stage-setup.ts, the first stage in the
    // pipeline) for every session that reaches any of these maps, so sessionLastActivity's
    // timestamps are the correct source of recency truth for all of them. Sorting by that value
    // once and applying the same eviction set everywhere also fixes a separate bug: several maps
    // (frustrationThresholdBandMap, changeNotifyStateMap, displayRevertMap,
    // recallInFlightBySession, pendingCheckpointGuardBySession) were never pruned at all here —
    // only clearSessionState()/clearAll() ever touched them — so a session whose
    // sessionLastActivity entry got evicted by the old logic became permanently invisible to
    // sweepStaleSessions (which iterates sessionLastActivity to find stale keys), leaking those
    // maps' entries for that session forever in a long-running gateway.
    if (sessionLastActivity.size > MAX_TRACKED_SESSIONS) {
      const excess = sessionLastActivity.size - MAX_TRACKED_SESSIONS;
      const staleKeys = [...sessionLastActivity.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, excess)
        .map(([key]) => key);
      for (const key of staleKeys) {
        sessionLastActivity.delete(key);
        ambientSeenFactsMap.delete(key);
        ambientLastEmbeddingMap.delete(key);
        frustrationStateMap.delete(key);
        frustrationThresholdBandMap.delete(key);
        changeNotifyStateMap.delete(key);
        displayRevertMap.delete(key);
        sessionStartSeen.delete(key);
        capabilityHintsSessionsSeen.delete(key);
        recallInFlightBySession.delete(key);
        pendingCheckpointGuardBySession.delete(key);
        const prefix = `${key}:`;
        for (const k of authFailureRecallsThisSession.keys()) {
          if (k.startsWith(prefix)) authFailureRecallsThisSession.delete(k);
        }
        progressiveIndexBySession?.delete(key);
        lastAutoRecallPromptBySession?.delete(key);
        injectedFactIdsBySession?.delete(key);
      }
    }
    // Independent safety net: authFailureRecallsThisSession uses composite `${sessionKey}:...`
    // keys that aren't 1:1 with sessionLastActivity entries, so a single session could still
    // accumulate many of them; keep its own higher cap as a backstop.
    if (authFailureRecallsThisSession.size > MAX_TRACKED_SESSIONS * 3) {
      const excess = authFailureRecallsThisSession.size - MAX_TRACKED_SESSIONS * 3;
      const keys = authFailureRecallsThisSession.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) authFailureRecallsThisSession.delete(value);
      }
    }
    // Independent per-map fallbacks: the coordinated eviction above only fires once
    // sessionLastActivity itself exceeds the cap, so a map populated without a matching
    // touchSession() call (or driven past the limit faster than sessionLastActivity) would
    // otherwise grow unbounded. Every session-keyed map gets its own insertion-order cap as a
    // defensive backstop, in addition to the recency-correct coordinated eviction above.
    pruneMapToLimit(ambientSeenFactsMap, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(ambientLastEmbeddingMap, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(frustrationStateMap, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(frustrationThresholdBandMap, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(changeNotifyStateMap, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(displayRevertMap, MAX_TRACKED_SESSIONS);
    pruneSetToLimit(sessionStartSeen, MAX_TRACKED_SESSIONS);
    pruneSetToLimit(capabilityHintsSessionsSeen, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(recallInFlightBySession, MAX_TRACKED_SESSIONS);
    pruneMapToLimit(pendingCheckpointGuardBySession, MAX_TRACKED_SESSIONS);
    if (progressiveIndexBySession) pruneMapToLimit(progressiveIndexBySession, MAX_TRACKED_SESSIONS);
    if (lastAutoRecallPromptBySession) pruneMapToLimit(lastAutoRecallPromptBySession, MAX_TRACKED_SESSIONS);
    if (injectedFactIdsBySession) pruneMapToLimit(injectedFactIdsBySession, MAX_TRACKED_SESSIONS);
  }

  function resolveSessionKey(event: unknown, api?: SessionKeyHookApi): string | null {
    return resolveSessionKeyFromHookEvent(event, api);
  }

  const clearAll = (injectedFactIdsBySession?: Map<string, Set<string>>): void => {
    sessionStartSeen.clear();
    ambientSeenFactsMap.clear();
    ambientLastEmbeddingMap.clear();
    frustrationStateMap.clear();
    frustrationThresholdBandMap.clear();
    changeNotifyStateMap.clear();
    displayRevertMap.clear();
    authFailureRecallsThisSession.clear();
    sessionLastActivity.clear();
    capabilityHintsSessionsSeen.clear();
    recallInFlightBySession.clear();
    pendingCheckpointGuardBySession.clear();
    progressiveIndexBySession?.clear();
    lastAutoRecallPromptBySession?.clear();
    injectedFactIdsBySession?.clear();
  };

  return {
    sessionStartSeen,
    ambientSeenFactsMap,
    ambientLastEmbeddingMap,
    frustrationStateMap,
    frustrationThresholdBandMap,
    changeNotifyStateMap,
    displayRevertMap,
    authFailureRecallsThisSession,
    sessionLastActivity,
    capabilityHintsSessionsSeen,
    recallInFlightBySession,
    pendingCheckpointGuardBySession,
    touchSession,
    clearSessionState,
    clearInjectedFactIdsForSession,
    pruneSessionMaps,
    resolveSessionKey,
    MAX_TRACKED_SESSIONS,
    clearAll,
  };
}
