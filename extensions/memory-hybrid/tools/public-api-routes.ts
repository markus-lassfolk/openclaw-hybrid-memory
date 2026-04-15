import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import { buildPublicExportBundle } from "../services/public-export-bundle.js";
import type { ScopeFilter } from "../types/memory.js";
import { versionInfo } from "../versionInfo.js";
import type { HttpRequestHandler, HttpRouteOptions } from "./http-route-types.js";

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
const DEFAULT_PUBLIC_SCOPE_SENTINEL = "__public_api_unscoped__";

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

function getHeader(req: { headers?: Record<string, string> }, key: string): string | null {
  if (!req.headers) return null;
  const target = key.toLowerCase();
  for (const existing of Object.keys(req.headers)) {
    if (existing.toLowerCase() === target) {
      const raw = req.headers[existing];
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/**
 * SECURITY: identity headers must be populated by trusted gateway middleware.
 * Missing identity defaults to global-only visibility.
 */
function resolveScopeFilter(req: { headers?: Record<string, string> }): ScopeFilter {
  const userId = getHeader(req, "x-openclaw-user-id");
  const agentId = getHeader(req, "x-openclaw-agent-id");
  const sessionId = getHeader(req, "x-openclaw-session-id");

  if (!userId && !agentId && !sessionId) {
    return { agentId: DEFAULT_PUBLIC_SCOPE_SENTINEL };
  }

  return { userId: userId ?? undefined, agentId: agentId ?? undefined, sessionId: sessionId ?? undefined };
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

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.health}`, async () =>
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

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.search}`, async (req) => {
    const url = parseReqUrl(req.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = parseLimitParam(url.searchParams.get("limit"), 10, 100);
    const scopeFilter = resolveScopeFilter(req);

    if (!query) {
      return toJson(400, {
        error: 'Missing required query parameter "q"',
      });
    }

    const results = ctx.factsDb.search(query, limit, { tierFilter: "all", scopeFilter });
    return toJson(200, {
      query,
      limit,
      count: results.length,
      results,
    });
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.timeline}`, async (req) => {
    const url = parseReqUrl(req.url);
    const limit = parseLimitParam(url.searchParams.get("limit"), 20, 200);
    const scopeFilter = resolveScopeFilter(req);
    const facts = ctx.factsDb.getAll({ scopeFilter }).slice(0, limit);

    return toJson(200, {
      limit,
      count: facts.length,
      timeline: facts,
    });
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.stats}`, async (req) => {
    const scopeFilter = resolveScopeFilter(req);
    const scopedFacts = ctx.factsDb.getAll({ scopeFilter });
    
    const bySource: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byTier: Record<string, number> = { hot: 0, warm: 0, cold: 0, structural: 0 };
    let estimatedTokens = 0;
    
    for (const fact of scopedFacts) {
      bySource[fact.source] = (bySource[fact.source] || 0) + 1;
      byCategory[fact.category] = (byCategory[fact.category] || 0) + 1;
      const tier = fact.tier || "warm";
      byTier[tier] = (byTier[tier] || 0) + 1;
      const text = fact.summary || fact.text;
      estimatedTokens += Math.ceil(text.length / 4);
    }
    
    return toJson(200, {
      generatedAt: new Date().toISOString(),
      facts: {
        active: scopedFacts.length,
        expired: 0,
        bySource,
        byCategory,
        byTier,
        estimatedTokens,
      },
      episodes: {
        total: 0,
      },
      procedures: {
        total: 0,
        validated: 0,
      },
      provenance: {
        links: 0,
      },
      narratives: {
        recent: 0,
      },
    });
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.export}`, async (req) => {
    const url = parseReqUrl(req.url);
    const limit = parseLimitParam(url.searchParams.get("limit"), 100, 1000);
    const narrativeLimit = parseLimitParam(url.searchParams.get("narrativeLimit"), 20, 500);
    const scopeFilter = resolveScopeFilter(req);

    const bundle = buildPublicExportBundle(ctx.factsDb, ctx.narrativesDb, {
      factsLimit: limit,
      episodesLimit: limit,
      proceduresLimit: limit,
      narrativesLimit: narrativeLimit,
      linksLimit: limit,
      scopeFilter,
    });

    return toJson(200, bundle);
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.fact}`, async (req) => {
    const url = parseReqUrl(req.url);
    const factId = extractFactId(url);
    const scopeFilter = resolveScopeFilter(req);
    if (!factId) {
      return toJson(400, {
        error: "Missing fact id. Use /fact?id=<uuid> (or /fact/<uuid> when supported by your gateway).",
      });
    }

    let resolvedId = factId;
    let fact = ctx.factsDb.getById(resolvedId, { scopeFilter });

    if (!fact && resolvedId.length >= 4) {
      const prefixMatches = ctx.factsDb.findByIdPrefixScoped(resolvedId, scopeFilter);

      if (prefixMatches.ambiguous) {
        return toJson(409, {
          error: `Fact id prefix is ambiguous (${prefixMatches.count} matches). Use a longer id.`,
        });
      }
      if (prefixMatches.id) {
        resolvedId = prefixMatches.id;
        fact = ctx.factsDb.getById(resolvedId, { scopeFilter });
      }
    }

    if (!fact) {
      return toJson(404, {
        error: `Fact not found: ${factId}`,
      });
    }

    const outgoingLinks = ctx.factsDb.getLinksFrom(resolvedId);
    const incomingLinks = ctx.factsDb.getLinksTo(resolvedId);

    const linkedFactIds = [
      ...outgoingLinks.map((link) => link.targetFactId),
      ...incomingLinks.map((link) => link.sourceFactId),
    ];
    const scopedLinkedFacts = ctx.factsDb.getByIds(linkedFactIds, { scopeFilter });

    const filteredOutgoingLinks = outgoingLinks.filter((link) => scopedLinkedFacts.has(link.targetFactId));
    const filteredIncomingLinks = incomingLinks.filter((link) => scopedLinkedFacts.has(link.sourceFactId));

    return toJson(200, {
      id: resolvedId,
      fact,
      links: {
        outgoing: filteredOutgoingLinks,
        incoming: filteredIncomingLinks,
      },
    });
  });
}
