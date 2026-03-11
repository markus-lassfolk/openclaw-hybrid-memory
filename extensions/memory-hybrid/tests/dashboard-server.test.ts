/**
 * Tests for Issue #309 — Mission Control Dashboard
 *
 * Coverage:
 *   - collectStatus: returns expected shape with memory stats
 *   - collectStatus: memory.activeFacts matches factsDb.count()
 *   - collectStatus: memory.expiredFacts matches factsDb.countExpired()
 *   - collectStatus: memory.sqliteSizeBytes is a non-negative number
 *   - collectStatus: generatedAt is a valid ISO date string
 *   - collectStatus: taskQueue has current and history arrays
 *   - collectStatus: forge is an array
 *   - collectStatus: cronJobs is an array
 *   - collectStatus: git has prs and issues arrays
 *   - collectStatus: costs has enabled, features, days fields
 *   - parseDashboardConfig: defaults to enabled=true and port=7700
 *   - parseDashboardConfig: respects custom port
 *   - parseDashboardConfig: clamps invalid port to default 7700
 *   - parseDashboardConfig: enabled=false disables the server
 *   - createDashboardServer: starts and responds on configured port
 *   - createDashboardServer: GET / returns HTML with Mission Control
 *   - createDashboardServer: GET /api/status returns JSON with memory field
 *   - createDashboardServer: GET /unknown returns 404
 *   - createDashboardServer: close() shuts down the server
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectStatus, createDashboardServer } from "../routes/dashboard-server.js";
import { parseDashboardConfig } from "../config/parsers/features.js";
import { _testing } from "../index.js";

const { FactsDB, VectorDB } = _testing;

const VECTOR_DIM = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(tmpDir: string) {
  const factsDb = new FactsDB(join(tmpDir, "facts.db"));
  const vectorDb = new VectorDB(join(tmpDir, "lance"), VECTOR_DIM);
  return {
    factsDb,
    vectorDb,
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    resolvedLancePath: join(tmpDir, "lance"),
  };
}

function freePort(): number {
  // Use a port in a safe test range; vitest runs tests in parallel so offset by random
  return 19700 + Math.floor(Math.random() * 200);
}

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { request } = require("node:http") as typeof import("node:http");
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseDashboardConfig", () => {
  it("defaults to enabled=true and port=7700", () => {
    const cfg = parseDashboardConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(7700);
  });

  it("respects custom port", () => {
    const cfg = parseDashboardConfig({ dashboard: { port: 8800 } });
    expect(cfg.port).toBe(8800);
  });

  it("clamps invalid port (below 1024) to default 7700", () => {
    const cfg = parseDashboardConfig({ dashboard: { port: 80 } });
    expect(cfg.port).toBe(7700);
  });

  it("clamps invalid port (above 65535) to default 7700", () => {
    const cfg = parseDashboardConfig({ dashboard: { port: 99999 } });
    expect(cfg.port).toBe(7700);
  });

  it("enabled=false disables the server", () => {
    const cfg = parseDashboardConfig({ dashboard: { enabled: false } });
    expect(cfg.enabled).toBe(false);
  });
});

describe("collectStatus", () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof makeContext>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dashboard-test-"));
    ctx = makeContext(tmpDir);
  });

  afterEach(() => {
    try { ctx.factsDb.close(); } catch { /* ignore */ }
    try { ctx.vectorDb.close(); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns expected shape with all required fields", async () => {
    const status = await collectStatus(ctx);
    expect(typeof status.generatedAt).toBe("string");
    expect(status.memory).toBeDefined();
    expect(status.cronJobs).toBeDefined();
    expect(status.taskQueue).toBeDefined();
    expect(status.forge).toBeDefined();
    expect(status.git).toBeDefined();
    expect(status.costs).toBeDefined();
  });

  it("memory.activeFacts matches factsDb.count()", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.activeFacts).toBe(ctx.factsDb.count());
  });

  it("memory.expiredFacts matches factsDb.countExpired()", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.expiredFacts).toBe(ctx.factsDb.countExpired());
  });

  it("memory.sqliteSizeBytes is a non-negative number", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.sqliteSizeBytes).toBeGreaterThanOrEqual(0);
  });

  it("memory.lanceSizeBytes is a non-negative number", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.lanceSizeBytes).toBeGreaterThanOrEqual(0);
  });

  it("memory.totalSizeBytes equals sqlite + lance sizes", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.totalSizeBytes).toBe(
      status.memory.sqliteSizeBytes + status.memory.lanceSizeBytes
    );
  });

  it("generatedAt is a valid ISO date string", async () => {
    const status = await collectStatus(ctx);
    const d = new Date(status.generatedAt);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it("taskQueue has current and history fields", async () => {
    const status = await collectStatus(ctx);
    expect(Object.keys(status.taskQueue)).toContain("current");
    expect(Object.keys(status.taskQueue)).toContain("history");
    expect(Array.isArray(status.taskQueue.history)).toBe(true);
  });

  it("forge is an array", async () => {
    const status = await collectStatus(ctx);
    expect(Array.isArray(status.forge)).toBe(true);
  });

  it("cronJobs is an array", async () => {
    const status = await collectStatus(ctx);
    expect(Array.isArray(status.cronJobs)).toBe(true);
  });

  it("git has prs and issues arrays", async () => {
    const status = await collectStatus(ctx);
    expect(status.git).toBeDefined();
    expect(Array.isArray(status.git.prs)).toBe(true);
    expect(Array.isArray(status.git.issues)).toBe(true);
  });

  it("costs has enabled, features, and days fields", async () => {
    const status = await collectStatus(ctx);
    expect(typeof status.costs.enabled).toBe("boolean");
    expect(Array.isArray(status.costs.features)).toBe(true);
    expect(typeof status.costs.days).toBe("number");
  });

  it("costs.enabled is false when llm_cost_log table does not exist", async () => {
    // The table is created by CostTracker; FactsDB raw db does not create it.
    // Without the table, enabled should be false.
    const status = await collectStatus(ctx);
    expect(status.costs.enabled).toBe(false);
  });

  it("memory.vectorCount is a non-negative integer", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.vectorCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(status.memory.vectorCount)).toBe(true);
  });
});

