// @ts-nocheck

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { FactsDB } from "../backends/facts-db.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import {
  PUBLIC_API_PATHS,
  PUBLIC_API_PREFIX,
  registerPublicApiRoutes,
  type HttpRequestHandler,
  type HttpRouteOptions,
} from "../tools/public-api-routes.js";

interface RouteRegistration {
  path: string;
  handler: HttpRequestHandler;
  opts: HttpRouteOptions;
}

describe("registerPublicApiRoutes", () => {
  let tmp: string;
  let factsDb: FactsDB;
  let narrativesDb: NarrativesDB;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "public-api-routes-"));
    factsDb = new FactsDB(join(tmp, "facts.db"));
    narrativesDb = new NarrativesDB(join(tmp, "narratives.db"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeApi(): { api: ClawdbotPluginApi; routes: RouteRegistration[] } {
    const routes: RouteRegistration[] = [];
    const api = {
      registerHttpRoute: (path: string, handler: HttpRequestHandler, opts: HttpRouteOptions) => {
        routes.push({ path, handler, opts });
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ClawdbotPluginApi;
    return { api, routes };
  }

  function fakeReq(url: string): { method: string; url: string; headers: Record<string, string> } {
    return { method: "GET", url, headers: {} };
  }

  it("registers all public surface routes", () => {
    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: { health: { enabled: true, authenticated: true } },
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
        cfg: { health: { enabled: true, authenticated: false } },
        factsDb,
        narrativesDb,
      },
      api,
    );

    const search = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`)!;
    const searchRes = await search.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}?q=demo&limit=5`));
    expect(searchRes.status).toBe(200);
    expect(JSON.parse(searchRes.body).count).toBeGreaterThanOrEqual(1);

    const timeline = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`)!;
    const timelineRes = await timeline.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}?limit=1`));
    expect(timelineRes.status).toBe(200);
    expect(JSON.parse(timelineRes.body).timeline).toHaveLength(1);

    const stats = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`)!;
    const statsRes = await stats.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`));
    expect(statsRes.status).toBe(200);
    expect(JSON.parse(statsRes.body).facts.active).toBeGreaterThanOrEqual(1);

    const exported = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`)!;
    const exportRes = await exported.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}?limit=10`));
    expect(exportRes.status).toBe(200);
    expect(JSON.parse(exportRes.body).manifest.counts.facts).toBeGreaterThanOrEqual(1);

    const fact = routes.find((r) => r.path === `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`)!;
    const factRes = await fact.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=${stored.id}`));
    expect(factRes.status).toBe(200);
    expect(JSON.parse(factRes.body).id).toBe(stored.id);

    const badSearchRes = await search.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`));
    expect(badSearchRes.status).toBe(400);

    const missingFactRes = await fact.handler(fakeReq(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}?id=missing`));
    expect(missingFactRes.status).toBe(404);
  });

  it("does not register routes when health is disabled", () => {
    const { api, routes } = makeApi();
    registerPublicApiRoutes(
      {
        cfg: { health: { enabled: false, authenticated: true } },
        factsDb,
        narrativesDb,
      },
      api,
    );

    expect(routes).toHaveLength(0);
  });
});
