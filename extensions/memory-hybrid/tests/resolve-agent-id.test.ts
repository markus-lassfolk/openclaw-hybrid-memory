import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentIdFromHookEvent, tryParseAgentIdFromOpenClawSessionKey } from "../lifecycle/resolve-agent-id.js";
import { resolveSessionKeyFromHookEvent } from "../lifecycle/session-state.js";

function mockApi(agentId?: string, ctx?: { sessionId?: string; sessionKey?: string }): ClawdbotPluginApi {
  return {
    context: {
      ...(agentId ? { agentId } : {}),
      ...ctx,
    },
  } as ClawdbotPluginApi;
}

describe("tryParseAgentIdFromOpenClawSessionKey", () => {
  it("parses agent:main:main", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("agent:main:main")).toBe("main");
  });

  it("parses multi-segment cron-style keys", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("agent:ralph:cron:job-abc")).toBe("ralph");
  });

  it("parses subagent keys", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("agent:forge:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a")).toBe(
      "forge",
    );
  });

  it("trims whitespace on the key", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("  agent:x:y  ")).toBe("x");
  });

  it("returns null for bare cron keys (no agent prefix)", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("cron:job-1")).toBeNull();
  });

  it("returns null for legacy subagent-only keys", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("subagent:xyz")).toBeNull();
  });

  it("returns null when agent: has fewer than three segments", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("agent:only")).toBeNull();
    expect(tryParseAgentIdFromOpenClawSessionKey("agent:")).toBeNull();
  });

  it("returns null for empty agent segment", () => {
    expect(tryParseAgentIdFromOpenClawSessionKey("agent::main")).toBeNull();
  });
});

describe("resolveSessionKeyFromHookEvent", () => {
  it("prefers event session id over api.context.sessionKey", () => {
    expect(
      resolveSessionKeyFromHookEvent(
        { session: { id: "from-event" } },
        { context: { sessionKey: "from-context", sessionId: "from-ctx-id" } },
      ),
    ).toBe("from-event");
  });

  it("falls back to api.context.sessionKey when session id fields are absent", () => {
    expect(resolveSessionKeyFromHookEvent({}, { context: { sessionKey: "agent:ralph:cron:j1" } })).toBe(
      "agent:ralph:cron:j1",
    );
  });

  it("prefers api.context.sessionId over api.context.sessionKey", () => {
    expect(resolveSessionKeyFromHookEvent({}, { context: { sessionId: "sid", sessionKey: "sk" } })).toBe("sid");
  });

  it("reads event.context.sessionId when session and api.context are absent (newer OpenClaw payloads)", () => {
    expect(resolveSessionKeyFromHookEvent({ context: { sessionId: "agent:nova:chan:1" } }, {})).toBe(
      "agent:nova:chan:1",
    );
  });

  it("prefers event.session.id over event.context.sessionId", () => {
    expect(
      resolveSessionKeyFromHookEvent({ session: { id: "from-session" }, context: { sessionId: "from-context" } }, {}),
    ).toBe("from-session");
  });
});

describe("resolveAgentIdFromHookEvent", () => {
  it("prefers top-level event.agentId", () => {
    expect(resolveAgentIdFromHookEvent({ agentId: "a1", session: { agentId: "b2" } }, mockApi("c3"))).toBe("a1");
  });

  it("uses session.agentId", () => {
    expect(resolveAgentIdFromHookEvent({ session: { agentId: "wa:main" } }, mockApi())).toBe("wa:main");
  });

  it("uses session.agent when string", () => {
    expect(resolveAgentIdFromHookEvent({ session: { agent: "route-bot" } }, mockApi())).toBe("route-bot");
  });

  it("uses session.routedAgentId", () => {
    expect(resolveAgentIdFromHookEvent({ session: { routedAgentId: "r1" } }, mockApi())).toBe("r1");
  });

  it("uses activeAgent.id object form", () => {
    expect(resolveAgentIdFromHookEvent({ session: { activeAgent: { id: "sub-1" } } }, mockApi())).toBe("sub-1");
  });

  it("falls back to api.context.agentId", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi("ctx-agent"))).toBe("ctx-agent");
  });

  it("derives agent id from session key when structured fields are absent (#990)", () => {
    expect(
      resolveAgentIdFromHookEvent(
        { session: { id: "agent:ralph:cron:task-1" } },
        mockApi(undefined, { sessionId: undefined }),
      ),
    ).toBe("ralph");
  });

  it("derives agent id from event.context.sessionId when only payload context carries the key", () => {
    expect(resolveAgentIdFromHookEvent({ context: { sessionId: "agent:ralph:cron:task-1" } }, mockApi())).toBe("ralph");
  });

  it("derives agent id from api.context.sessionKey when that is all we have", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi(undefined, { sessionKey: "agent:ralph:cron:task-1" }))).toBe(
      "ralph",
    );
  });

  it("prefers explicit api.context.agentId over session key parsing", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi("explicit", { sessionKey: "agent:other:cron:x" }))).toBe("explicit");
  });

  it("returns null when absent and session key is not agent:-prefixed", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi(undefined, { sessionKey: "cron:only" }))).toBeNull();
  });

  it("returns null when absent", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi())).toBeNull();
  });

  it("logs at debug when resolving from session key", () => {
    const debug = vi.fn();
    const api = {
      context: { sessionKey: "agent:ralph:cron:j" },
      logger: { debug },
    } as unknown as ClawdbotPluginApi;
    expect(resolveAgentIdFromHookEvent({}, api)).toBe("ralph");
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('memory-hybrid: Resolved agentId "ralph" from session key pattern'),
    );
  });
});
