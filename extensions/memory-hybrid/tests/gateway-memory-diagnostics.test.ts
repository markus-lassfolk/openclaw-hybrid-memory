import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  buildGatewayMemoryDiagnostics,
  buildProcessMemorySnapshot,
  sanitizePublicMemoryDiagnostics,
} from "../services/gateway-memory-diagnostics.js";
import { resetReregisterPolicyForTests } from "../setup/reregister-policy.js";
import { setEnv } from "../utils/env-manager.js";
import { resetEventLoopLagMonitorForTests, startEventLoopLagMonitor } from "../utils/event-loop-health.js";

describe("gateway-memory-diagnostics", () => {
  let tmp: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    resetReregisterPolicyForTests();
    tmp = mkdtempSync(join(tmpdir(), "gateway-mem-diag-"));
    factsDb = new FactsDB(join(tmp, "facts.db"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    resetReregisterPolicyForTests();
    resetEventLoopLagMonitorForTests();
    setEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", undefined);
  });

  it("buildProcessMemorySnapshot returns rss and heap fields", () => {
    const snap = buildProcessMemorySnapshot();
    expect(snap.process.rssBytes).toBeGreaterThan(0);
    expect(snap.process.heapUsedBytes).toBeGreaterThan(0);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("buildGatewayMemoryDiagnostics includes reregister metrics", async () => {
    setEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    startEventLoopLagMonitor();
    const vectorDb = {
      getPath: () => join(tmp, "lancedb"),
      count: async () => 0,
      isInitialized: () => false,
    };
    const diag = await buildGatewayMemoryDiagnostics({
      factsDb,
      vectorDb: vectorDb as never,
      resolvedSqlitePath: join(tmp, "facts.db"),
      resolvedLancePath: join(tmp, "lancedb"),
      recallInFlightRef: { value: 0 },
    });
    expect(diag.hybridMemory.reregisterPolicy).toBe("reuse-databases");
    expect(diag.process.nativeRssBytes).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(diag.leakHints)).toBe(true);
    expect(diag.eventLoop.health).toBe("healthy");
    expect(diag.eventLoop.lagMaxMs).not.toBeNull();
    expect(diag.eventLoop.degradedThresholdMs).toBe(200);
  });

  it("buildProcessMemorySnapshot includes event loop lag fields", () => {
    startEventLoopLagMonitor();
    const snap = buildProcessMemorySnapshot();
    expect(snap.eventLoop.lagMaxMs).not.toBeNull();
    expect(snap.eventLoop.health).toBe("healthy");
    expect(snap.eventLoop.degradedThresholdMs).toBe(200);
  });

  it("sanitizePublicMemoryDiagnostics redacts fact counts and paths", async () => {
    const vectorDb = {
      getPath: () => join(tmp, "lancedb"),
      count: async () => 0,
      isInitialized: () => false,
    };
    const raw = await buildGatewayMemoryDiagnostics({
      factsDb,
      vectorDb: vectorDb as never,
      resolvedSqlitePath: join(tmp, "facts.db"),
      resolvedLancePath: join(tmp, "lancedb"),
    });
    const sanitized = sanitizePublicMemoryDiagnostics(raw);
    expect(raw.facts.activeFacts).not.toBeNull();
    expect(sanitized.facts.activeFacts).toBeNull();
    expect(sanitized.facts.topSources).toBeNull();
    expect(sanitized.startupAttribution).toEqual([]);
    expect(sanitized.hybridMemory.vectorObservability?.vectorDb.path).toBeNull();
    expect(sanitized.hybridMemory.vectorObservability?.lancedb.basePath).toBeNull();
    expect(sanitized.disk.sqliteBytes).toBeNull();
    expect(sanitized.disk.lanceDirBytes).toBeNull();
  });
});
