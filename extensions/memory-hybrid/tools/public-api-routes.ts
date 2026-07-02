import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type { AuditStore } from "../backends/audit-store.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig } from "../config.js";
import { isNonActionableSubagentPlaceholderTask } from "../services/active-task.js";
import {
  buildGatewayMemoryDiagnostics,
  buildProcessMemorySnapshot,
  sanitizePublicMemoryDiagnostics,
} from "../services/gateway-memory-diagnostics.js";
import { buildPublicExportBundle } from "../services/public-export-bundle.js";
import {
  applyActiveTaskProjectionFilters,
  getActiveTaskProjectionStatus,
  readActiveTaskRowsFromFacts,
  refreshActiveTaskProjectionBestEffort,
} from "../services/task-ledger-facts.js";
import { globalOnlyScopeFilter, scopeFieldsFromEntry, scopeFieldsFromFilter } from "../utils/scope-filter.js";
import { pluginLogger } from "../utils/logger.js";
import type { ScopeFilter } from "../types/memory.js";
import { parseDuration } from "../utils/duration.js";
import { nowIso } from "../utils/dates.js";
import { getEnv } from "../utils/env-manager.js";
import { resolveWorkspacePath } from "../utils/path.js";
import { versionInfo } from "../versionInfo.js";
import type { HttpRequestHandler, HttpRouteOptions } from "./http-route-types.js";
import { type SafeRouteLogger, createSafeRegisterHttpRoute } from "./safe-register-http-route.js";

type ActiveTaskConfigSubset = {
  enabled: boolean;
  ledger: "markdown" | "facts";
  filePath: string;
  staleThreshold: string;
  projection: ActiveTaskProjectionConfig;
};

type PublicApiConfig = {
  health: {
    enabled: boolean;
    authenticated: boolean;
  };
  activeTask?: Partial<ActiveTaskConfigSubset>;
};

export interface PublicApiRoutesContext {
  cfg: PublicApiConfig;
  factsDb: FactsDB;
  narrativesDb: NarrativesDB | null;
  vectorDb?: VectorDB;
  auditStore?: AuditStore | null;
  eventLog?: EventLog | null;
  resolvedSqlitePath?: string;
  resolvedLancePath?: string;
  recallInFlightRef?: { value: number };
  variantQueue?: { queueLength: number } | null;
  /** Resolved goals directory when goal stewardship is enabled (for projection mirror refresh). */
  goalsDir?: string;
  /** Enable fact mutation HTTP endpoints for wiki bidirectional editing. */
  factMutationsEnabled?: boolean;
}

export const PUBLIC_API_PREFIX = "/plugins/memory-public";

export const PUBLIC_API_PATHS = {
  health: "/health",
  search: "/search",
  timeline: "/timeline",
  stats: "/stats",
  export: "/export",
  fact: "/fact",
  session: "/session",
  activeTasks: "/active-tasks",
  processMemory: "/process-memory",
  memoryDiagnostics: "/memory-diagnostics",
} as const;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const DEFAULT_ACTIVE_TASK_PROJECTION: ActiveTaskProjectionConfig = {
  mode: "readable",
  excludeGenericTitle: true,
  titleMinChars: 0,
  dedupeBy: "none",
  sectioned: true,
};

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

