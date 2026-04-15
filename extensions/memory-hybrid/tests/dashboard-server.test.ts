// @ts-nocheck
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

import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDashboardConfig } from "../config/parsers/features.js";
import { _testing } from "../index.js";
import { collectStatus, createDashboardServer } from "../routes/dashboard-server.js";

const { FactsDB, VectorDB } = _testing;

const VECTOR_DIM = 4;

async function detectLoopbackBindSupport(): Promise<boolean> {
  const { createServer } = await import("node:http");
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw err;
  } finally {
    try {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    } catch {
      /* ignore */
    }
  }
}

const describeCreateDashboardServer = (await detectLoopbackBindSupport()) ? describe : describe.skip;

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

function isListenPermissionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ((err as { code?: string }).code === "EPERM" || (err as { code?: string }).code === "EACCES")
  );
}

// Port 0 lets the OS assign an unused port — no EADDRINUSE races in parallel tests

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("timeout"));
    });
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
    try {
      ctx.factsDb.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.vectorDb.close();
    } catch {
      /* ignore */
    }
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
    expect(status.audit).toBeDefined();
    expect(typeof status.audit.enabled).toBe("boolean");
    expect(status.agentHealth).toBeDefined();
    expect(typeof status.agentHealth.enabled).toBe("boolean");
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
    expect(status.memory.totalSizeBytes).toBe(status.memory.sqliteSizeBytes + status.memory.lanceSizeBytes);
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
    const status = await collectStatus(ctx);
    expect(status.costs.enabled).toBe(false);
  });

  it("memory.vectorCount is a non-negative integer", async () => {
    const status = await collectStatus(ctx);
    expect(status.memory.vectorCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(status.memory.vectorCount)).toBe(true);
  });
});

