import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { resolveAgentIdFromHookEvent } from "../lifecycle/resolve-agent-id.js";

function mockApi(agentId?: string): ClawdbotPluginApi {
  return { context: agentId ? { agentId } : {} } as ClawdbotPluginApi;
}

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

  it("returns null when absent", () => {
    expect(resolveAgentIdFromHookEvent({}, mockApi())).toBeNull();
  });
});