function parseBooleanParam(raw: string | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Derive leak verdict from `leakHints` strings emitted by buildLeakHints.
 * `likely_leak` when repeated teardown or high native RSS hints are present.
 */
function readLeakVerdictFromHints(leakHints: string[]): "likely_leak" | "watch" | "ok" | "unknown" {
  if (!Array.isArray(leakHints) || leakHints.length === 0) return "ok";
  const hasRepeatedTeardown = leakHints.some((h) => h.startsWith("repeated_lance_sqlite_teardown"));
  const hasHighNativeRss = leakHints.some((h) => h.startsWith("native_rss_high_with_db_reuse"));
  if (hasRepeatedTeardown || hasHighNativeRss) return "likely_leak";
  return "watch";
}

const HEAP_SNAPSHOT_DIR = "memory/heap-snapshots";
const AUTO_SNAPSHOT_COOLDOWN_MS = 3_600_000; // 1 hour

let lastAutoSnapshotTimestamp = 0;

/** Test-only: reset the heap-snapshot auto-cooldown timestamp between test cases. */
export function resetHeapSnapshotCooldownForTests(): void {
  lastAutoSnapshotTimestamp = 0;
}

function resolveHeapSnapshotDir(): string {
  const override = getEnv("OPENCLAW_HEAP_SNAPSHOT_DIR");
  const base = override && override.trim().length > 0 ? override.trim() : HEAP_SNAPSHOT_DIR;
  return resolveWorkspacePath(base);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface HeapSnapshotMeta {
  path: string;
  bytes: number;
  trigger: "manual_query" | "auto_critical_leak";
  verdict: "likely_leak" | "watch" | "ok" | "unknown";
  pid: number;
  generatedAt: string;
  durationMs: number;
}

/**
 * Trigger a V8 heap snapshot and return metadata about it. No-ops (returns
 * null) on write failure so the diagnostics call still succeeds — a failing
 * snapshot should never break the operator's diagnostic view. Errors are
 * logged via pluginLogger so the operator can find them in the gateway log.
 */
function writeV8HeapSnapshotWithMeta(opts: {
  trigger: HeapSnapshotMeta["trigger"];
  verdict: HeapSnapshotMeta["verdict"];
}): HeapSnapshotMeta | null {
  const started = Date.now();
  let dir: string;
  try {
    dir = resolveHeapSnapshotDir();
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    pluginLogger.warn(
      `memory-diagnostics: failed to create heap snapshot dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const filename = `${timestampSlug()}-${process.pid}.heapsnapshot`;
  const fullPath = join(dir, filename);
  let actualPath: string = fullPath;
  try {
    actualPath = writeHeapSnapshot(fullPath);
  } catch (err) {
    pluginLogger.warn(
      `memory-diagnostics: v8.writeHeapSnapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  let bytes = 0;
  try {
    // v8.writeHeapSnapshot may rename the file with a sequence suffix on
    // collision; read the actual file size from whatever path it returned.
    bytes = statSync(actualPath).size;
  } catch {
    bytes = 0;
  }
  return {
    path: actualPath,
    bytes,
    trigger: opts.trigger,
    verdict: opts.verdict,
    pid: process.pid,
    generatedAt: nowIso(),
    durationMs: Date.now() - started,
  };
}

function resolveActiveTaskConfig(cfg: PublicApiConfig): ActiveTaskConfigSubset {
  const raw = cfg.activeTask ?? {};
  return {
    enabled: raw.enabled !== false,
    ledger: raw.ledger === "facts" ? "facts" : "markdown",
    filePath:
      typeof raw.filePath === "string" && raw.filePath.trim().length > 0 ? raw.filePath.trim() : "ACTIVE-TASKS.md",
    staleThreshold:
      typeof raw.staleThreshold === "string" && raw.staleThreshold.trim().length > 0
        ? raw.staleThreshold.trim()
        : "24h",
    projection:
      raw.projection && typeof raw.projection === "object"
        ? { ...DEFAULT_ACTIVE_TASK_PROJECTION, ...raw.projection }
        : { ...DEFAULT_ACTIVE_TASK_PROJECTION },
  };
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
    return globalOnlyScopeFilter();
  }

  return { userId: userId ?? undefined, agentId: agentId ?? undefined, sessionId: sessionId ?? undefined };
}

function rejectWhenUnauthenticated(
  authenticated: boolean,
): { status: number; headers: Record<string, string>; body: string } | null {
  if (!authenticated) {
    return toJson(403, { error: "authentication required" });
  }
  return null;
}

export function registerPublicApiRoutes(ctx: PublicApiRoutesContext, api: ClawdbotPluginApi): void {
  if (!ctx.cfg.health.enabled) return;
  if (typeof api.registerHttpRoute !== "function") return;

  const routeOpts: HttpRouteOptions = {
    authenticated: ctx.cfg.health.authenticated,
  };

  // Route paths flow through the safe wrapper so the OpenClaw 2026.5.4+
  // gateway no longer emits "http route registration missing path" warnings
  // (issue #1173): empty/whitespace paths are rejected with a clear error,
  // and trailing slashes are normalized.
  const logger = (api.logger ?? { warn: () => {} }) as SafeRouteLogger;
  const register = createSafeRegisterHttpRoute(api, logger, "memory-public");
  const makeRoute = (path: string, handler: HttpRequestHandler) => register(path, handler, routeOpts);
  const activeTaskCfg = resolveActiveTaskConfig(ctx.cfg);
  const activeTaskFilePath = resolveWorkspacePath(activeTaskCfg.filePath);
  const staleMinutes = (() => {
    try {
      return parseDuration(activeTaskCfg.staleThreshold);
    } catch {
      return parseDuration("24h");
    }
  })();

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
      generatedAt: nowIso(),
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
    const authReject = rejectWhenUnauthenticated(ctx.cfg.health.authenticated);
    if (authReject) return authReject;

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

      if (prefixMatches && "ambiguous" in prefixMatches && prefixMatches.ambiguous) {
        return toJson(409, {
          error: `Fact id prefix is ambiguous (${prefixMatches.count} matches). Use a longer id.`,
        });
      }
      if (prefixMatches && "id" in prefixMatches && prefixMatches.id) {
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

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.activeTasks}`, async (req) => {
    const url = parseReqUrl(req.url);
    const renderRequested = parseBooleanParam(url.searchParams.get("render"));
    if (renderRequested) {
      const authReject = rejectWhenUnauthenticated(ctx.cfg.health.authenticated);
      if (authReject) return authReject;
    }
    const includeCompleted = parseBooleanParam(url.searchParams.get("includeCompleted"));
    const scopeFilter = resolveScopeFilter(req);

    if (!activeTaskCfg.enabled) {
      return toJson(404, {
        error: "active_tasks_disabled",
      });
    }

    let renderApplied = false;
    let renderError: string | null = null;
    if (renderRequested) {
      if (activeTaskCfg.ledger !== "facts") {
        renderError = "render_requested_but_activeTask_ledger_is_not_facts";
      } else {
        const result = await refreshActiveTaskProjectionBestEffort({
          factsDb: ctx.factsDb,
          staleMinutes,
          filePath: activeTaskFilePath,
          projection: activeTaskCfg.projection,
          reason: "public_api_active_tasks_render",
          source: "public_api",
          logger: api.logger,
          goalsDir: ctx.goalsDir,
        });
        renderApplied = result.rendered;
        renderError = result.error ?? null;
      }
    }

    const rows = readActiveTaskRowsFromFacts(ctx.factsDb, staleMinutes, scopeFilter);
    const visibleActiveRows = applyActiveTaskProjectionFilters(rows.active, activeTaskCfg.projection);
    const projection = await getActiveTaskProjectionStatus(ctx.factsDb, activeTaskFilePath, {
      scopeFilter,
      latestProjectFactSec: rows.latestProjectFactSec,
    });
    const warnings: string[] = [];
    if (activeTaskCfg.ledger !== "facts") {
      warnings.push("activeTask.ledger is markdown; DB snapshot may diverge from markdown ledger.");
    }
    if (projection.stale) {
      warnings.push(`ACTIVE-TASKS.md projection is stale (${projection.staleReasons.join(", ")}).`);
    }

    return toJson(200, {
      generatedAt: nowIso(),
      source: "category:project",
      staleThresholdMinutes: staleMinutes,
      ledger: activeTaskCfg.ledger,
      active: visibleActiveRows,
      activeCount: visibleActiveRows.length,
      staleCount: visibleActiveRows.filter((row) => row.stale).length,
      ...(includeCompleted ? { completed: rows.completed, completedCount: rows.completed.length } : {}),
      projection,
      render: {
        requested: renderRequested,
        applied: renderApplied,
        error: renderError,
      },
      warnings,
    });
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.session}`, async (req) => {
    if (!ctx.cfg.health.authenticated) {
      return toJson(403, { error: "authentication required" });
    }
    const url = parseReqUrl(req.url);
    const trustedSessionId = getHeader(req, "x-openclaw-session-id");
    const trustedAgentId = getHeader(req, "x-openclaw-agent-id");
    const trustedUserId = getHeader(req, "x-openclaw-user-id");
    const querySessionId = url.searchParams.get("sessionId")?.trim() ?? null;
    const queryAgentId = url.searchParams.get("agentId")?.trim() ?? null;
    const limit = parseLimitParam(url.searchParams.get("limit"), 50, 200);

    if (trustedSessionId && querySessionId && querySessionId !== trustedSessionId) {
      return toJson(403, { error: "sessionId query param does not match trusted identity header" });
    }
    if (trustedAgentId && queryAgentId && queryAgentId !== trustedAgentId) {
      return toJson(403, { error: "agentId query param does not match trusted identity header" });
    }

    const sessionId = trustedSessionId ?? querySessionId;
    const agentId = trustedAgentId ?? queryAgentId;

    if (!sessionId && !agentId) {
      return toJson(400, {
        error:
          "Missing sessionId or agentId. Provide x-openclaw-session-id / x-openclaw-agent-id headers or matching query params.",
      });
    }

    if (!trustedSessionId && !trustedAgentId && !trustedUserId && (querySessionId || queryAgentId)) {
      return toJson(403, {
        error: "Untrusted session/agent query params require gateway identity headers",
      });
    }

    const { buildSessionObservabilityReport } = await import("../services/session-observability.js");

    const report = await buildSessionObservabilityReport({
      factsDb: ctx.factsDb,
      eventLog: ctx.eventLog ?? null,
      narrativesDb: ctx.narrativesDb ?? null,
      auditStore: ctx.auditStore ?? null,
      sessionId,
      agentId,
      limit,
    });

    return toJson(200, report);
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.processMemory}`, async (req) => {
    if (!ctx.cfg.health.authenticated) {
      return toJson(403, { error: "authentication required" });
    }
    return toJson(200, buildProcessMemorySnapshot());
  });

  makeRoute(`${PUBLIC_API_PREFIX}${PUBLIC_API_PATHS.memoryDiagnostics}`, async (req) => {
    if (!ctx.cfg.health.authenticated) {
      return toJson(403, { error: "authentication required" });
    }
    if (!ctx.vectorDb) {
      return toJson(503, { error: "vector_db_unavailable" });
    }
    const url = parseReqUrl(req.url);
    const heapSnapshotRequested = parseBooleanParam(url.searchParams.get("heapSnapshot"));
    const diag = sanitizePublicMemoryDiagnostics(
      await buildGatewayMemoryDiagnostics({
        factsDb: ctx.factsDb,
        vectorDb: ctx.vectorDb,
        resolvedSqlitePath: ctx.resolvedSqlitePath,
        resolvedLancePath: ctx.resolvedLancePath,
        recallInFlightRef: ctx.recallInFlightRef,
        variantQueuePending: ctx.variantQueue?.queueLength,
      }),
    );
    const leakVerdict = readLeakVerdictFromHints(diag.leakHints);
    const autoMode = (getEnv("OPENCLAW_HEAP_SNAPSHOT_AUTO") ?? "").trim().toLowerCase();
    const now = Date.now();
    const timeSinceLastAuto = now - lastAutoSnapshotTimestamp;
    const shouldAutoSnapshot =
      !heapSnapshotRequested &&
      autoMode === "critical" &&
      leakVerdict === "likely_leak" &&
      timeSinceLastAuto >= AUTO_SNAPSHOT_COOLDOWN_MS;
    if (shouldAutoSnapshot) {
      // Reserve the cooldown slot synchronously, before the (blocking) snapshot write, and
      // regardless of whether the write succeeds. Setting it only after a successful write left
      // the cooldown permanently disengaged on persistent failure (e.g. an unwritable snapshot
      // dir) — every subsequent diagnostics request during an ongoing "likely_leak" incident would
      // retry the full mkdirSync + writeHeapSnapshot pipeline instead of waiting out the cooldown.
      lastAutoSnapshotTimestamp = now;
    }
    if (heapSnapshotRequested || shouldAutoSnapshot) {
      const snap = writeV8HeapSnapshotWithMeta({
        trigger: shouldAutoSnapshot ? "auto_critical_leak" : "manual_query",
        verdict: leakVerdict,
      });
      return toJson(200, { ...diag, heapSnapshot: snap });
    }
    return toJson(200, diag);
  });

  // ========================================================================
  // Fact mutation endpoints (wiki bidirectional editing)
  // ========================================================================
  if (ctx.factMutationsEnabled) {
    makeRoute(`${PUBLIC_API_PREFIX}/fact/mutate`, async (req) => {
      if (!ctx.cfg.health.authenticated) {
        return toJson(403, { error: "authentication required" });
      }
      try {
        const scopeFilter = resolveScopeFilter(req);
        const body = req.body ? JSON.parse(req.body) : {};
        const action = typeof body.action === "string" ? body.action : "";
        const factId = typeof body.id === "string" ? body.id : "";

        if (action === "update" && factId) {
          const existing = ctx.factsDb.getById(factId, { scopeFilter });
          if (!existing) return toJson(404, { error: "not found" });

          const text = typeof body.text === "string" ? body.text : null;
          const confidence = typeof body.confidence === "number" ? body.confidence : null;
          const entity = typeof body.entity === "string" ? body.entity : null;
          const key = typeof body.key === "string" ? body.key : null;
          const value = typeof body.value === "string" ? body.value : null;
          const tags = Array.isArray(body.tags)
            ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : undefined;

          const hasStructural =
            text !== null || entity !== null || key !== null || value !== null || tags !== undefined;

          if (hasStructural) {
            const stored = ctx.factsDb.store({
              text: text ?? existing.text,
              category: existing.category,
              importance: existing.importance,
              source: "wiki-edit",
              entity: entity ?? existing.entity,
              key: key ?? existing.key,
              value: value ?? existing.value,
              confidence: confidence !== null ? Math.max(0, Math.min(1, confidence)) : existing.confidence,
              tags: tags ?? existing.tags ?? undefined,
              ...scopeFieldsFromEntry(existing),
            });
            ctx.factsDb.supersede(factId, stored.id);
            pluginLogger.info(
              `memory-hybrid: fact ${factId} updated (superseded → ${stored.id}) via HTTP /fact/mutate`,
            );
            return toJson(200, {
              ok: true,
              superseded: factId,
              newFact: ctx.factsDb.getById(stored.id, { scopeFilter }),
            });
          } else if (confidence !== null) {
            ctx.factsDb.setConfidenceTo(factId, Math.max(0, Math.min(1, confidence)));
            pluginLogger.info(`memory-hybrid: fact ${factId} confidence updated via HTTP /fact/mutate`);
            return toJson(200, { ok: true, fact: ctx.factsDb.getById(factId, { scopeFilter }) });
          }
          return toJson(200, { ok: true, noop: true });
        }

        if (action === "supersede" && factId) {
          const existing = ctx.factsDb.getById(factId, { scopeFilter });
          if (!existing) return toJson(404, { error: "not found" });

          const replacement = typeof body.replacementText === "string" ? body.replacementText.trim() : "";
          if (replacement) {
            const stored = ctx.factsDb.store({
              text: replacement,
              category: existing.category,
              importance: existing.importance,
              source: "wiki-edit",
              entity: existing.entity ?? null,
              key: existing.key ?? null,
              value: existing.value ?? null,
              confidence: existing.confidence,
              tags: existing.tags ?? undefined,
              ...scopeFieldsFromEntry(existing),
            });
            ctx.factsDb.supersede(factId, stored.id);
            pluginLogger.info(`memory-hybrid: fact ${factId} superseded by ${stored.id} via HTTP /fact/mutate`);
            return toJson(200, {
              ok: true,
              superseded: factId,
              newFact: ctx.factsDb.getById(stored.id, { scopeFilter }) ?? stored,
            });
          }

          ctx.factsDb.supersede(factId, null);
          pluginLogger.info(`memory-hybrid: fact ${factId} superseded (removed) via HTTP /fact/mutate`);
          return toJson(200, { ok: true, superseded: factId });
        }

        if (action === "create") {
          const text = typeof body.text === "string" ? body.text?.trim() : "";
          if (!text) return toJson(400, { error: "missing text" });
          const stored = ctx.factsDb.store({
            text,
            category: (typeof body.category === "string"
              ? body.category
              : "general") as import("../config.js").MemoryCategory,
            importance: typeof body.importance === "number" ? body.importance : 0.5,
            source: "wiki-create",
            entity: typeof body.entity === "string" ? body.entity : null,
            key: typeof body.key === "string" ? body.key : null,
            value: typeof body.value === "string" ? body.value : null,
            confidence: typeof body.confidence === "number" ? Math.max(0, Math.min(1, body.confidence)) : 0.8,
            tags: Array.isArray(body.tags)
              ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
              : undefined,
            ...scopeFieldsFromFilter(scopeFilter),
          });
          pluginLogger.info(`memory-hybrid: fact ${stored.id} created via HTTP /fact/mutate`);
          return toJson(201, { ok: true, fact: ctx.factsDb.getById(stored.id, { scopeFilter }) ?? stored });
        }

        return toJson(400, { error: `unknown action: ${action}` });
      } catch (err) {
        return toJson(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}
