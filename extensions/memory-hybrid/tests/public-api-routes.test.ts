// @ts-nocheck

import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { invokeNodeHttpRoute } from "./helpers/invoke-node-http-route.js";
import type { RegisterHttpRouteGatewayParams } from "../tools/http-route-types.js";
import {
  type HttpRouteOptions,
  PUBLIC_API_PATHS,
  PUBLIC_API_PREFIX,
  registerPublicApiRoutes,
} from "../tools/public-api-routes.js";

interface RouteRegistration {
  path: string;
  handler: RegisterHttpRouteGatewayParams["handler"];
  opts: HttpRouteOptions;
}

describe("registerPublicApiRoutes", () => {
  let tmp: string;
  let factsDb: FactsDB;
  let narrativesDb: NarrativesDB;
  let prevWorkspace: string | undefined;

  beforeEach(() => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    tmp = mkdtempSync(join(tmpdir(), "public-api-routes-"));
    process.env.OPENCLAW_WORKSPACE = tmp;
    factsDb = new FactsDB(join(tmp, "facts.db"));
    narrativesDb = new NarrativesDB(join(tmp, "narratives.db"));
  });

  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = prevWorkspace;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeApi(): { api: ClawdbotPluginApi; routes: RouteRegistration[] } {
    const routes: RouteRegistration[] = [];
    const api = {
      registerHttpRoute: (params: RegisterHttpRouteGatewayParams) => {
        routes.push({
          path: params.path,
          handler: params.handler,
          opts: { authenticated: params.auth === "gateway" },
        });
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ClawdbotPluginApi;
    return { api, routes };
  }

  function fakeReq(url: string): { method: string; url: string; headers: Record<string, string> } {
    return { method: "GET", url, headers: {} };
  }

  function makeCfg(
    authenticated: boolean,
    overrides: Partial<{
      ledger: "markdown" | "facts";
      filePath: string;
      staleThreshold: string;
      projection: Record<string, unknown>;
    }> = {},
  ) {
    return {
      health: { enabled: true, authenticated },
      activeTask: {
        enabled: true,
        ledger: overrides.ledger ?? "markdown",
        filePath: overrides.filePath ?? "ACTIVE-TASKS.md",
        staleThreshold: overrides.staleThreshold ?? "24h",
        projection: overrides.projection ?? { sectioned: true },
      },
    };
  }

  it("registers all public surface routes", () => {
    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: makeCfg(true),
        factsDb,
        narrativesDb,
      },
      api,
    );

    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.health}`,
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`,
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`,
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`,
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`,
        `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`,
      ]),
    );

    const authValues = [...new Set(routes.map((r) => r.opts.authenticated))];
    expect(authValues).toEqual([true]);
  });

  it("serves search, timeline, stats, export, and fact endpoints", async () => {
    const stored = factsDb.store({
      text: "Public API surface should be easy to demo",
      category: "decision",
      importance: 0.8,
      entity: "project",
      key: "public_api",
      value: "enabled",
      source: "conversation",
    });

    factsDb.recordEpisode({
      event: "Delivered public API routes",
      outcome: "success",
      relatedFactIds: [stored.id],
    });

    factsDb.upsertProcedure({
      taskPattern: "Store search inspect forget memory",
      recipeJson: JSON.stringify([{ tool: "memory_store" }, { tool: "memory_forget" }]),
      procedureType: "positive",
      confidence: 0.7,
      ttlDays: 30,
    });

    narrativesDb.store({
      sessionId: "s-public-api",
      periodStart: Math.floor(Date.now() / 1000) - 120,
      periodEnd: Math.floor(Date.now() / 1000),
      tag: "session",
      narrativeText: "Added public surface endpoints and docs.",
    });

    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: makeCfg(false),
        factsDb,
        narrativesDb,
      },
      api,
    );

    const search = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`)!;
    const searchRes = await invokeNodeHttpRoute(
      search.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}?q=demo&limit=5`),
    );
    expect(searchRes.status).toBe(200);
    expect(JSON.parse(searchRes.body).count).toBeGreaterThanOrEqual(1);

    const timeline = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`)!;
    const timelineRes = await invokeNodeHttpRoute(
      timeline.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}?limit=1`),
    );
    expect(timelineRes.status).toBe(200);
    expect(JSON.parse(timelineRes.body).timeline).toHaveLength(1);

    const stats = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`)!;
    const statsRes = await invokeNodeHttpRoute(stats.handler, fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`));
    expect(statsRes.status).toBe(200);
    expect(JSON.parse(statsRes.body).facts.active).toBeGreaterThanOrEqual(1);

    const exported = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`)!;
    const exportRes = await invokeNodeHttpRoute(
      exported.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}?limit=10`),
    );
    expect(exportRes.status).toBe(200);
    expect(JSON.parse(exportRes.body).manifest.counts.facts).toBeGreaterThanOrEqual(1);

    const fact = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`)!;
    const factRes = await invokeNodeHttpRoute(
      fact.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=${stored.id}`),
    );
    expect(factRes.status).toBe(200);
    expect(JSON.parse(factRes.body).id).toBe(stored.id);

    const badSearchRes = await invokeNodeHttpRoute(
      search.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`),
    );
    expect(badSearchRes.status).toBe(400);

    const missingFactRes = await invokeNodeHttpRoute(
      fact.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=missing`),
    );
    expect(missingFactRes.status).toBe(404);
  });

  it("applies scope filtering to search, timeline, export, and fact endpoints", async () => {
    const globalFact = factsDb.store({
      text: "Global fact visible to all",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
      scopeTarget: null,
    });

    const agentAFact = factsDb.store({
      text: "Agent A secret",
      category: "fact",
      importance: 0.9,
      entity: "agent",
      key: "name",
      value: "A",
      source: "conversation",
      scope: "agent",
      scopeTarget: "agent-a",
    });

    const agentBFact = factsDb.store({
      text: "Agent B secret",
      category: "fact",
      importance: 0.9,
      entity: "agent",
      key: "name",
      value: "B",
      source: "conversation",
      scope: "agent",
      scopeTarget: "agent-b",
    });

    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: makeCfg(true),
        factsDb,
        narrativesDb,
      },
      api,
    );

    const scopedReq = (url: string) => ({
      method: "GET",
      url,
      headers: { "x-openclaw-agent-id": "agent-a" },
    });

    const search = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`)!;
    const searchRes = await invokeNodeHttpRoute(
      search.handler,
      scopedReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}?q=secret&limit=10`) as ReturnType<typeof fakeReq>,
    );
    expect(searchRes.status).toBe(200);
    const searchBody = JSON.parse(searchRes.body);
    expect(searchBody.results.map((r: { entry: { id: string } }) => r.entry.id)).toContain(agentAFact.id);
    expect(searchBody.results.map((r: { entry: { id: string } }) => r.entry.id)).not.toContain(agentBFact.id);

    const timeline = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`)!;
    const timelineRes = await invokeNodeHttpRoute(
      timeline.handler,
      scopedReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}?limit=10`) as ReturnType<typeof fakeReq>,
    );
    expect(timelineRes.status).toBe(200);
    const timelineIds = JSON.parse(timelineRes.body).timeline.map((f: { id: string }) => f.id);
    expect(timelineIds).toContain(globalFact.id);
    expect(timelineIds).toContain(agentAFact.id);
    expect(timelineIds).not.toContain(agentBFact.id);

    const exported = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`)!;
    const exportRes = await invokeNodeHttpRoute(
      exported.handler,
      scopedReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}?limit=10`) as ReturnType<typeof fakeReq>,
    );
    expect(exportRes.status).toBe(200);
    const exportIds = JSON.parse(exportRes.body).facts.map((f: { id: string }) => f.id);
    expect(exportIds).toContain(globalFact.id);
    expect(exportIds).toContain(agentAFact.id);
    expect(exportIds).not.toContain(agentBFact.id);

    const fact = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`)!;
    const allowedFact = await invokeNodeHttpRoute(
      fact.handler,
      scopedReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=${agentAFact.id}`) as ReturnType<typeof fakeReq>,
    );
    expect(allowedFact.status).toBe(200);
    const deniedFact = await invokeNodeHttpRoute(
      fact.handler,
      scopedReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=${agentBFact.id}`) as ReturnType<typeof fakeReq>,
    );
    expect(deniedFact.status).toBe(404);
  });

  it("active-tasks endpoint reports stale projection and can render on request", async () => {
    factsDb.store({
      text: "Task title: Ship active-task endpoint",
      category: "project",
      importance: 0.9,
      entity: "task-1272",
      key: "title",
      value: "Ship active-task endpoint",
      source: "conversation",
    });
    factsDb.store({
      text: "Task status: in progress",
      category: "project",
      importance: 0.9,
      entity: "task-1272",
      key: "status",
      value: "in_progress",
      source: "conversation",
    });

    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: makeCfg(true, { ledger: "facts", staleThreshold: "4h", filePath: "ACTIVE-TASKS.md" }),
        factsDb,
        narrativesDb,
      },
      api,
    );

    const activeTasksRoute = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`)!;
    const firstRes = await invokeNodeHttpRoute(
      activeTasksRoute.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`),
    );
    expect(firstRes.status).toBe(200);
    const firstBody = JSON.parse(firstRes.body);
    expect(firstBody.activeCount).toBe(1);
    expect(firstBody.projection.stale).toBe(true);
    expect(firstBody.projection.staleReasons).toContain("projection_missing");

    const renderRes = await invokeNodeHttpRoute(
      activeTasksRoute.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}?render=1&includeCompleted=1`),
    );
    expect(renderRes.status).toBe(200);
    const renderBody = JSON.parse(renderRes.body);
    expect(renderBody.render.applied).toBe(true);
    expect(renderBody.projection.stale).toBe(false);
    expect(renderBody.completedCount).toBe(0);

    const projectionPath = join(tmp, "ACTIVE-TASKS.md");
    const projectionText = readFileSync(projectionPath, "utf-8");
    expect(projectionText).toContain("**Projection** of hybrid-memory `category:project` facts");

    const staleTime = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(projectionPath, staleTime, staleTime);
    factsDb.store({
      text: "Task next: wire tests",
      category: "project",
      importance: 0.8,
      entity: "task-1272",
      key: "next",
      value: "Wire tests",
      source: "conversation",
    });

    const staleAgainRes = await invokeNodeHttpRoute(
      activeTasksRoute.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`),
    );
    expect(staleAgainRes.status).toBe(200);
    const staleAgain = JSON.parse(staleAgainRes.body);
    expect(staleAgain.projection.stale).toBe(true);
    expect(staleAgain.projection.staleReasons).toContain("project_facts_newer_than_projection");
  });

  it("active-tasks endpoint applies scope filtering", async () => {
    factsDb.store({
      text: "Global task title",
      category: "project",
      importance: 0.9,
      entity: "task-global",
      key: "title",
      value: "Global task",
      source: "conversation",
      scope: "global",
      scopeTarget: null,
    });
    factsDb.store({
      text: "Global task status",
      category: "project",
      importance: 0.9,
      entity: "task-global",
      key: "status",
      value: "in_progress",
      source: "conversation",
      scope: "global",
      scopeTarget: null,
    });
    factsDb.store({
      text: "Scoped task title",
      category: "project",
      importance: 0.9,
      entity: "task-agent-a",
      key: "title",
      value: "Agent A task",
      source: "conversation",
      scope: "agent",
      scopeTarget: "agent-a",
    });
    factsDb.store({
      text: "Scoped task status",
      category: "project",
      importance: 0.9,
      entity: "task-agent-a",
      key: "status",
      value: "in_progress",
      source: "conversation",
      scope: "agent",
      scopeTarget: "agent-a",
    });

    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: makeCfg(true, { ledger: "facts", staleThreshold: "4h", filePath: "ACTIVE-TASKS.md" }),
        factsDb,
        narrativesDb,
      },
      api,
    );

    const activeTasksRoute = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`)!;

    const unscopedRes = await invokeNodeHttpRoute(
      activeTasksRoute.handler,
      fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`),
    );
    expect(unscopedRes.status).toBe(200);
    const unscopedBody = JSON.parse(unscopedRes.body);
    expect(unscopedBody.active.map((row: { label: string }) => row.label)).toContain("task-global");
    expect(unscopedBody.active.map((row: { label: string }) => row.label)).not.toContain("task-agent-a");

    const scopedReq = {
      method: "GET",
      url: `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`,
      headers: { "x-openclaw-agent-id": "agent-a" },
    };
    const scopedRes = await invokeNodeHttpRoute(activeTasksRoute.handler, scopedReq as ReturnType<typeof fakeReq>);
    expect(scopedRes.status).toBe(200);
    const scopedBody = JSON.parse(scopedRes.body);
    expect(scopedBody.active.map((row: { label: string }) => row.label)).toContain("task-global");
    expect(scopedBody.active.map((row: { label: string }) => row.label)).toContain("task-agent-a");
  });

  it("active-tasks endpoint returns 404 when activeTask is disabled", async () => {
    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: {
          ...makeCfg(true, { ledger: "facts" }),
          activeTask: { ...makeCfg(true, { ledger: "facts" }).activeTask, enabled: false },
        },
        factsDb,
        narrativesDb,
      },
      api,
    );

    const activeTasksRoute = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`)!;
    const res = await invokeNodeHttpRoute(activeTasksRoute.handler, fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("active_tasks_disabled");
  });

  it("does not register routes when health is disabled", () => {
    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: { ...makeCfg(true), health: { enabled: false, authenticated: true } },
        factsDb,
        narrativesDb,
      },
      api,
    );

    expect(routes).toHaveLength(0);
  });
});
