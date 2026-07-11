import { describe, expect, it } from "vitest";
import { subscriberOwnsRecall } from "../routes/graphql-server.js";
import { globalOnlyScopeFilter } from "../utils/scope-filter.js";

/**
 * SECURITY: a recallOccurred event carries the raw recall query + originating session/agent. The
 * subscription must only deliver that metadata to the recall's owner — never let one identity-scoped
 * tenant harvest another tenant's recall query just because the recall touched a globally-visible fact.
 */
const recall = (over: Partial<Parameters<typeof subscriberOwnsRecall>[1]> = {}) => ({
  query: "quarterly revenue for the Acme deal",
  source: "auto-recall",
  sessionKey: "sess-A",
  agentId: "agent-A",
  occurredAt: 1,
  hits: [{ factId: "f1", score: 0.9 }],
  ...over,
});

describe("subscriberOwnsRecall", () => {
  it("lets the header-less local operator (global-only sentinel) see all recalls", () => {
    expect(subscriberOwnsRecall(globalOnlyScopeFilter(), recall())).toBe(true);
  });

  it("blocks an identity-scoped tenant from another agent's recall", () => {
    expect(subscriberOwnsRecall({ agentId: "agent-B" }, recall({ agentId: "agent-A" }))).toBe(false);
  });

  it("blocks an identity-scoped tenant from another session's recall", () => {
    expect(subscriberOwnsRecall({ sessionId: "sess-B" }, recall({ sessionKey: "sess-A" }))).toBe(false);
  });

  it("delivers a scoped tenant their OWN agent's recall", () => {
    expect(subscriberOwnsRecall({ agentId: "agent-A" }, recall({ agentId: "agent-A" }))).toBe(true);
  });

  it("delivers a scoped tenant their OWN session's recall", () => {
    expect(subscriberOwnsRecall({ sessionId: "sess-A" }, recall({ sessionKey: "sess-A" }))).toBe(true);
  });

  it("blocks a user-scoped tenant from a recall with no matching agent/session", () => {
    expect(subscriberOwnsRecall({ userId: "user-B" }, recall())).toBe(false);
  });
});
