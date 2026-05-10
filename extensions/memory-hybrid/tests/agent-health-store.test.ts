import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentHealthStore,
  agentHealthDbPathForMemorySqlite,
  mergeAgentHealthDashboard,
  type AgentHealthView,
} from "../backends/agent-health-store.js";
import type { ForgeTaskItem } from "../types/dashboard-types.js";

describe("agent-health-store", () => {
  let testDir: string;
  let dbPath: string;
  let store: AgentHealthStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `agent-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, "agent-health.db");
    store = new AgentHealthStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("AgentHealthStore initialization", () => {
    it("should create database file on initialization", () => {
      expect(existsSync(dbPath)).toBe(true);
    });

    it("should create agent_health table with correct schema", () => {
      const tables = store["liveDb"]
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_health'")
        .all() as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("agent_health");
    });

    it("should create directory if it doesn't exist", () => {
      const nestedPath = join(testDir, "nested", "path", "agent-health.db");
      const nestedStore = new AgentHealthStore(nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
      nestedStore.close();
    });

    it("should have correct subsystem name", () => {
      expect(store["getSubsystemName"]()).toBe("agent-health-store");
    });
  });

  describe("upsert", () => {
    it("should insert new agent health record", () => {
      store.upsert({
        agentId: "forge",
        sessionId: "session-123",
        lastSeen: Date.now(),
        lastTask: "building project",
        outcome: "success",
        latencyMs: 1500,
        tokensUsed: 2000,
        errorCount: 0,
        anomalyScore: 0.1,
        nextAgent: ["scholar", "warden"],
      });

      const record = store.get("forge");
      expect(record).not.toBeNull();
      expect(record?.agentId).toBe("forge");
      expect(record?.lastTask).toBe("building project");
      expect(record?.outcome).toBe("success");
    });

    it("should update existing agent health record", () => {
      // Insert initial record
      store.upsert({
        agentId: "forge",
        sessionId: "session-123",
        lastSeen: Date.now(),
        lastTask: "initial task",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0.1,
        nextAgent: [],
      });

      // Update the record
      store.upsert({
        agentId: "forge",
        sessionId: "session-456",
        lastSeen: Date.now() + 1000,
        lastTask: "updated task",
        outcome: "partial",
        errorCount: 2,
        anomalyScore: 0.5,
        nextAgent: ["hearth"],
      });

      const record = store.get("forge");
      expect(record?.sessionId).toBe("session-456");
      expect(record?.lastTask).toBe("updated task");
      expect(record?.outcome).toBe("partial");
      expect(record?.errorCount).toBe(2);
    });

    it("should handle all outcome types", () => {
      const outcomes = ["success", "partial", "failed", "idle"] as const;

      for (const outcome of outcomes) {
        store.upsert({
          agentId: `agent-${outcome}`,
          sessionId: null,
          lastSeen: Date.now(),
          lastTask: "test",
          outcome,
          errorCount: 0,
          anomalyScore: 0,
          nextAgent: [],
        });
      }

      for (const outcome of outcomes) {
        const record = store.get(`agent-${outcome}`);
        expect(record?.outcome).toBe(outcome);
      }
    });

    it("should handle null session_id", () => {
      store.upsert({
        agentId: "forge",
        sessionId: null,
        lastSeen: Date.now(),
        lastTask: "no session",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const record = store.get("forge");
      expect(record?.sessionId).toBeNull();
    });

    it("should handle optional fields", () => {
      store.upsert({
        agentId: "forge",
        sessionId: "session-123",
        lastSeen: Date.now(),
        lastTask: "minimal",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const record = store.get("forge");
      expect(record?.latencyMs).toBeUndefined();
      expect(record?.tokensUsed).toBeUndefined();
    });

    it("should serialize nextAgent array as JSON", () => {
      store.upsert({
        agentId: "forge",
        sessionId: null,
        lastSeen: Date.now(),
        lastTask: "coordination",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: ["scholar", "warden", "hearth"],
      });

      const record = store.get("forge");
      expect(record?.nextAgent).toEqual(["scholar", "warden", "hearth"]);
    });

    it("should handle empty nextAgent array", () => {
      store.upsert({
        agentId: "forge",
        sessionId: null,
        lastSeen: Date.now(),
        lastTask: "solo",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const record = store.get("forge");
      expect(record?.nextAgent).toEqual([]);
    });

    it("should track anomaly scores", () => {
      const scores = [0.0, 0.25, 0.5, 0.75, 1.0];

      for (let i = 0; i < scores.length; i++) {
        store.upsert({
          agentId: `agent-${i}`,
          sessionId: null,
          lastSeen: Date.now(),
          lastTask: "test",
          outcome: "success",
          errorCount: 0,
          anomalyScore: scores[i],
          nextAgent: [],
        });
      }

      for (let i = 0; i < scores.length; i++) {
        const record = store.get(`agent-${i}`);
        expect(record?.anomalyScore).toBe(scores[i]);
      }
    });
  });

  describe("get", () => {
    it("should retrieve existing agent record", () => {
      store.upsert({
        agentId: "forge",
        sessionId: "session-123",
        lastSeen: 123456789,
        lastTask: "test task",
        outcome: "success",
        latencyMs: 1500,
        tokensUsed: 2000,
        errorCount: 0,
        anomalyScore: 0.1,
        nextAgent: ["scholar"],
      });

      const record = store.get("forge");
      expect(record).not.toBeNull();
      expect(record?.agentId).toBe("forge");
      expect(record?.sessionId).toBe("session-123");
      expect(record?.lastSeen).toBe(123456789);
      expect(record?.lastTask).toBe("test task");
      expect(record?.outcome).toBe("success");
      expect(record?.latencyMs).toBe(1500);
      expect(record?.tokensUsed).toBe(2000);
      expect(record?.nextAgent).toEqual(["scholar"]);
    });

    it("should return null for non-existent agent", () => {
      const record = store.get("non-existent");
      expect(record).toBeNull();
    });

    it("should handle case-sensitive agent IDs", () => {
      store.upsert({
        agentId: "Forge",
        sessionId: null,
        lastSeen: Date.now(),
        lastTask: "test",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const upperRecord = store.get("Forge");
      const lowerRecord = store.get("forge");

      expect(upperRecord).not.toBeNull();
      expect(lowerRecord).toBeNull();
    });
  });

  describe("listAll", () => {
    it("should return empty array when no records", () => {
      const records = store.listAll();
      expect(records).toEqual([]);
    });

    it("should return all agent records", () => {
      const agents = ["forge", "scholar", "warden"];

      for (const agent of agents) {
        store.upsert({
          agentId: agent,
          sessionId: null,
          lastSeen: Date.now(),
          lastTask: `${agent} task`,
          outcome: "success",
          errorCount: 0,
          anomalyScore: 0,
          nextAgent: [],
        });
      }

      const records = store.listAll();
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.agentId).sort()).toEqual(agents.sort());
    });

    it("should include all record fields", () => {
      store.upsert({
        agentId: "forge",
        sessionId: "session-123",
        lastSeen: 123456789,
        lastTask: "full record",
        outcome: "partial",
        latencyMs: 1500,
        tokensUsed: 2000,
        errorCount: 3,
        anomalyScore: 0.5,
        nextAgent: ["scholar", "warden"],
      });

      const records = store.listAll();
      expect(records).toHaveLength(1);
      const record = records[0];

      expect(record.agentId).toBe("forge");
      expect(record.sessionId).toBe("session-123");
      expect(record.lastSeen).toBe(123456789);
      expect(record.lastTask).toBe("full record");
      expect(record.outcome).toBe("partial");
      expect(record.latencyMs).toBe(1500);
      expect(record.tokensUsed).toBe(2000);
      expect(record.errorCount).toBe(3);
      expect(record.anomalyScore).toBe(0.5);
      expect(record.nextAgent).toEqual(["scholar", "warden"]);
    });
  });

  describe("prune", () => {
    it("should delete records older than retention period", () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 3600 * 1000;

      // Insert old record
      store.upsert({
        agentId: "old-agent",
        sessionId: null,
        lastSeen: thirtyOneDaysAgo,
        lastTask: "old task",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      // Manually update the updated_at timestamp
      store["liveDb"]
        .prepare("UPDATE agent_health SET updated_at = ? WHERE agent_id = ?")
        .run(thirtyOneDaysAgo, "old-agent");

      // Insert recent record
      store.upsert({
        agentId: "recent-agent",
        sessionId: null,
        lastSeen: now,
        lastTask: "recent task",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const pruned = store.prune(30);

      expect(pruned).toBe(1);
      expect(store.get("old-agent")).toBeNull();
      expect(store.get("recent-agent")).not.toBeNull();
    });

    it("should not delete records within retention period", () => {
      store.upsert({
        agentId: "forge",
        sessionId: null,
        lastSeen: Date.now(),
        lastTask: "recent",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      const pruned = store.prune(30);

      expect(pruned).toBe(0);
      expect(store.get("forge")).not.toBeNull();
    });

    it("should handle custom retention days", () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 3600 * 1000;

      store.upsert({
        agentId: "agent",
        sessionId: null,
        lastSeen: eightDaysAgo,
        lastTask: "old",
        outcome: "success",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      });

      store["liveDb"].prepare("UPDATE agent_health SET updated_at = ? WHERE agent_id = ?").run(eightDaysAgo, "agent");

      // Should not be pruned with 30 days retention
      expect(store.prune(30)).toBe(0);

      // Should be pruned with 7 days retention
      expect(store.prune(7)).toBe(1);
    });

    it("should return count of pruned records", () => {
      const now = Date.now();
      const oldTimestamp = now - 31 * 24 * 3600 * 1000;

      // Insert multiple old records
      for (let i = 0; i < 5; i++) {
        store.upsert({
          agentId: `agent-${i}`,
          sessionId: null,
          lastSeen: oldTimestamp,
          lastTask: "old",
          outcome: "success",
          errorCount: 0,
          anomalyScore: 0,
          nextAgent: [],
        });
        store["liveDb"]
          .prepare("UPDATE agent_health SET updated_at = ? WHERE agent_id = ?")
          .run(oldTimestamp, `agent-${i}`);
      }

      const pruned = store.prune(30);
      expect(pruned).toBe(5);
    });
  });

  describe("agentHealthDbPathForMemorySqlite", () => {
    it("should return null for :memory: database", () => {
      const result = agentHealthDbPathForMemorySqlite(":memory:");
      expect(result).toBeNull();
    });

    it("should return null for empty path", () => {
      const result = agentHealthDbPathForMemorySqlite("");
      expect(result).toBeNull();
    });

    it("should derive path from memory sqlite path", () => {
      const memorySqlitePath = "/path/to/memory/facts.db";
      const result = agentHealthDbPathForMemorySqlite(memorySqlitePath);

      expect(result).toBe("/path/to/memory/agent-health.db");
    });

    it("should handle nested directories", () => {
      const memorySqlitePath = "/home/user/.openclaw/memory/facts.db";
      const result = agentHealthDbPathForMemorySqlite(memorySqlitePath);

      expect(result).toBe("/home/user/.openclaw/memory/agent-health.db");
    });
  });

  describe("mergeAgentHealthDashboard", () => {
    it("should merge forge tasks with database records", () => {
      const forge: ForgeTaskItem[] = [
        {
          agent: "forge",
          task: "building project",
          status: "success",
          started_at: new Date().toISOString(),
        },
      ];

      const dbRows = [
        {
          agentId: "forge",
          sessionId: "session-123",
          lastSeen: Date.now(),
          lastTask: "previous task",
          outcome: "success" as const,
          errorCount: 2,
          anomalyScore: 0.3,
          nextAgent: [],
        },
      ];

      const merged = mergeAgentHealthDashboard(forge, dbRows);

      // mergeAgentHealthDashboard always includes all default agents (7 total)
      expect(merged.length).toBeGreaterThanOrEqual(1);
      const forgeAgent = merged.find(a => a.agentId === "forge");
      expect(forgeAgent).toBeDefined();
      expect(forgeAgent!.errorCount).toBe(2); // From DB
    });

    it("should map forge status to outcomes", () => {
      const forge: ForgeTaskItem[] = [
        { agent: "agent1", task: "task", status: "failed", started_at: new Date().toISOString() },
        { agent: "agent2", task: "task", status: "error", started_at: new Date().toISOString() },
        { agent: "agent3", task: "task", status: "partial", started_at: new Date().toISOString() },
        { agent: "agent4", task: "task", status: "idle", started_at: new Date().toISOString() },
        { agent: "agent5", task: "task", status: "success", started_at: new Date().toISOString() },
      ];

      const merged = mergeAgentHealthDashboard(forge, []);

      expect(merged[0].outcome).toBe("failed");
      expect(merged[1].outcome).toBe("failed");
      expect(merged[2].outcome).toBe("partial");
      expect(merged[3].outcome).toBe("idle");
      expect(merged[4].outcome).toBe("success");
    });

    it("should handle case-insensitive agent IDs", () => {
      const forge: ForgeTaskItem[] = [{ agent: "Forge", task: "task", status: "success" }];

      const dbRows = [
        {
          agentId: "forge",
          sessionId: null,
          lastSeen: Date.now(),
          lastTask: "db task",
          outcome: "success" as const,
          errorCount: 1,
          anomalyScore: 0.1,
          nextAgent: [],
        },
      ];

      const merged = mergeAgentHealthDashboard(forge, dbRows);

      // mergeAgentHealthDashboard always includes all default agents
      expect(merged.length).toBeGreaterThanOrEqual(1);
      const forgeAgent = merged.find(a => a.agentId === "forge");
      expect(forgeAgent).toBeDefined();
      expect(forgeAgent!.agentId).toBe("forge");
    });

    it("should include default agents in dashboard", () => {
      const merged = mergeAgentHealthDashboard([], []);

      // Should include default agent IDs
      const agentIds = merged.map((a) => a.agentId);
      expect(agentIds).toContain("forge");
      expect(agentIds).toContain("scholar");
      expect(agentIds).toContain("warden");
    });

    it("should handle missing started_at in forge tasks", () => {
      const forge: ForgeTaskItem[] = [{ agent: "forge", task: "task", status: "success" }];

      const merged = mergeAgentHealthDashboard(forge, []);

      const forgeAgent = merged.find(a => a.agentId === "forge");
      expect(forgeAgent).toBeDefined();
      expect(forgeAgent!.lastSeen).toBeGreaterThan(0);
    });

    it("should prioritize forge data over DB for active agents", () => {
      const forgeTimestamp = Date.now();
      const forge: ForgeTaskItem[] = [
        {
          agent: "forge",
          task: "live task",
          status: "success",
          started_at: new Date(forgeTimestamp).toISOString(),
        },
      ];

      const dbRows = [
        {
          agentId: "forge",
          sessionId: "old-session",
          lastSeen: forgeTimestamp - 10000,
          lastTask: "old task",
          outcome: "partial" as const,
          errorCount: 5,
          anomalyScore: 0.8,
          nextAgent: [],
        },
      ];

      const merged = mergeAgentHealthDashboard(forge, dbRows);

      const forgeAgent = merged.find(a => a.agentId === "forge");
      expect(forgeAgent).toBeDefined();
      expect(forgeAgent!.lastTask).toBe("live task");
      expect(forgeAgent!.outcome).toBe("success");
      expect(forgeAgent!.lastSeen).toBeCloseTo(forgeTimestamp, -2);
    });
  });
});
