import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import { buildPublicExportBundle } from "../services/public-export-bundle.js";
import { versionInfo } from "../versionInfo.js";

export interface HttpRouteOptions {
  authenticated: boolean;
}

export type HttpRequestHandler = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; headers?: Record<string, string>; body: string }>;

export interface PublicApiRoutesContext {
  cfg: {
    health: {
      enabled: boolean;
      authenticated: boolean;
    };
  };
  factsDb: FactsDB;
  narrativesDb: NarrativesDB | null;
}

export const PUBLIC_API_PREFIX = "/plugins/memory-public";

export const PUBLIC_API_PATHS = {
  health: "/health",
  search: "/search",
  timeline: "/timeline",
  stats: "/stats",
  export: "/export",
  fact: "/fact",
} as const;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function toJson(status: number, body: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

function parseReqUrl(url: string): URL {
  return new URL(url, "http://localhost");
}

function parseLimitParam(raw: string | null, fallback = 20, max = 200): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function extractFactId(url: URL): string | null {
  const byQuery = url.searchParams.get("id")?.trim();
  if (byQuery) return byQuery;

  const routePrefix = `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}/`;
  if (url.pathname.startsWith(routePrefix)) {
    try {
      const maybe = decodeURIComponent(url.pathname.slice(routePrefix.length)).trim();
      return maybe || null;
    } catch {
      return null;
    }
  }

  return null;
}

export function registerPublicApiRoutes(ctx: PublicApiRoutesContext, api: ClawdbotPluginApi): void {
  if (!ctx.cfg.health.enabled) return;
  if (typeof api.registerHttpRoute !== "function") return;

  const routeOpts: HttpRouteOptions = {
    authenticated: ctx.cfg.health.authenticated,
  };

  const makeRoute = (path: string, handler: HttpRequestHandler) =>
    (api.registerHttpRoute as (path: string, handler: HttpRequestHandler, opts: HttpRouteOptions) => void)(
      path,
      handler,
      routeOpts,
    );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.health}`,
    async () =>
      toJson(200, {
        status: "ok",
        plugin: "openclaw-hybrid-memory",
        version: {
          pluginVersion: versionInfo.pluginVersion,
          schemaVersion: versionInfo.schemaVersion,
        },
        endpoints: Object.values(PUBLIC_API_PATHS).map((path) => `${PUBLIC_API_PREFIX}${path}`),
      }),
  );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`,
    async (req) => {
      const url = parseReqUrl(req.url);
      const query = (url.searchParams.get("q") ?? "").trim();
      const limit = parseLimitParam(url.searchParams.get("limit"), 10, 100);

      if (!query) {
        return toJson(400, {
          error: 'Missing required query parameter "q"',
        });
      }

      const results = ctx.factsDb.search(query, limit, { tierFilter: "all" });
      return toJson(200, {
        query,
        limit,
        count: results.length,
        results,
      });
    },
  );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`,
    async (req) => {
      const url = parseReqUrl(req.url);
      const limit = parseLimitParam(url.searchParams.get("limit"), 20, 200);
      const facts = ctx.factsDb.list(limit);

      return toJson(200, {
        limit,
        count: facts.length,
        timeline: facts,
      });
    },
  );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`,
    async () => {
      const recentNarratives = ctx.narrativesDb?.listRecent(10, "all") ?? [];
      return toJson(200, {
        generatedAt: new Date().toISOString(),
        facts: {
          active: ctx.factsDb.count(),
          expired: ctx.factsDb.countExpired(),
          bySource: ctx.factsDb.statsBySource(),
          byCategory: ctx.factsDb.statsBreakdownByCategory(),
          byTier: ctx.factsDb.statsBreakdownByTier(),
          estimatedTokens: ctx.factsDb.estimateStoredTokens(),
        },
        episodes: {
          total: ctx.factsDb.episodesCount(),
        },
        procedures: {
          total: ctx.factsDb.proceduresCount(),
          validated: ctx.factsDb.proceduresValidatedCount(),
        },
        provenance: {
          links: ctx.factsDb.linksCount(),
        },
        narratives: {
          recent: recentNarratives.length,
        },
      });
    },
  );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`,
    async (req) => {
      const url = parseReqUrl(req.url);
      const limit = parseLimitParam(url.searchParams.get("limit"), 100, 1000);
      const narrativeLimit = parseLimitParam(url.searchParams.get("narrativeLimit"), 20, 500);

      const bundle = buildPublicExportBundle(ctx.factsDb, ctx.narrativesDb, {
        factsLimit: limit,
        episodesLimit: limit,
        proceduresLimit: limit,
        narrativesLimit: narrativeLimit,
        linksLimit: limit,
      });

      return toJson(200, bundle);
    },
  );

  makeRoute(
    `${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`,
    async (req) => {
      const url = parseReqUrl(req.url);
      const factId = extractFactId(url);
      if (!factId) {
        return toJson(400, {
          error: "Missing fact id. Use /fact?id=<uuid> (or /fact/<uuid> when supported by your gateway).",
        });
      }

      let resolvedId = factId;
      let fact = ctx.factsDb.getById(resolvedId);

      if (!fact && resolvedId.length >= 4) {
        const match = ctx.factsDb.findByIdPrefix(resolvedId);
        if (match && "ambiguous" in match) {
          return toJson(409, {
            error: `Fact id prefix is ambiguous (${match.count} matches). Use a longer id.`,
          });
        }
        if (match && "id" in match) {
          resolvedId = match.id;
          fact = ctx.factsDb.getById(resolvedId);
        }
      }

      if (!fact) {
        return toJson(404, {
          error: `Fact not found: ${factId}`,
        });
      }

      return toJson(200, {
        id: resolvedId,
        fact,
        links: {
          outgoing: ctx.factsDb.getLinksFrom(resolvedId),
          incoming: ctx.factsDb.getLinksTo(resolvedId),
        },
      });
    },
  );
}
