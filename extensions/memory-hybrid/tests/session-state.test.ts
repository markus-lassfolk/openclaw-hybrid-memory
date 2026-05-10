import { describe, expect, it, beforeEach } from "vitest";
import { createSessionState, resolveSessionKeyFromHookEvent } from "../lifecycle/session-state.js";
import { SessionSeenFacts } from "../services/ambient-retrieval.js";

describe("session-state", () => {
  describe("resolveSessionKeyFromHookEvent", () => {
    describe("Session key resolution precedence", () => {
      it("should resolve from event.session.id", () => {
        const event = { session: { id: "session-123" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("session-123");
      });

      it("should resolve from event.session.sessionId", () => {
        const event = { session: { sessionId: "session-456" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("session-456");
      });

      it("should resolve from event.session.key", () => {
        const event = { session: { key: "session-key-789" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("session-key-789");
      });

      it("should resolve from event.session.label", () => {
        const event = { session: { label: "session-label-abc" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("session-label-abc");
      });

      it("should resolve from event.sessionKey", () => {
        const event = { sessionKey: "top-level-key" };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("top-level-key");
      });

      it("should resolve from event.context.sessionId", () => {
        const event = { context: { sessionId: "context-session-id" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("context-session-id");
      });

      it("should resolve from event.context.sessionKey", () => {
        const event = { context: { sessionKey: "context-session-key" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("context-session-key");
      });

      it("should resolve from event.context.key", () => {
        const event = { context: { key: "context-key" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("context-key");
      });

      it("should resolve from event.context.id", () => {
        const event = { context: { id: "context-id" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("context-id");
      });

      it("should resolve from event.context.label", () => {
        const event = { context: { label: "context-label" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("context-label");
      });

      it("should resolve from api.context.sessionId when event has no session", () => {
        const event = {};
        const api = { context: { sessionId: "api-session-id" } };
        const result = resolveSessionKeyFromHookEvent(event, api);
        expect(result).toBe("api-session-id");
      });

      it("should resolve from api.context.sessionKey when event has no session", () => {
        const event = {};
        const api = { context: { sessionKey: "api-session-key" } };
        const result = resolveSessionKeyFromHookEvent(event, api);
        expect(result).toBe("api-session-key");
      });

      it("should prioritize event.session.id over api.context", () => {
        const event = { session: { id: "event-id" } };
        const api = { context: { sessionId: "api-id" } };
        const result = resolveSessionKeyFromHookEvent(event, api);
        expect(result).toBe("event-id");
      });

      it("should prioritize event.sessionKey over api.context", () => {
        const event = { sessionKey: "event-key" };
        const api = { context: { sessionKey: "api-key" } };
        const result = resolveSessionKeyFromHookEvent(event, api);
        expect(result).toBe("event-key");
      });

      it("should return null when no session key found", () => {
        const event = {};
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBeNull();
      });

      it("should return null when event is undefined", () => {
        const result = resolveSessionKeyFromHookEvent(undefined);
        expect(result).toBeNull();
      });

      it("should return null when event is null", () => {
        const result = resolveSessionKeyFromHookEvent(null);
        expect(result).toBeNull();
      });
    });

    describe("Type coercion", () => {
      it("should convert number session ID to string", () => {
        const event = { session: { id: 12345 } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("12345");
      });

      it("should handle empty string session ID", () => {
        const event = { session: { id: "" } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBeNull();
      });

      it("should handle object session ID", () => {
        const event = { session: { id: { toString: () => "object-id" } } };
        const result = resolveSessionKeyFromHookEvent(event);
        expect(result).toBe("object-id");
      });
    });
  });

  describe("createSessionState", () => {
    let state: ReturnType<typeof createSessionState>;

    beforeEach(() => {
      state = createSessionState();
    });

    describe("Initialization", () => {
      it("should create empty maps and sets", () => {
        expect(state.sessionStartSeen.size).toBe(0);
        expect(state.ambientSeenFactsMap.size).toBe(0);
        expect(state.ambientLastEmbeddingMap.size).toBe(0);
        expect(state.frustrationStateMap.size).toBe(0);
        expect(state.authFailureRecallsThisSession.size).toBe(0);
        expect(state.sessionLastActivity.size).toBe(0);
      });

      it("should expose MAX_TRACKED_SESSIONS constant", () => {
        expect(state.MAX_TRACKED_SESSIONS).toBe(200);
      });
    });

    describe("touchSession", () => {
      it("should record session activity timestamp", () => {
        const before = Date.now();
        state.touchSession("session-1");
        const after = Date.now();

        const timestamp = state.sessionLastActivity.get("session-1");
        expect(timestamp).toBeDefined();
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      });

      it("should update timestamp on subsequent touches", () => {
        state.touchSession("session-1");
        const firstTimestamp = state.sessionLastActivity.get("session-1")!;

        // Wait a bit
        const waitMs = 10;
        const waitUntil = Date.now() + waitMs;
        while (Date.now() < waitUntil) {
          // busy wait
        }

        state.touchSession("session-1");
        const secondTimestamp = state.sessionLastActivity.get("session-1")!;

        expect(secondTimestamp).toBeGreaterThan(firstTimestamp);
      });

      it("should track multiple sessions independently", () => {
        state.touchSession("session-1");
        state.touchSession("session-2");
        state.touchSession("session-3");

        expect(state.sessionLastActivity.size).toBe(3);
        expect(state.sessionLastActivity.has("session-1")).toBe(true);
        expect(state.sessionLastActivity.has("session-2")).toBe(true);
        expect(state.sessionLastActivity.has("session-3")).toBe(true);
      });
    });

    describe("clearSessionState", () => {
      it("should clear all state for a session", () => {
        // Populate state
        state.sessionStartSeen.add("session-1");
        state.ambientSeenFactsMap.set("session-1", new SessionSeenFacts());
        state.ambientLastEmbeddingMap.set("session-1", [1, 2, 3]);
        state.frustrationStateMap.set("session-1", { level: 2, turns: [] });
        state.sessionLastActivity.set("session-1", Date.now());
        state.authFailureRecallsThisSession.set("session-1:key1", 5);
        state.authFailureRecallsThisSession.set("session-1:key2", 3);

        // Clear
        state.clearSessionState("session-1");

        // Verify cleared
        expect(state.sessionStartSeen.has("session-1")).toBe(false);
        expect(state.ambientSeenFactsMap.has("session-1")).toBe(false);
        expect(state.ambientLastEmbeddingMap.has("session-1")).toBe(false);
        expect(state.frustrationStateMap.has("session-1")).toBe(false);
        expect(state.sessionLastActivity.has("session-1")).toBe(false);
        expect(state.authFailureRecallsThisSession.has("session-1:key1")).toBe(false);
        expect(state.authFailureRecallsThisSession.has("session-1:key2")).toBe(false);
      });

      it("should only clear state for specified session", () => {
        // Populate multiple sessions
        state.sessionStartSeen.add("session-1");
        state.sessionStartSeen.add("session-2");
        state.authFailureRecallsThisSession.set("session-1:key", 1);
        state.authFailureRecallsThisSession.set("session-2:key", 2);

        // Clear only session-1
        state.clearSessionState("session-1");

        // Verify session-2 still exists
        expect(state.sessionStartSeen.has("session-2")).toBe(true);
        expect(state.authFailureRecallsThisSession.has("session-2:key")).toBe(true);
      });

      it("should clear auth failure keys with session prefix", () => {
        state.authFailureRecallsThisSession.set("session-1:provider1", 1);
        state.authFailureRecallsThisSession.set("session-1:provider2", 2);
        state.authFailureRecallsThisSession.set("session-2:provider1", 3);

        state.clearSessionState("session-1");

        expect(state.authFailureRecallsThisSession.has("session-1:provider1")).toBe(false);
        expect(state.authFailureRecallsThisSession.has("session-1:provider2")).toBe(false);
        expect(state.authFailureRecallsThisSession.has("session-2:provider1")).toBe(true);
      });

      it("should handle clearing non-existent session", () => {
        // Should not throw
        expect(() => state.clearSessionState("non-existent")).not.toThrow();
      });
    });

    describe("pruneSessionMaps", () => {
      it("should prune ambient seen facts when exceeding limit", () => {
        // Add more than MAX_TRACKED_SESSIONS
        for (let i = 0; i < 250; i++) {
          state.ambientSeenFactsMap.set(`session-${i}`, new SessionSeenFacts());
        }

        state.pruneSessionMaps();

        expect(state.ambientSeenFactsMap.size).toBe(200);
      });

      it("should prune ambient embeddings when exceeding limit", () => {
        // Add more than MAX_TRACKED_SESSIONS
        for (let i = 0; i < 250; i++) {
          state.ambientSeenFactsMap.set(`session-${i}`, new SessionSeenFacts());
          state.ambientLastEmbeddingMap.set(`session-${i}`, [1, 2, 3]);
        }

        state.pruneSessionMaps();

        // Should prune down to 200
        expect(state.ambientLastEmbeddingMap.size).toBeLessThanOrEqual(200);
      });

      it("should prune frustration state when exceeding limit", () => {
        for (let i = 0; i < 250; i++) {
          state.frustrationStateMap.set(`session-${i}`, { level: 1, turns: [] });
        }

        state.pruneSessionMaps();

        expect(state.frustrationStateMap.size).toBe(200);
      });

      it("should prune session start seen when exceeding limit", () => {
        for (let i = 0; i < 250; i++) {
          state.sessionStartSeen.add(`session-${i}`);
        }

        state.pruneSessionMaps();

        expect(state.sessionStartSeen.size).toBe(200);
      });

      it("should prune auth failure recalls when exceeding 3x limit", () => {
        // Add more than MAX_TRACKED_SESSIONS * 3 (600)
        for (let i = 0; i < 700; i++) {
          state.authFailureRecallsThisSession.set(`key-${i}`, i);
        }

        state.pruneSessionMaps();

        expect(state.authFailureRecallsThisSession.size).toBe(600);
      });

      it("should prune session last activity when exceeding limit", () => {
        for (let i = 0; i < 250; i++) {
          state.sessionLastActivity.set(`session-${i}`, Date.now());
        }

        state.pruneSessionMaps();

        expect(state.sessionLastActivity.size).toBe(200);
      });

      it("should not prune when below limit", () => {
        // Add less than MAX_TRACKED_SESSIONS
        for (let i = 0; i < 50; i++) {
          state.ambientSeenFactsMap.set(`session-${i}`, new SessionSeenFacts());
        }

        state.pruneSessionMaps();

        expect(state.ambientSeenFactsMap.size).toBe(50);
      });

      it("should handle empty maps gracefully", () => {
        expect(() => state.pruneSessionMaps()).not.toThrow();
      });
    });

    describe("resolveSessionKey", () => {
      it("should delegate to resolveSessionKeyFromHookEvent", () => {
        const event = { session: { id: "test-session" } };
        const result = state.resolveSessionKey(event);
        expect(result).toBe("test-session");
      });

      it("should pass api parameter through", () => {
        const event = {};
        const api = { context: { sessionId: "api-session" } };
        const result = state.resolveSessionKey(event, api);
        expect(result).toBe("api-session");
      });
    });

    describe("clearAll", () => {
      it("should clear all maps and sets", () => {
        // Populate all collections
        state.sessionStartSeen.add("session-1");
        state.ambientSeenFactsMap.set("session-1", new SessionSeenFacts());
        state.ambientLastEmbeddingMap.set("session-1", [1, 2, 3]);
        state.frustrationStateMap.set("session-1", { level: 1, turns: [] });
        state.authFailureRecallsThisSession.set("key-1", 1);
        state.sessionLastActivity.set("session-1", Date.now());

        // Clear all
        state.clearAll?.();

        // Verify all cleared
        expect(state.sessionStartSeen.size).toBe(0);
        expect(state.ambientSeenFactsMap.size).toBe(0);
        expect(state.ambientLastEmbeddingMap.size).toBe(0);
        expect(state.frustrationStateMap.size).toBe(0);
        expect(state.authFailureRecallsThisSession.size).toBe(0);
        expect(state.sessionLastActivity.size).toBe(0);
      });

      it("should handle already empty collections", () => {
        expect(() => state.clearAll?.()).not.toThrow();
      });
    });

    describe("Integration scenarios", () => {
      it("should support full lifecycle: touch -> clear -> verify", () => {
        // Touch session
        state.touchSession("session-1");
        state.sessionStartSeen.add("session-1");

        // Verify exists
        expect(state.sessionLastActivity.has("session-1")).toBe(true);
        expect(state.sessionStartSeen.has("session-1")).toBe(true);

        // Clear
        state.clearSessionState("session-1");

        // Verify cleared
        expect(state.sessionLastActivity.has("session-1")).toBe(false);
        expect(state.sessionStartSeen.has("session-1")).toBe(false);
      });

      it("should handle concurrent session tracking", () => {
        const sessions = ["sess-1", "sess-2", "sess-3"];

        // Touch all sessions
        for (const sess of sessions) {
          state.touchSession(sess);
          state.sessionStartSeen.add(sess);
        }

        // Verify all tracked
        expect(state.sessionLastActivity.size).toBe(3);
        expect(state.sessionStartSeen.size).toBe(3);

        // Clear one
        state.clearSessionState("sess-2");

        // Verify others remain
        expect(state.sessionLastActivity.size).toBe(2);
        expect(state.sessionLastActivity.has("sess-1")).toBe(true);
        expect(state.sessionLastActivity.has("sess-3")).toBe(true);
      });
    });
  });
});
