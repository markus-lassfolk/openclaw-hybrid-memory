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
    sessionLastActivity.delete(sessionKey);
    // Do NOT clear frustrationStateMap/frustrationThresholdBandMap/changeNotifyStateMap/
    // displayRevertMap/sessionStartSeen/ambientSeenFactsMap/ambientLastEmbeddingMap/
    // authFailureRecallsThisSession here, for the same reason capabilityHintsSessionsSeen and
    // memory-nudge state are excluded below: clearSessionState runs at the end of EVERY agent
    // turn (see run-capture.ts), not once per chat session. All of these carry state that is
    // meant to persist across the whole chat, not reset every turn:
    //   - frustrationStateMap / frustrationThresholdBandMap: frustration-detector.ts's
    //     multi-turn windowed/decay trend ("rising"/"falling") needs turns to accumulate across
    //     calls; clearing it every turn caps detection at whatever a single isolated message
    //     scores and the "rising" escalation band can never fire.
    //   - changeNotifyStateMap: tracks the last-notified ordinal so a still-active change event
    //     is announced once, not re-injected into every subsequent turn's context.
    //   - displayRevertMap: maps the ephemeral "revert change N" display position (renumbered
    //     each time a notice is built) back to a real change-event id; clearing it before the
    //     user's next turn means "revert change N" can silently resolve to a different event via
    //     change-feed-revert.ts's ordinal fallback instead of the one actually displayed.
    //   - sessionStartSeen: gates autoRecall.retrievalDirectives.sessionStart to fire once per
    //     chat session; clearing it every turn made the one-time directive re-fire every turn.
    //   - ambientSeenFactsMap / ambientLastEmbeddingMap: SessionSeenFacts' cross-turn dedup of
    //     already-injected ambient facts after a topic shift; clearing it every turn made the
    //     same facts eligible to be re-injected turn after turn.
    //   - authFailureRecallsThisSession: caps credential-hint recalls per target across the whole
    //     session (autoRecall.authFailure.maxRecallsPerTarget); clearing it every turn meant the
    //     cap never engaged past a single turn, re-injecting the same hint every subsequent turn.
    // pruneSessionMaps' recency-based coordinated eviction (keyed off sessionLastActivity,
    // touched once per turn in stage-setup.ts) plus its own per-map insertion-order backstop
    // now bound all of these, so per-turn clearing here is no longer needed for size control either.
    //
    // Do NOT clear capabilityHintsSessionsSeen here — that set persists across agent turns
    // within the same chat session so "session" mode injects once per chat, not once per turn.
    // Do NOT clear memory-nudge state here either, for the same reason: clearSessionState runs
    // at the end of EVERY agent turn (see run-capture.ts), not once per session, but
    // recordNudgeEmission's timestamp is meant to persist across turns to enforce
    // nudge.throttleHours — clearing it here would reset the throttle every turn, so the nudge
    // would re-fire on every single turn instead of at most once per throttle window.
    // services/memory-nudge.ts's own sweepStaleNudgeSessionState (TTL-based) and
    // disposeMemoryNudge (plugin shutdown) handle cleanup of this state instead.
    recallInFlightBySession.delete(sessionKey);
    pendingCheckpointGuardBySession.delete(sessionKey);
    progressiveIndexBySession?.delete(sessionKey);
    lastAutoRecallPromptBySession?.delete(sessionKey);
    clearIntentSessionCache(sessionKey);
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
