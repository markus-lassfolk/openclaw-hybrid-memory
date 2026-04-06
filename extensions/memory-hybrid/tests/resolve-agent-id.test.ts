import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { sliceHookAgentContext, withHookResolutionApi } from "../lifecycle/hook-resolution-api.js";
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

  it("uses typed-hook context merged into api when event is minimal (#1005)", () => {
    const api = withHookResolutionApi(mockApi(), { sessionKey: "agent:ralph:cron:job-99" });
    expect(resolveSessionKeyFromHookEvent({ prompt: "hi" }, api)).toBe("agent:ralph:cron:job-99");
  });

  it("prefers event session id over hook-merged api.context.sessionKey", () => {
    const api = withHookResolutionApi(mockApi(), { sessionKey: "agent:hook:only" });
    expect(resolveSessionKeyFromHookEvent({ session: { id: "from-event" } }, api)).toBe("from-event");
  });
});

describe("withHookResolutionApi / sliceHookAgentContext", () => {
  it("returns api unchanged when hookCtx is undefined", () => {
    const api = mockApi("a1");
    expect(withHookResolutionApi(api, undefined)).toBe(api);
  });

  it("returns api unchanged when hookCtx has no session/agent strings", () => {
    const api = mockApi();
    expect(withHookResolutionApi(api, { foo: 1 })).toBe(api);
    expect(withHookResolutionApi(api, { agentId: "  " })).toBe(api);
  });

  it("hook sessionKey overrides api.context.sessionKey for resolution merge", () => {
    const base = mockApi(undefined, { sessionKey: "agent:api:only" });
    const merged = withHookResolutionApi(base, { sessionKey: "agent:hook:wins" });
    expect(merged.context?.sessionKey).toBe("agent:hook:wins");
  });

  it("hook agentId overrides api.context.agentId on merged api", () => {
    const merged = withHookResolutionApi(mockApi("from-api"), { agentId: "from-hook" });
    expect(merged.context?.agentId).toBe("from-hook");
  });

  it("sliceHookAgentContext picks non-empty string fields", () => {
    expect(sliceHookAgentContext({ sessionKey: "sk", sessionId: "sid", agentId: "aid" })).toEqual({
      sessionKey: "sk",
      sessionId: "sid",
      agentId: "aid",
    });
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

  it("derives agent id from hook-only sessionKey via merged api (#1005)", () => {
    const api = withHookResolutionApi(mockApi(), { sessionKey: "agent:ralph:cron:task-1" });
    expect(resolveAgentIdFromHookEvent({ prompt: "cron" }, api)).toBe("ralph");
  });

  it("uses hook agentId on merged api when event has no structured id", () => {
    const api = withHookResolutionApi(mockApi(), { agentId: "hook-agent" });
    expect(resolveAgentIdFromHookEvent({ prompt: "x" }, api)).toBe("hook-agent");
  });

  it("prefers event.agentId over hook merged context", () => {
    const api = withHookResolutionApi(mockApi("ctx"), { agentId: "hook-agent" });
    expect(resolveAgentIdFromHookEvent({ agentId: "event-agent" }, api)).toBe("event-agent");
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

describe("hook identity parity (#1005)", () => {
  it("prefers sessionId over sessionKey on merged api.context when both are set", () => {
    const api = withHookResolutionApi(mockApi(), {
      sessionId: "canonical-session-id",
      sessionKey: "agent:other:cron:job",
    });
    expect(resolveSessionKeyFromHookEvent({ prompt: "x" }, api)).toBe("canonical-session-id");
  });

  it("resolves the same hook sessionKey to a session string and a matching agent id", () => {
    const hook = { sessionKey: "agent:forge:cron:task-9" };
    const api = withHookResolutionApi(mockApi(), hook);
    const ev = { prompt: "hi" };
    expect(resolveSessionKeyFromHookEvent(ev, api)).toBe("agent:forge:cron:task-9");
    expect(resolveAgentIdFromHookEvent(ev, api)).toBe("forge");
  });

  it("uses hook agentId from merged context when no session key is available", () => {
    const api = withHookResolutionApi(mockApi(), { agentId: "from-hook" });
    const ev = { prompt: "hi" };
    expect(resolveSessionKeyFromHookEvent(ev, api)).toBeNull();
    expect(resolveAgentIdFromHookEvent(ev, api)).toBe("from-hook");
  });
});