describe("createDashboardServer", () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof makeContext>;
  let port: number;
  let server: ReturnType<typeof createDashboardServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dashboard-srv-test-"));
    ctx = makeContext(tmpDir);
    port = freePort();
    server = createDashboardServer(ctx, port);
  });

  afterEach(() => {
    try { server.close(); } catch { /* ignore */ }
    try { ctx.factsDb.close(); } catch { /* ignore */ }
    try { ctx.vectorDb.close(); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET / returns 200 with HTML content", async () => {
    const { status, body } = await httpGet(port, "/");
    expect(status).toBe(200);
    expect(body).toContain("Mission Control");
  });

  it("GET / includes auto-refresh JS", async () => {
    const { body } = await httpGet(port, "/");
    expect(body).toContain("setInterval");
    expect(body).toContain("60000");
  });

  it("GET /api/status returns 200 with JSON", async () => {
    const { status, body } = await httpGet(port, "/api/status");
    expect(status).toBe(200);
    const data = JSON.parse(body) as { memory: unknown; generatedAt: string };
    expect(data.memory).toBeDefined();
    expect(typeof data.generatedAt).toBe("string");
  });

  it("GET /api/status has Access-Control-Allow-Origin header", async () => {
    return new Promise<void>((resolve, reject) => {
      const { request } = require("node:http") as typeof import("node:http");
      const req = request({ hostname: "127.0.0.1", port, path: "/api/status", method: "GET" }, (res) => {
        expect(res.headers["access-control-allow-origin"]).toBe("*");
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
  });

  it("GET /unknown returns 404", async () => {
    const { status } = await httpGet(port, "/not-found");
    expect(status).toBe(404);
  });

  it("exposes the port in the returned object", () => {
    expect(server.port).toBe(port);
  });

  it("close() stops the server", async () => {
    server.close();
    await expect(httpGet(port, "/")).rejects.toThrow();
  });
});
