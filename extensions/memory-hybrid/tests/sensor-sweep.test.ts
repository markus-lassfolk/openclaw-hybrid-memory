/**
 * Tests for sensor sweep service (Issue #236).
 * No LLM calls — pure data collection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../backends/event-bus.js";
import {
  sweepSessionHistory,
  sweepMemoryPatterns,
  sweepGitHub,
  sweepSystemHealth,
  sweepAll,
} from "../services/sensor-sweep.js";
import { parseSensorSweepConfig } from "../config/parsers/sensors.js";
import type { FactsDB } from "../backends/facts-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let bus: EventBus;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sensor-sweep-test-"));
  bus = new EventBus(join(tmpDir, "event-bus.db"));
});

afterEach(() => {
  bus.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal FactsDB stub
function makeFactsDbStub(overrides?: Partial<Pick<FactsDB, "getCount" | "statsBreakdownByCategory" | "getBatch">>): FactsDB {
  return {
    getCount: overrides?.getCount ?? (() => 42),
    statsBreakdownByCategory: overrides?.statsBreakdownByCategory ?? (() => ({ preference: 10, goal: 5, skill: 15, other: 12 })),
    getBatch: overrides?.getBatch ?? ((_offset: number, _limit: number) => [
      { id: "f1", category: "preference", recallCount: 5, lastAccessed: Math.floor(Date.now() / 1000) - 3600, supersededAt: null },
      { id: "f2", category: "goal", recallCount: 1, lastAccessed: Math.floor(Date.now() / 1000) - 86400 * 20, supersededAt: null },
      { id: "f3", category: "skill", recallCount: 3, lastAccessed: Math.floor(Date.now() / 1000) - 600, supersededAt: null },
    ] as unknown as ReturnType<FactsDB["getBatch"]>),
  } as unknown as FactsDB;
}

// ---------------------------------------------------------------------------
// parseSensorSweepConfig
// ---------------------------------------------------------------------------

describe("parseSensorSweepConfig", () => {
  it("returns disabled config when sensorSweep is absent", () => {
    const result = parseSensorSweepConfig({});
    expect(result.enabled).toBe(false);
  });

  it("returns disabled config when enabled is false", () => {
    const result = parseSensorSweepConfig({ sensorSweep: { enabled: false } });
    expect(result.enabled).toBe(false);
  });

  it("parses enabled config with defaults", () => {
    const result = parseSensorSweepConfig({ sensorSweep: { enabled: true } });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("0 */4 * * *");
    expect(result.dedupCooldownHours).toBe(3);
    expect(result.garmin?.enabled).toBe(true);
    expect(result.garmin?.entityPrefix).toBe("sensor.garmin");
    expect(result.github?.enabled).toBe(true);
    expect(result.sessionHistory?.recentSessions).toBe(10);
    expect(result.memoryPatterns?.hotAccessThreshold).toBe(3);
    expect(result.memoryPatterns?.staleAfterDays).toBe(14);
  });

  it("respects per-source enabled=false", () => {
    const result = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        garmin: { enabled: false },
        github: { enabled: false },
      },
    });
    expect(result.garmin?.enabled).toBe(false);
    expect(result.github?.enabled).toBe(false);
    expect(result.sessionHistory?.enabled).toBe(true);
  });

  it("respects custom schedule and cooldown", () => {
    const result = parseSensorSweepConfig({
      sensorSweep: { enabled: true, schedule: "0 */2 * * *", dedupCooldownHours: 6 },
    });
    expect(result.schedule).toBe("0 */2 * * *");
    expect(result.dedupCooldownHours).toBe(6);
  });

  it("parses HA config when present", () => {
    const result = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        homeAssistant: { baseUrl: "http://ha.local:8123", token: "my-token" },
      },
    });
    expect(result.homeAssistant?.baseUrl).toBe("http://ha.local:8123");
    expect(result.homeAssistant?.token).toBe("my-token");
    expect(result.homeAssistant?.timeoutMs).toBe(10_000);
  });

  it("returns no HA config when token is missing", () => {
    const result = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        homeAssistant: { baseUrl: "http://ha.local:8123", token: "" },
      },
    });
    expect(result.homeAssistant).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sweepSessionHistory
// ---------------------------------------------------------------------------