describeCreateDashboardServer("createDashboardServer", () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof makeContext>;
  let port: number;
  let server: Awaited<ReturnType<typeof createDashboardServer>> | null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dashboard-srv-test-"));
    ctx = makeContext(tmpDir);
    try {
      server = await createDashboardServer(ctx, 0);
      port = server.port;
    } catch (err: unknown) {
      if (!isListenPermissionError(err)) {
        throw err;
      }
      server = null;
      port = 0;
    }
  });

  afterEach(() => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.factsDb.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.vectorDb.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET / returns 200 with HTML content", async () => {
    if (!server) return;
    const { status, body } = await httpGet(port, "/");
    expect(status).toBe(200);
    expect(body).toContain("Mission Control");
  });

  it("GET / includes auto-refresh JS", async () => {
    if (!server) return;
    const { body } = await httpGet(port, "/");
    expect(body).toContain("setInterval");
    expect(body).toContain("60000");
  });

  it("GET /api/status returns 200 with JSON", async () => {
    if (!server) return;
    const { status, body } = await httpGet(port, "/api/status");
    expect(status).toBe(200);
    const data = JSON.parse(body) as { memory: unknown; generatedAt: string };
    expect(data.memory).toBeDefined();
    expect(typeof data.generatedAt).toBe("string");
  });

  it("GET /api/status does NOT include Access-Control-Allow-Origin header", async () => {
    if (!server) return;
    return new Promise<void>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/api/status", method: "GET" }, (res) => {
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
  });

  it("GET /unknown returns 404", async () => {
    if (!server) return;
    const { status } = await httpGet(port, "/not-found");
    expect(status).toBe(404);
  });

  it("exposes the port in the returned object", () => {
    if (!server) return;
    expect(server.port).toBeGreaterThan(0);
  });

  it("close() stops the server", async () => {
    if (!server) return;
    server.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await expect(httpGet(port, "/")).rejects.toThrow();
  });

  it("falls back to ephemeral port on EADDRINUSE (issue #428)", async () => {
    const { createServer } = await import("node:http");
    const blocker = createServer();
    let blockerPort = 0;

    try {
      blockerPort = await new Promise<number>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", () => {
          blocker.removeAllListeners("error");
          const addr = blocker.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });
    } catch (err: unknown) {
      if (isListenPermissionError(err)) return;
      throw err;
    }

    try {
      const fallback = await createDashboardServer(ctx, blockerPort);
      try {
        expect(fallback.port).not.toBe(blockerPort);
        expect(fallback.port).toBeGreaterThan(0);
        const { status } = await httpGet(fallback.port, "/");
        expect(status).toBe(200);
      } finally {
        fallback.close();
      }
    } finally {
      blocker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Memory Viewer API tests (Issue #1023)
// ---------------------------------------------------------------------------

describe("Memory Viewer API (Issue #1023)", () => {
  const VECTOR_DIM = 4;

  async function makeContextWithStores(tmpDir: string) {
    const { FactsDB, VectorDB } = await import("../index.js").then((m) => m._testing);
    const { EdictStore } = await import("../backends/edict-store.js");
    const { VerificationStore } = await import("../services/verification-store.js");
    const { IssueStore } = await import("../backends/issue-store.js");
    const { WorkflowStore } = await import("../backends/workflow-store.js");
    const { NarrativesDB } = await import("../backends/narratives-db.js");
    const { ProvenanceService } = await import("../services/provenance.js");
    const { EventLog } = await import("../backends/event-log.js");
    const { AuditStore } = await import("../backends/audit-store.js");

    const factsDb = new FactsDB(join(tmpDir, "facts.db"));
    const vectorDb = new VectorDB(join(tmpDir, "lance"), VECTOR_DIM);
    const edictStore = new EdictStore(join(tmpDir, "edicts.db"));
    const verificationStore = new VerificationStore(join(tmpDir, "verification.db"));
    const issueStore = new IssueStore(join(tmpDir, "issues.db"));
    const workflowStore = new WorkflowStore(join(tmpDir, "workflows.db"));
    const narrativesDb = new NarrativesDB(join(tmpDir, "narratives.db"));
    const provenanceService = new ProvenanceService(join(tmpDir, "provenance.db"));
    const eventLog = new EventLog(join(tmpDir, "event-log.db"));
    const auditStore = new AuditStore(join(tmpDir, "audit.db"));

    return {
      factsDb,
      vectorDb,
      edictStore,
      verificationStore,
      issueStore,
      workflowStore,
      narrativesDb,
      provenanceService,
      eventLog,
      auditStore,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      resolvedLancePath: join(tmpDir, "lance"),
    };
  }

  async function apiGet(port: number, path: string) {
    return new Promise<{ status: number; body: string }>((resolve) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ status: 0, body: "" });
      });
      req.end();
    });
  }

  async function apiPost(port: number, path: string, body: string) {
    return new Promise<{ status: number; body: string }>((resolve) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => {
            data += c.toString();
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ status: 0, body: "" });
      });
      req.end(body);
    });
  }

  function closeAll(ctx: Awaited<ReturnType<typeof makeContextWithStores>>) {
    try {
      ctx.factsDb.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.vectorDb.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.edictStore.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.verificationStore.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.issueStore.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.workflowStore.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.narrativesDb.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.provenanceService.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.eventLog.close();
    } catch {
      /* ignore */
    }
    try {
      ctx.auditStore.close();
    } catch {
      /* ignore */
    }
  }

  async function withServer(
    fn: (ctx: Awaited<ReturnType<typeof makeContextWithStores>>, port: number) => Promise<void>,
  ) {
    const td = mkdtempSync(join(tmpdir(), "mv-test-"));
    try {
      const ctx = await makeContextWithStores(td);
      const srv = await createDashboardServer(ctx, 0);
      try {
        await fn(ctx, srv.port);
      } finally {
        // Close stores first (before server), then server, then cleanup temp dir
        closeAll(ctx);
        srv.close();
      }
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  }

  it("GET /api/viewer/stats returns overview stats", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "Test fact", category: "fact", source: "test" });
      const { status, body } = await apiGet(port, "/api/viewer/stats");
      expect(status).toBe(200);
      const d = JSON.parse(body);
      expect(typeof d.totalFacts).toBe("number");
      expect(typeof d.byCategory).toBe("object");
      expect(typeof d.byTier).toBe("object");
    });
  });

  it("GET /api/viewer/facts returns a list of facts", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "Test fact", category: "fact", source: "test" });
      const { status, body } = await apiGet(port, "/api/viewer/facts");
      expect(status).toBe(200);
      const d = JSON.parse(body);
      expect(Array.isArray(d.facts)).toBe(true);
      expect(d.facts.length).toBeGreaterThan(0);
      expect(typeof d.facts[0].id).toBe("string");
    });
  });

  it("GET /api/viewer/facts/:id returns a single fact", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "Target fact", category: "fact", source: "test" });
      const { body: lb } = await apiGet(port, "/api/viewer/facts");
      const { facts } = JSON.parse(lb);
      const { status, body } = await apiGet(port, `/api/viewer/facts/${facts[0].id}`);
      expect(status).toBe(200);
      const f = JSON.parse(body);
      expect(f.id).toBe(facts[0].id);
      expect(typeof f.text).toBe("string");
    });
  });

  it("GET /api/viewer/facts/:id returns 404 for unknown id", async () => {
    await withServer(async (_ctx, port) => {
      const { status } = await apiGet(port, "/api/viewer/facts/00000000-0000-0000-0000-000000000000");
      expect(status).toBe(404);
    });
  });

  it("GET /api/viewer/issues returns issues array", async () => {
    await withServer(async (_ctx, port) => {
      const { status, body } = await apiGet(port, "/api/viewer/issues");
      expect(status).toBe(200);
      expect(Array.isArray(JSON.parse(body))).toBe(true);
    });
  });

  it("GET /api/viewer/edicts returns edicts array", async () => {
    await withServer(async (_ctx, port) => {
      const { status, body } = await apiGet(port, "/api/viewer/edicts");
      expect(status).toBe(200);
      expect(Array.isArray(JSON.parse(body))).toBe(true);
    });
  });

  it("GET /api/viewer/entities returns entities array", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "Entity test", category: "fact", source: "test", entity: "MyEntity" });
      const { status, body } = await apiGet(port, "/api/viewer/entities");
      expect(status).toBe(200);
      expect(Array.isArray(JSON.parse(body))).toBe(true);
    });
  });

  it("GET /api/viewer/workflows returns workflows array", async () => {
    await withServer(async (_ctx, port) => {
      const { status, body } = await apiGet(port, "/api/viewer/workflows");
      expect(status).toBe(200);
      expect(Array.isArray(JSON.parse(body))).toBe(true);
    });
  });

  it("POST /api/viewer/facts/:id/verify verifies a fact", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "To verify", category: "fact", source: "test" });
      const { body: lb } = await apiGet(port, "/api/viewer/facts");
      const { facts } = JSON.parse(lb);
      const target = facts.find((fact: { text: string; id: string }) => fact.text === "To verify");
      expect(target?.id).toBeTruthy();
      const { status, body } = await apiPost(
        port,
        `/api/viewer/facts/${target.id}/verify`,
        JSON.stringify({ verifiedBy: "agent" }),
      );
      expect(status).toBe(200);
      expect(JSON.parse(body).ok).toBe(true);
    });
  });

  it("POST /api/viewer/facts/:id/forget forgets a fact", async () => {
    await withServer(async (ctx, port) => {
      ctx.factsDb.store({ text: "To forget", category: "fact", source: "test" });
      const { body: lb } = await apiGet(port, "/api/viewer/facts");
      const { facts } = JSON.parse(lb);
      const target = facts.find((fact: { text: string; id: string }) => fact.text === "To forget");
      expect(target?.id).toBeTruthy();
      const { status, body } = await apiPost(port, `/api/viewer/facts/${target.id}/forget`, "{}");
      expect(status).toBe(200);
      expect(JSON.parse(body).ok).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Issue #1025 — Session Timeline
  // ----------------------------------------------------------------

  it("GET /api/viewer/timeline/sessions returns sessions array with totals", async () => {
    await withServer(async (ctx, port) => {
      const { status, body } = await apiGet(port, "/api/viewer/timeline/sessions");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data).toHaveProperty("sessions");
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data).toHaveProperty("totals");
      expect(data).toHaveProperty("allEventTypes");
      expect(Array.isArray(data.allEventTypes)).toBe(true);
      expect(typeof data.totals.totalSessions).toBe("number");
      expect(typeof data.totals.totalEvents).toBe("number");
    });
  });

  it("GET /api/viewer/timeline/sessions aggregates event log data", async () => {
    await withServer(async (ctx, port) => {
      const sessionId = "test-session-001";
      ctx.eventLog.append({
        sessionId,
        timestamp: new Date().toISOString(),
        eventType: "fact_learned",
        content: { text: "Test fact" },
        entities: ["TestEntity"],
      });
      ctx.eventLog.append({
        sessionId,
        timestamp: new Date().toISOString(),
        eventType: "decision_made",
        content: { text: "We decided to do X" },
      });
      ctx.eventLog.append({
        sessionId,
        timestamp: new Date().toISOString(),
        eventType: "preference_expressed",
        content: { text: "User prefers Y" },
      });

      const { status, body } = await apiGet(port, "/api/viewer/timeline/sessions");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      const session = data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(session).toBeDefined();
      expect(session.totalEvents).toBe(3);
      expect(session.capturedFacts).toBe(3); // fact_learned + decision_made + correction = captured
      expect(session.eventTypeCounts.fact_learned).toBe(1);
      expect(session.eventTypeCounts.decision_made).toBe(1);
      expect(session.eventTypeCounts.preference_expressed).toBe(1);
      expect(data.allEventTypes).toContain("fact_learned");
      expect(data.allEventTypes).toContain("decision_made");
      expect(data.allEventTypes).toContain("preference_expressed");
    });
  });

  it("GET /api/viewer/timeline/sessions aggregates audit events per session", async () => {
    await withServer(async (ctx, port) => {
      const sessionId = "audit-test-session";
      ctx.auditStore.append({
        agentId: "forge",
        action: "memory_recall",
        outcome: "success",
        sessionId,
        durationMs: 150,
      });
      ctx.auditStore.append({
        agentId: "forge",
        action: "exec",
        outcome: "failed",
        error: "Command failed",
        sessionId,
        durationMs: 300,
      });

      const { status, body } = await apiGet(port, "/api/viewer/timeline/sessions");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      const session = data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(session).toBeDefined();
      expect(session.auditEvents).toBe(2);
      expect(session.auditFailures).toBe(1);
    });
  });

  it("GET /api/viewer/timeline/sessions/:id returns detail with events", async () => {
    await withServer(async (ctx, port) => {
      const sessionId = "detail-session";
      ctx.eventLog.append({
        sessionId,
        timestamp: new Date().toISOString(),
        eventType: "entity_mentioned",
        content: { name: "Villa Polly" },
        entities: ["Villa Polly"],
      });

      const { status, body } = await apiGet(port, `/api/viewer/timeline/sessions/${sessionId}`);
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.sessionId).toBe(sessionId);
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events[0].eventType).toBe("entity_mentioned");
      expect(data.events[0].entities).toContain("Villa Polly");
    });
  });

  it("GET /api/viewer/timeline/sessions/:id returns 404 for unknown session", async () => {
    await withServer(async (ctx, port) => {
      const { status } = await apiGet(port, "/api/viewer/timeline/sessions/no-such-session-id");
      expect(status).toBe(404);
    });
  });

  it("GET /api/viewer/timeline/sessions includes injectedFacts count from audit", async () => {
    await withServer(async (ctx, port) => {
      const sessionId = "recall-test-session";
      // Three memory_recall events to simulate injected facts
      ctx.auditStore.append({ agentId: "maeve", action: "memory_recall", outcome: "success", sessionId });
      ctx.auditStore.append({ agentId: "maeve", action: "memory_recall", outcome: "success", sessionId });
      ctx.auditStore.append({ agentId: "maeve", action: "memory_recall", outcome: "success", sessionId });

      const { status, body } = await apiGet(port, "/api/viewer/timeline/sessions");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      const session = data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(session?.injectedFacts).toBe(3);
    });
  });

  it("GET /api/viewer/timeline/stats returns aggregate totals", async () => {
    await withServer(async (ctx, port) => {
      const { status, body } = await apiGet(port, "/api/viewer/timeline/stats");
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data).toHaveProperty("totals");
      expect(data).toHaveProperty("allEventTypes");
      expect(Array.isArray(data.allEventTypes)).toBe(true);
    });
  });
});
