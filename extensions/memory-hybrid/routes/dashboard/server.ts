/**
 * Mission Control Dashboard — Issue #309
 *
 * Serves a web dashboard via a small HTTP server registered as a plugin service.
 * Routes:
 *   GET /           — HTML dashboard (vanilla JS/CSS, no framework)
 *   GET /api/status — JSON data for all dashboard sections
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { VerificationStore } from "../../services/verification-store.js";
import { pluginLogger } from "../../utils/logger.js";
import { execFile as execFileCb } from "../../utils/process-runner.js";
import { parseTags } from "../../utils/tags.js";
import { collectGraphPayload, collectGraphRecallPayload, getGraphExplorerHtml } from "../dashboard-graph.js";
import { getRecallStatsSnapshot } from "../../services/recall-timing-stats.js";

const _execFile = promisify(execFileCb);
const _require = createRequire(import.meta.url);

const MAX_DASHBOARD_JSON_BODY_BYTES = 64 * 1024;
const _VERIFIED_FACT_SET_TTL_MS = 5000;
const _verifiedFactIdCacheByStore = new WeakMap<VerificationStore, { at: number; ids: Set<string> }>();

import {
  collectAgentHealth,
  collectAuditSummary,
  collectMemoryViewerEdicts,
  collectMemoryViewerEntities,
  collectMemoryViewerEpisodes,
  collectMemoryViewerIssues,
  collectMemoryViewerLinks,
  collectMemoryViewerCorrelation,
  collectMemoryViewerNarratives,
  collectMemoryViewerProvenance,
  collectMemoryViewerStats,
  collectMemoryViewerVerified,
  collectMemoryViewerWorkflows,
  collectStatus,
  getVerifiedFactIdSet,
  type MemoryViewerFact,
  parseUrlPathSegment,
  performFactAction,
  readJsonBody,
  type DashboardContext,
} from "./collectors.js";
import {
  applyWorkshopProposal,
  collectDreamCycleLog,
  collectSkillTelemetry,
  collectWorkshopDigest,
  collectWorkshopChanges,
  collectWorkshopProposalDetail,
  collectWorkshopProposals,
  quarantineWorkshopProposal,
  rejectWorkshopProposal,
  reviseWorkshopProposal,
  revertWorkshopChange,
  undoWorkshopProposal,
  type WorkshopDashboardContext,
} from "./workshop-collectors.js";
import { getDashboardHtml } from "./html.js";
import { DEFAULT_WORKSHOP_LIST_LIMIT, isWorkshopEnabled } from "../../services/workshop-config.js";

function workshopClientError(err: unknown, route: string): string {
  pluginLogger.error(`[dashboard-server] ${route}: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.message === "Request body too large") return err.message;
  return "Request failed";
}

function workshopCtx(ctx: DashboardContext): WorkshopDashboardContext | null {
  if (!ctx.hybridCfg || !isWorkshopEnabled(ctx.hybridCfg)) return null;
  return {
    cfg: ctx.hybridCfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    changeFeed: ctx.changeFeed ?? null,
    dreamCycleLogDir: ctx.dreamCycleLogDir,
  };
}

export interface DashboardServer {
  server: Server;
  port: number;
  close(): void;
}

export async function createDashboardServer(ctx: DashboardContext, port: number): Promise<DashboardServer> {
  const { createGraphQLServer } = await import("../graphql-server.js");
  const { yoga } = createGraphQLServer(ctx.factsDb, ctx.vectorDb, {
    config: ctx.cfg,
    factsDb: ctx.factsDb,
    vectorDb: ctx.vectorDb,
    embeddings: ctx.embeddings,
    embeddingRegistry: ctx.embeddingRegistry,
  });

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    let pathname: string;
    let searchParams: URLSearchParams;
    try {
      const parsed = new URL(url, "http://127.0.0.1");
      pathname = parsed.pathname;
      searchParams = parsed.searchParams;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    if (pathname === "/graph" || pathname === "/graph.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(getGraphExplorerHtml());
      return;
    }

    if (pathname === "/api/graph") {
      try {
        const days = Math.min(365, Math.max(1, Number.parseInt(searchParams.get("days") ?? "30", 10) || 30));
        const maxNodes = Math.min(
          2000,
          Math.max(20, Number.parseInt(searchParams.get("maxNodes") ?? "400", 10) || 400),
        );
        const body = JSON.stringify(collectGraphPayload(ctx.factsDb, days, maxNodes));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/graph: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/graph/recall") {
      try {
        const q = searchParams.get("query") ?? searchParams.get("q") ?? "";
        const body = JSON.stringify(collectGraphRecallPayload(ctx.factsDb, q, ctx.graphHubDegreeCap));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/graph/recall: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/agents/health") {
      collectAgentHealth(ctx)
        .then((payload) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(JSON.stringify(payload));
        })
        .catch((_err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "InternalServerError" }));
        });
      return;
    }

    if (pathname === "/api/audit/summary") {
      try {
        const body = JSON.stringify(collectAuditSummary(ctx));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(
          `[dashboard-server] /api/audit/summary: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/audit/events") {
      if (!ctx.auditStore) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "audit store unavailable" }));
        return;
      }
      try {
        const hours = Math.min(720, Math.max(1, Number.parseInt(searchParams.get("hours") ?? "24", 10) || 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const agentId = searchParams.get("agent") ?? undefined;
        const outcome = searchParams.get("outcome") as "success" | "partial" | "failed" | null;
        const targetContains = searchParams.get("targetContains") ?? searchParams.get("target") ?? undefined;
        const rows = ctx.auditStore.query({
          sinceMs,
          agentId,
          outcome: outcome === "success" || outcome === "partial" || outcome === "failed" ? outcome : undefined,
          targetContains,
          limit: 2000,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ events: rows }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/audit/events: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    // GET /api/viewer/stats
    if (pathname === "/api/viewer/stats") {
      collectMemoryViewerStats(ctx)
        .then((stats) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(JSON.stringify(stats));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    if (pathname === "/api/viewer/recall-stats") {
      try {
        const stats = getRecallStatsSnapshot();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(stats));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/facts?limit=50&offset=0&category=&tier=&entity=&search=
    if (pathname === "/api/viewer/facts") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10) || 50));
        const offset = Math.max(0, Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0);
        const categoryFilter = searchParams.get("category") || undefined;
        const entityFilter = searchParams.get("entity") || undefined;
        // #1187: honor `?tier=hot|warm|cold|structural` so operators can drill into a single tier
        // from the dashboard. Invalid tiers are dropped server-side by `listForDashboard`.
        const tierFilter = searchParams.get("tier") || undefined;
        const search = searchParams.get("search") || searchParams.get("q") || undefined;

        const { facts: pageFacts, total } = ctx.factsDb.listForDashboard({
          limit,
          offset,
          category: categoryFilter,
          tier: tierFilter,
          entity: entityFilter,
          search,
        });
        const verifiedFactIds = getVerifiedFactIdSet(ctx);
        const facts: MemoryViewerFact[] = pageFacts.map((record) => {
          const id = String(record.id ?? "");
          return {
            id,
            text: String(record.text ?? ""),
            why: (record.why as string | null) ?? null,
            category: String(record.category ?? ""),
            importance: Number(record.importance ?? 0.5),
            entity: (record.entity as string | null) ?? null,
            key: (record.key as string | null) ?? null,
            value: (record.value as string | null) ?? null,
            source: String(record.source ?? ""),
            createdAt: Number(record.created_at ?? 0),
            decayClass: String(record.decay_class ?? ""),
            expiresAt: record.expires_at != null ? Number(record.expires_at) : null,
            confidence: Number(record.confidence ?? 0.5),
            summary: (record.summary as string | null) ?? null,
            tags: parseTags(typeof record.tags === "string" ? record.tags : null),
            supersededAt: record.superseded_at != null ? Number(record.superseded_at) : null,
            supersededBy: (record.superseded_by as string | null) ?? null,
            verified: verifiedFactIds.has(id),
            scope: record.scope as string | undefined,
            provenanceSession: (record.provenance_session as string | null) ?? null,
            reinforcedCount: record.reinforced_count != null ? Number(record.reinforced_count) : undefined,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ facts, total }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/facts/:id
    if (req.method === "GET" && pathname.startsWith("/api/viewer/facts/") && !pathname.endsWith("/provenance")) {
      const factIdRaw = pathname.slice("/api/viewer/facts/".length);
      const factId = parseUrlPathSegment(factIdRaw);
      if (!factId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fact id" }));
        return;
      }
      try {
        const fact = ctx.factsDb.getById(factId);
        if (!fact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fact not found" }));
          return;
        }
        const verifiedFactIds = getVerifiedFactIdSet(ctx);
        const f: MemoryViewerFact = {
          id: fact.id,
          text: fact.text,
          why: fact.why,
          category: fact.category,
          importance: fact.importance,
          entity: fact.entity,
          key: fact.key,
          value: fact.value,
          source: fact.source,
          createdAt: fact.createdAt,
          decayClass: fact.decayClass,
          expiresAt: fact.expiresAt,
          confidence: fact.confidence,
          summary: fact.summary ?? null,
          tags: fact.tags ?? [],
          supersededAt: fact.supersededAt ?? null,
          supersededBy: fact.supersededBy ?? null,
          verified: verifiedFactIds.has(fact.id),
          scope: fact.scope,
          provenanceSession: fact.provenanceSession ?? null,
          reinforcedCount: fact.reinforcedCount,
        };
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(f));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/facts/:id/provenance — #1195: resolve `provenance_json.sourceEventIds`
    // into a structured panel payload (id, eventType, occurredAt, text snippet) instead of
    // dumping the JSON blob into the dashboard. Falls back to raw JSON when the event log is
    // unavailable so the UI can still render *something*.
    if (req.method === "GET" && /^\/api\/viewer\/facts\/[^/]+\/provenance$/.test(pathname)) {
      const factIdRaw = pathname.replace(/^\/api\/viewer\/facts\/([^/]+)\/provenance$/, "$1");
      const factId = parseUrlPathSegment(factIdRaw);
      if (!factId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fact id" }));
        return;
      }
      try {
        const fact = ctx.factsDb.getById(factId);
        if (!fact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fact not found" }));
          return;
        }
        const raw = fact.provenanceJson ?? null;
        let parsed: {
          method?: string;
          consolidatedAt?: number;
          sourceEventIds?: string[];
          sourceEvents?: unknown[];
        } | null = null;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
        }
        const events: Array<{
          id: string;
          eventType?: string | null;
          occurredAt?: number | null;
          textPreview?: string | null;
        }> = [];
        if (parsed && Array.isArray(parsed.sourceEvents)) {
          for (const ev of parsed.sourceEvents) {
            if (!ev || typeof ev !== "object") continue;
            const e = ev as Record<string, unknown>;
            const id = typeof e.id === "string" ? e.id : null;
            if (!id) continue;
            events.push({
              id,
              eventType: typeof e.eventType === "string" ? e.eventType : null,
              occurredAt: typeof e.timestamp === "number" ? e.timestamp : null,
              textPreview: typeof e.text === "string" ? e.text.slice(0, 200) : null,
            });
          }
        } else if (parsed && Array.isArray(parsed.sourceEventIds)) {
          for (const id of parsed.sourceEventIds) {
            if (typeof id !== "string") continue;
            events.push({ id, eventType: null, occurredAt: null, textPreview: null });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(
          JSON.stringify({
            factId: fact.id,
            method: parsed?.method ?? null,
            consolidatedAt: parsed?.consolidatedAt ?? null,
            events,
            raw: parsed ?? null,
          }),
        );
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/entities
    if (pathname === "/api/viewer/entities") {
      try {
        const limit = Math.min(200, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10)));
        const entities = collectMemoryViewerEntities(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(entities));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/episodes
    if (pathname === "/api/viewer/episodes") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10)));
        const episodes = collectMemoryViewerEpisodes(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(episodes));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/narratives
    if (pathname === "/api/viewer/narratives") {
      try {
        const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10)));
        const narratives = collectMemoryViewerNarratives(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(narratives));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/issues
    if (pathname === "/api/viewer/issues") {
      try {
        const issues = collectMemoryViewerIssues(ctx);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(issues));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/workflows
    if (pathname === "/api/viewer/workflows") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10)));
        const workflows = collectMemoryViewerWorkflows(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(workflows));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/edicts
    if (pathname === "/api/viewer/edicts") {
      try {
        const edicts = collectMemoryViewerEdicts(ctx);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(edicts));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/verified
    if (pathname === "/api/viewer/verified") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10)));
        const verified = collectMemoryViewerVerified(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(verified));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/links
    if (pathname === "/api/viewer/links") {
      try {
        const limit = Math.min(10000, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "5000", 10)));
        const links = collectMemoryViewerLinks(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(links));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/correlation/:entityKey — unified entity → facts → issues → episodes (#1802)
    if (pathname.startsWith("/api/viewer/correlation/")) {
      const entityKey = parseUrlPathSegment(pathname.replace("/api/viewer/correlation/", ""));
      if (!entityKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing entity key" }));
        return;
      }
      try {
        const payload = collectMemoryViewerCorrelation(ctx, entityKey);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(payload));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(
          `[dashboard-server] /api/viewer/correlation: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    // GET /api/viewer/provenance/:factId
    if (pathname.startsWith("/api/viewer/provenance/")) {
      const factId = pathname.replace("/api/viewer/provenance/", "");
      try {
        const prov = collectMemoryViewerProvenance(ctx, factId);
        if (!prov) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provenance not available" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(prov));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // POST /api/viewer/facts/:id/verify
    if (req.method === "POST" && pathname.match(/^\/api\/viewer\/facts\/[^/]+\/verify$/)) {
      const factIdRaw = pathname.split("/")[4];
      const factId = parseUrlPathSegment(factIdRaw ?? "");
      if (!factId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fact id" }));
        return;
      }

      readJsonBody(req, MAX_DASHBOARD_JSON_BODY_BYTES)
        .then((parsed) => {
          const result = performFactAction(ctx, "verify", factId, parsed);
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === "Request body too large") {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "PayloadTooLarge" }));
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        });
      return;
    }

    // POST /api/viewer/facts/:id/forget
    if (req.method === "POST" && pathname.match(/^\/api\/viewer\/facts\/[^/]+\/forget$/)) {
      const factIdRaw = pathname.split("/")[4];
      const factId = parseUrlPathSegment(factIdRaw ?? "");
      if (!factId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fact id" }));
        return;
      }

      // Drain any body (defensive) and enforce size.
      readJsonBody(req, MAX_DASHBOARD_JSON_BODY_BYTES)
        .then(() => {
          const result = performFactAction(ctx, "forget", factId, {});
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === "Request body too large") {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "PayloadTooLarge" }));
            return;
          }
          // Body content is ignored for forget; malformed JSON should not block the action.
          const result = performFactAction(ctx, "forget", factId, {});
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        });
      return;
    }

    if (pathname === "/workshop" || pathname === "/workshop.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(getDashboardHtml(true));
      return;
    }

    const wctx = workshopCtx(ctx);
    const isWorkshopApi =
      pathname === "/api/workshop/proposals" ||
      pathname === "/api/workshop/changes" ||
      pathname === "/api/workshop/digest" ||
      pathname === "/api/workshop/dream-log" ||
      pathname === "/api/workshop/skills" ||
      pathname === "/api/workshop/changes/revert" ||
      pathname.startsWith("/api/workshop/proposals/");

    if (isWorkshopApi && !wctx) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(
        JSON.stringify({
          error: "workshop_unavailable",
          message: ctx.hybridCfg
            ? "Workshop is disabled. Enable persona/crystallization/self-extension/procedures proposals or set workshop.enabled: true."
            : "Hybrid memory workshop context is not configured",
        }),
      );
      return;
    }

    if (pathname === "/api/workshop/proposals" && wctx) {
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ proposals: collectWorkshopProposals(wctx) }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/proposals") }));
      }
      return;
    }

    if (pathname === "/api/workshop/changes" && wctx) {
      try {
        const u = new URL(req.url ?? "", "http://127.0.0.1");
        const limitRaw = u.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : DEFAULT_WORKSHOP_LIST_LIMIT;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(
          JSON.stringify({
            changes: collectWorkshopChanges(wctx, Number.isFinite(limit) ? limit : DEFAULT_WORKSHOP_LIST_LIMIT),
          }),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/changes") }));
      }
      return;
    }

    if (pathname === "/api/workshop/digest" && wctx) {
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(collectWorkshopDigest(wctx)));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/digest") }));
      }
      return;
    }

    if (pathname === "/api/workshop/dream-log" && wctx) {
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ runs: collectDreamCycleLog(wctx) }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/dream-log") }));
      }
      return;
    }

    if (pathname === "/api/workshop/skills" && wctx) {
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ skills: collectSkillTelemetry(wctx) }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/skills") }));
      }
      return;
    }

    if (pathname === "/api/workshop/changes/revert" && wctx && req.method === "POST") {
      readJsonBody(req, MAX_DASHBOARD_JSON_BODY_BYTES)
        .then((body) => {
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing id" }));
            return;
          }
          const result = revertWorkshopChange(wctx, id);
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((err: unknown) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/changes/revert") }));
        });
      return;
    }

    if (pathname.startsWith("/api/workshop/proposals/") && wctx) {
      const suffix = pathname.slice("/api/workshop/proposals/".length);
      const actionMatch = suffix.match(/^(.+)\/(approve|reject|undo|quarantine|revise)$/);
      if (req.method === "GET" && !actionMatch) {
        const id = parseUrlPathSegment(suffix);
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing id" }));
          return;
        }
        const detail = collectWorkshopProposalDetail(wctx, id);
        if (!detail) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail));
        return;
      }
      if (req.method === "POST" && actionMatch) {
        const id = parseUrlPathSegment(actionMatch[1] ?? "");
        const action = actionMatch[2];
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing id" }));
          return;
        }
        readJsonBody(req, MAX_DASHBOARD_JSON_BODY_BYTES)
          .then(async (body) => {
            if (action === "approve") {
              const result = await applyWorkshopProposal(wctx, id);
              res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
              return;
            }
            if (action === "undo") {
              const changeEventId = typeof body.changeEventId === "string" ? body.changeEventId.trim() : undefined;
              const result = undoWorkshopProposal(wctx, id, changeEventId ? { changeEventId } : undefined);
              res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
              return;
            }
            if (action === "quarantine") {
              const result = quarantineWorkshopProposal(
                wctx,
                id,
                typeof body.reason === "string" ? body.reason : undefined,
              );
              res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
              return;
            }
            if (action === "revise") {
              const revision = typeof body.revision === "string" ? body.revision : "";
              const result = reviseWorkshopProposal(wctx, id, revision);
              res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
              return;
            }
            const result = rejectWorkshopProposal(wctx, id, typeof body.reason === "string" ? body.reason : undefined);
            res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          })
          .catch((err: unknown) => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: workshopClientError(err, "/api/workshop/proposals/*") }));
          });
        return;
      }
    }

    if (pathname === "/api/status") {
      collectStatus(ctx)
        .then((status) => {
          const body = JSON.stringify(status);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          });
          res.end(body);
        })
        .catch((_err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "InternalServerError" }));
        });
    } else if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(getDashboardHtml(false));
    } else if (pathname === "/graphql" && req.method === "POST") {
      // Handle GraphQL API requests using the shared Yoga server created at dashboard startup.
      try {
        const graphQlBody = await readJsonBody(req, MAX_DASHBOARD_JSON_BODY_BYTES);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const response = await yoga.fetch(req.url || "", {
          method: req.method || "POST",
          headers,
          body: JSON.stringify(graphQlBody),
        });

        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch (err) {
        if (err instanceof Error && err.message === "Request body too large") {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "PayloadTooLarge" }));
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "InvalidGraphQLRequest" }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  /** Attempt to bind `server` to the given port; resolves with the bound port. */
  function tryListen(targetPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      function onStartupError(err: NodeJS.ErrnoException) {
        reject(err);
      }
      server.once("error", onStartupError);

      server.listen(targetPort, "127.0.0.1", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : targetPort;
        server.removeAllListeners("error");
        resolve(boundPort);
      });
    });
  }

  let boundPort: number;
  try {
    boundPort = await tryListen(port);
  } catch (err: unknown) {
    const isAddrInUse = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!isAddrInUse) throw err;

    // Port is occupied (likely a previous instance that didn't shut down
    // cleanly). Fall back to an OS-assigned ephemeral port so the dashboard
    // remains available rather than failing entirely.
    const log = ctx.logger?.error ? (m: string) => ctx.logger?.error?.(m) : (m: string) => pluginLogger.warn(m);
    log(`[dashboard-server] Port ${port} in use (EADDRINUSE), falling back to OS-assigned port`);
    server.removeAllListeners("listening");
    boundPort = await tryListen(0);
  }

  // Install permanent error handler now that the server is bound.
  server.on("error", (err: NodeJS.ErrnoException) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (ctx.logger?.error) {
      ctx.logger.error(`[dashboard-server] Server error: ${errMsg}`);
    } else {
      pluginLogger.error(`[dashboard-server] Server error: ${errMsg}`);
    }
  });

  return {
    server,
    port: boundPort,
    close() {
      server.close();
    },
  };
}