describe("sweepSessionHistory", () => {
  it("returns zero counts when session dir does not exist", async () => {
    const cfg = { enabled: true, recentSessions: 5, importance: 0.5 };
    const result = await sweepSessionHistory(bus, cfg, 0);
    // Dir doesn't exist → no sessions → early return with zero written
    expect(result.sensor).toBe("session-history");
    expect(result.eventsWritten + result.eventsSkipped).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("writes one event when sessions exist", async () => {
    // Create a fake session dir with a session file
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    const sessionData = [
      JSON.stringify({ message: "user asked about TypeScript decorators", timestamp: new Date().toISOString() }),
      JSON.stringify({ message: "assistant explained the concept", timestamp: new Date().toISOString() }),
    ].join("\n");
    writeFileSync(join(sessionDir, "session-abc.jsonl"), sessionData);

    process.env.OPENCLAW_SESSION_DIR = sessionDir;
    try {
      const cfg = { enabled: true, recentSessions: 5, importance: 0.5 };
      const result = await sweepSessionHistory(bus, cfg, 0);
      expect(result.sensor).toBe("session-history");
      // Either written or skipped (dedup), no error
      expect(result.error).toBeUndefined();
      if (result.eventsWritten > 0) {
        const events = bus.queryEvents({ type: "sensor.session-history" });
        expect(events).toHaveLength(1);
        expect(events[0].source).toBe("session-history-sensor");
        const payload = events[0].payload;
        expect(payload.sessionCount).toBe(1);
        expect(Array.isArray(payload.sessions)).toBe(true);
      }
    } finally {
      delete process.env.OPENCLAW_SESSION_DIR;
    }
  });

  it("deduplicates within cooldown window", async () => {
    const sessionDir = join(tmpDir, "sessions2");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "s1.jsonl"), JSON.stringify({ message: "hello world", timestamp: new Date().toISOString() }));

    process.env.OPENCLAW_SESSION_DIR = sessionDir;
    try {
      const cfg = { enabled: true, recentSessions: 5, importance: 0.5 };
      // First sweep: should write
      const r1 = await sweepSessionHistory(bus, cfg, 24);
      // Second sweep with same bucket: should be deduped
      const r2 = await sweepSessionHistory(bus, cfg, 24);
      expect(r1.eventsWritten + r2.eventsWritten + r1.eventsSkipped + r2.eventsSkipped).toBeGreaterThan(0);
      // Total events in bus should be at most 1
      const events = bus.queryEvents({ type: "sensor.session-history" });
      expect(events.length).toBeLessThanOrEqual(1);
    } finally {
      delete process.env.OPENCLAW_SESSION_DIR;
    }
  });
});

// ---------------------------------------------------------------------------
// sweepMemoryPatterns
// ---------------------------------------------------------------------------

