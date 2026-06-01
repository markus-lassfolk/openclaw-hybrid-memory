import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { buildGatewayMemoryDiagnostics, buildProcessMemorySnapshot } from "../services/gateway-memory-diagnostics.js";
import { resetReregisterPolicyForTests } from "../setup/reregister-policy.js";

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
  });

  it("buildProcessMemorySnapshot returns rss and heap fields", () => {
    const snap = buildProcessMemorySnapshot();
    expect(snap.process.rssBytes).toBeGreaterThan(0);
    expect(snap.process.heapUsedBytes).toBeGreaterThan(0);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("buildGatewayMemoryDiagnostics includes reregister metrics", async () => {
    process.env.OPENCLAW_HYBRID_MEM_REREGISTER_POLICY = "reuse-databases";
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
  });
});
