import { describe, expect, it } from "vitest";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import type { ScopeFilter } from "../types/memory.js";

describe("buildToolScopeFilter", () => {
  const mockConfig = {
    multiAgent: { orchestratorId: "orchestrator-1", trustToolScopeParams: false },
    autoRecall: {},
  };

  describe("Security: Tool scope params ignored by default", () => {
    it("should ignore userId when trustToolScopeParams is false", () => {
      const result = buildToolScopeFilter({ userId: "user-123", confirmCrossTenantScope: true }, null, mockConfig);

      expect(result).toBeUndefined();
    });

    it("should ignore agentId when trustToolScopeParams is false", () => {
      const result = buildToolScopeFilter({ agentId: "agent-456", confirmCrossTenantScope: true }, null, mockConfig);

      expect(result).toBeUndefined();
    });

    it("should ignore sessionId when trustToolScopeParams is false", () => {
      const result = buildToolScopeFilter(
        { sessionId: "session-789", confirmCrossTenantScope: true },
        null,
        mockConfig,
      );

      expect(result).toBeUndefined();
    });

    it("should ignore all scope params when confirmCrossTenantScope is false even with trust enabled", () => {
      const configWithTrust = {
        ...mockConfig,
        multiAgent: { ...mockConfig.multiAgent, trustToolScopeParams: true },
      };

      const result = buildToolScopeFilter(
        { userId: "user-123", agentId: "agent-456", confirmCrossTenantScope: false },
        null,
        configWithTrust,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("Trusted scope params", () => {
    const trustedConfig = {
      multiAgent: { orchestratorId: "orchestrator-1", trustToolScopeParams: true },
      autoRecall: {},
    };

    it("should apply userId when trust is enabled and confirmed", () => {
      const result = buildToolScopeFilter({ userId: "user-123", confirmCrossTenantScope: true }, null, trustedConfig);

      expect(result).toEqual({
        userId: "user-123",
        agentId: null,
        sessionId: null,
      });
    });

    it("should apply all scope params when provided", () => {
      const result = buildToolScopeFilter(
        {
          userId: "user-123",
          agentId: "agent-456",
          sessionId: "session-789",
          confirmCrossTenantScope: true,
        },
        null,
        trustedConfig,
      );

      expect(result).toEqual({
        userId: "user-123",
        agentId: "agent-456",
        sessionId: "session-789",
      });
    });

    it("should handle null values in scope params", () => {
      const result = buildToolScopeFilter(
        { userId: null, agentId: "agent-456", sessionId: null, confirmCrossTenantScope: true },
        null,
        trustedConfig,
      );

      expect(result).toEqual({
        userId: null,
        agentId: "agent-456",
        sessionId: null,
      });
    });
  });

  describe("Agent-scoped filtering", () => {
    it("should apply current agent scope when not orchestrator", () => {
      const result = buildToolScopeFilter({}, "agent-worker-1", mockConfig);

      expect(result).toEqual({
        userId: null,
        agentId: "agent-worker-1",
        sessionId: null,
      });
    });

    it("should merge autoRecall scopeFilter with current agent", () => {
      const configWithAutoRecall = {
        ...mockConfig,
        autoRecall: { scopeFilter: { userId: "user-auto", agentId: null, sessionId: "session-auto" } },
      };

      const result = buildToolScopeFilter({}, "agent-worker-1", configWithAutoRecall);

      expect(result).toEqual({
        userId: "user-auto",
        agentId: "agent-worker-1",
        sessionId: "session-auto",
      });
    });

    it("should not apply agent scope when current agent is orchestrator", () => {
      const result = buildToolScopeFilter({}, "orchestrator-1", mockConfig);

      expect(result).toBeUndefined();
    });
  });

  describe("Orchestrator fallback", () => {
    it("should return autoRecall scopeFilter when orchestrator and no params", () => {
      const autoRecallFilter: ScopeFilter = {
        userId: "user-orchestrator",
        agentId: null,
        sessionId: "session-orchestrator",
      };
      const configWithAutoRecall = {
        ...mockConfig,
        autoRecall: { scopeFilter: autoRecallFilter },
      };

      const result = buildToolScopeFilter({}, "orchestrator-1", configWithAutoRecall);

      expect(result).toEqual(autoRecallFilter);
    });

    it("should return undefined when orchestrator and no autoRecall scope", () => {
      const result = buildToolScopeFilter({}, "orchestrator-1", mockConfig);

      expect(result).toBeUndefined();
    });

    it("should return autoRecall scopeFilter when no current agent", () => {
      const autoRecallFilter: ScopeFilter = { userId: "user-default", agentId: null, sessionId: null };
      const configWithAutoRecall = {
        ...mockConfig,
        autoRecall: { scopeFilter: autoRecallFilter },
      };

      const result = buildToolScopeFilter({}, null, configWithAutoRecall);

      expect(result).toEqual(autoRecallFilter);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty params object", () => {
      const result = buildToolScopeFilter({}, null, mockConfig);

      expect(result).toBeUndefined();
    });

    it("should prioritize trusted tool params over agent scope", () => {
      const trustedConfig = {
        multiAgent: { orchestratorId: "orchestrator-1", trustToolScopeParams: true },
        autoRecall: {},
      };

      const result = buildToolScopeFilter(
        { userId: "user-override", confirmCrossTenantScope: true },
        "agent-worker-1",
        trustedConfig,
      );

      expect(result).toEqual({
        userId: "user-override",
        agentId: null,
        sessionId: null,
      });
    });

    it("should use agent scope when trusted params not confirmed", () => {
      const trustedConfig = {
        multiAgent: { orchestratorId: "orchestrator-1", trustToolScopeParams: true },
        autoRecall: {},
      };

      const result = buildToolScopeFilter(
        { userId: "user-override", confirmCrossTenantScope: false },
        "agent-worker-1",
        trustedConfig,
      );

      expect(result).toEqual({
        userId: null,
        agentId: "agent-worker-1",
        sessionId: null,
      });
    });
  });
});