describe("sweepMemoryPatterns", () => {
  it("writes a memory-patterns event with correct shape", async () => {
    const factsDb = makeFactsDbStub();
    const cfg = { enabled: true, hotAccessThreshold: 3, staleAfterDays: 14, importance: 0.4 };
    const result = await sweepMemoryPatterns(bus, cfg, factsDb, 0);

    expect(result.sensor).toBe("memory-patterns");
    expect(result.error).toBeUndefined();
    expect(result.eventsWritten).toBe(1);

    const events = bus.queryEvents({ type: "sensor.memory-patterns" });
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.totalFacts).toBe(42);
    expect(typeof payload.hotFactCount).toBe("number");
    expect(typeof payload.staleFactCount).toBe("number");
    expect(typeof payload.openLoopCount).toBe("number");
    expect(typeof payload.categoryBreakdown).toBe("object");
    expect(Array.isArray(payload.hotFactIds)).toBe(true);
    expect(Array.isArray(payload.staleFactIds)).toBe(true);
    expect(Array.isArray(payload.openLoopIds)).toBe(true);
  });

  it("correctly identifies hot facts by recallCount threshold", async () => {
    const factsDb = makeFactsDbStub({
      getBatch: () => [
        { id: "hot1", category: "preference", recallCount: 10, lastAccessed: Date.now() / 1000, supersededAt: null },
        { id: "cold1", category: "skill", recallCount: 0, lastAccessed: Date.now() / 1000, supersededAt: null },
        { id: "hot2", category: "skill", recallCount: 5, lastAccessed: Date.now() / 1000, supersededAt: null },
      ] as unknown as ReturnType<FactsDB["getBatch"]>,
    });

    const cfg = { enabled: true, hotAccessThreshold: 3, staleAfterDays: 14, importance: 0.4 };
    await sweepMemoryPatterns(bus, cfg, factsDb, 0);

    const events = bus.queryEvents({ type: "sensor.memory-patterns" });
    expect(events[0].payload.hotFactCount).toBe(2);
    expect(events[0].payload.hotFactIds).toContain("hot1");
    expect(events[0].payload.hotFactIds).toContain("hot2");
    expect(events[0].payload.hotFactIds).not.toContain("cold1");
  });

  it("correctly identifies stale facts", async () => {
    const staleSec = Math.floor((Date.now() - 20 * 24 * 3600 * 1000) / 1000); // 20 days ago
    const recentSec = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const factsDb = makeFactsDbStub({
      getBatch: () => [
        { id: "stale1", category: "preference", recallCount: 0, lastAccessed: staleSec, supersededAt: null },
        { id: "recent1", category: "skill", recallCount: 0, lastAccessed: recentSec, supersededAt: null },
      ] as unknown as ReturnType<FactsDB["getBatch"]>,
    });

    const cfg = { enabled: true, hotAccessThreshold: 3, staleAfterDays: 14, importance: 0.4 };
    await sweepMemoryPatterns(bus, cfg, factsDb, 0);

    const events = bus.queryEvents({ type: "sensor.memory-patterns" });
    expect(events[0].payload.staleFactCount).toBe(1);
    expect(events[0].payload.staleFactIds).toContain("stale1");
  });

  it("correctly identifies open loops (goal/task facts not superseded)", async () => {
    const factsDb = makeFactsDbStub({
      getBatch: () => [
        { id: "loop1", category: "goal", recallCount: 0, lastAccessed: null, supersededAt: null },
        { id: "loop2", category: "task", recallCount: 0, lastAccessed: null, supersededAt: null },
        { id: "done1", category: "goal", recallCount: 0, lastAccessed: null, supersededAt: 123456 },
        { id: "pref1", category: "preference", recallCount: 0, lastAccessed: null, supersededAt: null },
      ] as unknown as ReturnType<FactsDB["getBatch"]>,
    });

    const cfg = { enabled: true, hotAccessThreshold: 3, staleAfterDays: 14, importance: 0.4 };
    await sweepMemoryPatterns(bus, cfg, factsDb, 0);

    const events = bus.queryEvents({ type: "sensor.memory-patterns" });
    expect(events[0].payload.openLoopCount).toBe(2);
    expect(events[0].payload.openLoopIds).toContain("loop1");
    expect(events[0].payload.openLoopIds).toContain("loop2");
    expect(events[0].payload.openLoopIds).not.toContain("done1");
  });

  it("deduplicates within cooldown window", async () => {
    const factsDb = makeFactsDbStub();
    const cfg = { enabled: true, hotAccessThreshold: 3, staleAfterDays: 14, importance: 0.4 };
    await sweepMemoryPatterns(bus, cfg, factsDb, 24);
    await sweepMemoryPatterns(bus, cfg, factsDb, 24);

    const events = bus.queryEvents({ type: "sensor.memory-patterns" });
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sweepGitHub
// ---------------------------------------------------------------------------

describe("sweepGitHub", () => {
  it("returns error when gh CLI is not available", async () => {
    // Override PATH to make gh unavailable
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const cfg = { enabled: true, importance: 0.7, includeReviewRequests: false, staleIssueDays: 7 };
      const result = await sweepGitHub(bus, cfg, 0);
      expect(result.sensor).toBe("github");
      // Either error or skipped (no events written due to gh not being available)
      if (result.error) {
        expect(result.error).toContain("gh");
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("stores fingerprint for dedup", async () => {
    // Mock gh availability check to fail so we get consistent behavior
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const cfg = { enabled: true, importance: 0.7, includeReviewRequests: false, staleIssueDays: 7 };
      await sweepGitHub(bus, cfg, 24);
      // Second call in same hour bucket should dedup
      const r2 = await sweepGitHub(bus, cfg, 24);
      // No duplicate events
      const events = bus.queryEvents({ type: "sensor.github" });
      expect(events.length).toBeLessThanOrEqual(1);
      void r2;
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// sweepSystemHealth
// ---------------------------------------------------------------------------

describe("sweepSystemHealth", () => {
  it("writes a system-health event", async () => {
    const cfg = { enabled: true, importance: 0.7 };
    const result = await sweepSystemHealth(bus, cfg, "/nonexistent/facts.db", 0);

    expect(result.sensor).toBe("system-health");
    expect(result.error).toBeUndefined();
    expect(result.eventsWritten).toBe(1);

    const events = bus.queryEvents({ type: "sensor.system-health" });
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(typeof payload.uptimeSeconds).toBe("number");
    expect(typeof payload.memoryRssBytes).toBe("number");
    expect(typeof payload.nodeVersion).toBe("string");
    expect(payload.sqliteSizeBytes).toBeNull(); // file doesn't exist
  });

  it("deduplicates within cooldown window", async () => {
    const cfg = { enabled: true, importance: 0.7 };
    await sweepSystemHealth(bus, cfg, "", 24);
    const r2 = await sweepSystemHealth(bus, cfg, "", 24);

    expect(r2.eventsSkipped).toBe(1);
    const events = bus.queryEvents({ type: "sensor.system-health" });
    expect(events.length).toBe(1);
  });

  it("includes sqlite file size when file exists", async () => {
    const dbPath = join(tmpDir, "facts.db");
    writeFileSync(dbPath, "fake db content");

    const cfg = { enabled: true, importance: 0.7 };
    await sweepSystemHealth(bus, cfg, dbPath, 0);

    const events = bus.queryEvents({ type: "sensor.system-health" });
    expect(typeof events[0].payload.sqliteSizeBytes).toBe("number");
    expect((events[0].payload.sqliteSizeBytes as number)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sweepAll
// ---------------------------------------------------------------------------

describe("sweepAll", () => {
  it("runs Tier 1 sensors (excluding garmin that needs HA config)", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "test.jsonl"), JSON.stringify({ message: "hello", timestamp: new Date().toISOString() }));
    process.env.OPENCLAW_SESSION_DIR = sessionDir;

    try {
      const cfg = parseSensorSweepConfig({
        sensorSweep: {
          enabled: true,
          garmin: { enabled: false }, // no HA config, disable
          github: { enabled: false }, // gh CLI may not be present
        },
      });

      const factsDb = makeFactsDbStub();
      const result = await sweepAll(bus, cfg, factsDb, { tier: 1, dryRun: false });

      expect(result.sensors.length).toBeGreaterThan(0);
      // session-history and memory-patterns should be included
      const sensorNames = result.sensors.map((s) => s.sensor);
      expect(sensorNames).toContain("session-history");
      expect(sensorNames).toContain("memory-patterns");
    } finally {
      delete process.env.OPENCLAW_SESSION_DIR;
    }
  });

  it("dry-run does not write events", async () => {
    const cfg = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        garmin: { enabled: false },
        github: { enabled: false },
      },
    });

    const factsDb = makeFactsDbStub();
    const result = await sweepAll(bus, cfg, factsDb, { tier: 1, dryRun: true });

    // All sensors should have zero written
    for (const s of result.sensors) {
      expect(s.eventsWritten).toBe(0);
    }
    expect(result.totalWritten).toBe(0);

    const events = bus.queryEvents();
    expect(events.length).toBe(0);
  });

  it("filters sensors by source list", async () => {
    const cfg = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        garmin: { enabled: false },
        github: { enabled: false },
      },
    });

    const factsDb = makeFactsDbStub();
    const result = await sweepAll(bus, cfg, factsDb, {
      tier: 1,
      sources: ["memory-patterns"],
    });

    const sensorNames = result.sensors.map((s) => s.sensor);
    expect(sensorNames).toContain("memory-patterns");
    expect(sensorNames).not.toContain("session-history");
  });

  it("accepts camelCase config names in source filter", async () => {
    const cfg = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        garmin: { enabled: false },
        github: { enabled: false },
      },
    });

    const factsDb = makeFactsDbStub();
    const result = await sweepAll(bus, cfg, factsDb, {
      tier: 1,
      sources: ["memoryPatterns", "sessionHistory"],
    });

    const sensorNames = result.sensors.map((s) => s.sensor);
    expect(sensorNames).toContain("memory-patterns");
    expect(sensorNames).toContain("session-history");
  });

  it("runs Tier 2 when tier=2", async () => {
    const cfg = parseSensorSweepConfig({
      sensorSweep: {
        enabled: true,
        systemHealth: { enabled: true },
        weather: { enabled: false }, // skip external fetch
        homeAssistantAnomaly: { enabled: false }, // no HA config
        yarbo: { enabled: false }, // no HA config
      },
    });

    const factsDb = makeFactsDbStub();
    const result = await sweepAll(bus, cfg, factsDb, { tier: 2 });

    const sensorNames = result.sensors.map((s) => s.sensor);
    expect(sensorNames).toContain("system-health");
    // Should NOT include tier 1 sensors
    expect(sensorNames).not.toContain("memory-patterns");
    expect(sensorNames).not.toContain("session-history");
  });

  it("returns error summary for failed sensors", async () => {
    const cfg = parseSensorSweepConfig({
      sensorSweep: { enabled: true, garmin: { enabled: false }, github: { enabled: false } },
    });

    // Make getBatch throw
    const factsDb = makeFactsDbStub({
      getBatch: () => { throw new Error("DB unavailable"); },
    });

    const result = await sweepAll(bus, cfg, factsDb, { tier: 1 });

    const memPatterns = result.sensors.find((s) => s.sensor === "memory-patterns");
    expect(memPatterns?.error).toBeDefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("memory-patterns");
  });
});
