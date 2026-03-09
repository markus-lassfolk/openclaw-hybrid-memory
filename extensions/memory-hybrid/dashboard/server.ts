/**
 * Dashboard API server — serves REST API for the Memory Dashboard UI and static build.
 * Run via: openclaw hybrid-mem dashboard [--port 18789]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactsDB } from "../backends/facts-db.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface DashboardServerContext {
  factsDb: FactsDB;
  issueStore: IssueStore | null;
  workflowStore: WorkflowStore | null;
  cfg: HybridMemoryConfig;
}

export function createDashboardServer(ctx: DashboardServerContext) {
  const { factsDb, issueStore, workflowStore, cfg } = ctx;

  function sendJson(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  function parseUrl(url: string): { pathname: string; searchParams: URLSearchParams } {
    const [pathname, search = ""] = url.split("?");
    return { pathname: pathname ?? "/", searchParams: new URLSearchParams(search) };
  }

  async function handleApi(pathname: string, searchParams: URLSearchParams, res: ServerResponse): Promise<boolean> {
    const base = "/api";
    if (!pathname.startsWith(base)) return false;

    const path = pathname.slice(base.length) || "/";
    const pathParts = path.split("/").filter(Boolean);

    try {
      // GET /api/stats
      if (path === "/stats" || path === "/") {
        const byCategory = factsDb.statsBreakdownByCategory();
        const byTier = factsDb.statsBreakdownByTier();
        const byDecayClass = factsDb.statsBreakdownByDecayClass();
        const totalFacts = factsDb.count();
        const links = factsDb.linksCount();
        const openIssues = issueStore ? issueStore.list({ status: ["open"], limit: 1000 }).length : 0;
        const lastFact = factsDb.getFactsForConsolidation(1)[0];
        const lastFactAt = lastFact ? (factsDb.getById(lastFact.id)?.createdAt ?? 0) : 0;
        const avgImportance = 0.72; // could compute from DB if needed
        sendJson(res, 200, {
          totalFacts,
          activeFacts: totalFacts,
          categories: Object.keys(byCategory).length,
          links,
          avgImportance,
          lastFactAt,
          openIssues,
          costThisMonth: 0,
          byCategory: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
          byTier: Object.entries(byTier).map(([tier, count]) => ({ tier, count })),
          byDecayClass: Object.entries(byDecayClass).map(([decay_class, count]) => ({ decay_class, count })),
        });
        return true;
      }

      // GET /api/facts
      if (pathParts[0] === "facts" && pathParts.length === 1) {
        const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
        const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0", 10));
        const category = searchParams.get("category") ?? undefined;
        const tier = searchParams.get("tier") ?? undefined;
        const search = searchParams.get("search") ?? undefined;
        const { facts, total } = factsDb.listForDashboard({ limit, offset, category, tier, search });
        sendJson(res, 200, { facts, total });
        return true;
      }

      // GET /api/facts/:id
      if (pathParts[0] === "facts" && pathParts.length === 2) {
        const id = pathParts[1];
        const fact = factsDb.getById(id);
        if (!fact) {
          sendJson(res, 404, { error: "Fact not found" });
          return true;
        }
        const links = factsDb.getLinksFrom(id).map((l) => {
          const target = factsDb.getById(l.targetFactId);
          return {
            id: l.id,
            target_id: l.targetFactId,
            link_type: l.linkType,
            strength: l.strength,
            target_text: target?.text ?? null,
            target_category: target?.category ?? null,
          };
        });
        const row: Record<string, unknown> = {
          id: fact.id,
          text: fact.text,
          category: fact.category,
          importance: fact.importance,
          entity: fact.entity,
          key: fact.key,
          value: fact.value,
          tags: fact.tags?.join(",") ?? "",
          tier: fact.tier ?? "warm",
          decay_class: fact.decayClass,
          scope: fact.scope ?? "global",
          confidence: fact.confidence,
          created_at: fact.createdAt,
          recall_count: fact.recallCount ?? 0,
        };
        sendJson(res, 200, { fact: row, links });
        return true;
      }

      // GET /api/graph
      if (path === "/graph") {
        const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") ?? "100", 10)));
        const category = searchParams.get("category") ?? undefined;
        const entity = searchParams.get("entity") ?? undefined;
        const { facts, total } = factsDb.listForDashboard({ limit, offset: 0, category, tier: undefined, entity });
        const nodeIds = new Set(facts.map((f) => f.id as string));
        const nodes = facts.map((f) => ({
          id: f.id,
          text: (f.text as string).slice(0, 120),
          category: f.category,
          entity: f.entity,
          importance: f.importance,
        }));
        const allEdges = factsDb.getAllEdges(3000);
        const edges = allEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
        sendJson(res, 200, { nodes, edges });
        return true;
      }

      // GET /api/issues
      if (path === "/issues") {
        const status = searchParams.get("status");
        const severity = searchParams.get("severity");
        const list = issueStore
          ? issueStore.list({
              status: status ? [status as "open" | "diagnosed" | "resolved" | "verified" | "wont-fix" | "fix-attempted"] : undefined,
              severity: severity ? [severity] : undefined,
              limit: 200,
            })
          : [];
        const issues = list.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          severity: i.severity,
          symptoms: i.symptoms,
          root_cause: i.rootCause ?? null,
          fix: i.fix ?? null,
          rollback: i.rollback ?? null,
          tags: i.tags,
          detected_at: i.detectedAt,
          resolved_at: i.resolvedAt ?? null,
          verified_at: i.verifiedAt ?? null,
        }));
        sendJson(res, 200, { issues });
        return true;
      }

      // GET /api/clusters
      if (path === "/clusters") {
        const clusters = factsDb.getClusters().map((c) => ({
          id: c.id,
          label: c.label,
          fact_count: c.factCount,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        }));
        sendJson(res, 200, { clusters });
        return true;
      }

      // GET /api/cost
      if (path === "/cost") {
        sendJson(res, 200, {
          daily: [],
          byModel: [],
          byFeature: [],
          summary: { totalMonth: 0, totalToday: 0, avgDaily: 0, topModel: null },
        });
        return true;
      }

      // GET /api/config
      if (path === "/config") {
        const features = [
          { name: "Hybrid Memory", enabled: true, description: "Core hybrid memory system" },
          { name: "Auto Capture", enabled: cfg.autoCapture, description: "Automatically extract facts from conversations" },
          { name: "Auto Recall", enabled: !!cfg.autoRecall, description: "Automatically retrieve relevant memories" },
          { name: "Auto Classify", enabled: cfg.autoClassify.enabled, description: "Categorize facts automatically" },
          { name: "Distill", enabled: !!cfg.distill?.defaultModel, description: "Summarize and compress facts" },
          { name: "Reflection", enabled: cfg.reflection.enabled, description: "Periodic self-analysis" },
          { name: "Self-Correction", enabled: !!cfg.selfCorrection?.semanticDedup, description: "Detect and fix contradictions" },
          { name: "Passive Observer", enabled: cfg.passiveObserver.enabled, description: "Background fact extraction" },
          { name: "Nightly Cycle", enabled: cfg.nightlyCycle.enabled, description: "Nightly maintenance" },
          { name: "Extraction Passes", enabled: cfg.extraction.extractionPasses, description: "Multi-pass extraction" },
          { name: "Self Extension", enabled: cfg.selfExtension.enabled, description: "Tool proposals from gaps" },
          { name: "Crystallization", enabled: cfg.crystallization.enabled, description: "Skill proposals from workflows" },
          { name: "Language Keywords", enabled: cfg.languageKeywords.autoBuild, description: "Keyword index for search" },
          { name: "Credentials Store", enabled: cfg.credentials.enabled, description: "Secure credential storage" },
          { name: "Error Reporting", enabled: cfg.errorReporting.enabled, description: "Error tracking" },
        ];
        sendJson(res, 200, { features });
        return true;
      }

      // GET /api/workflows
      if (path === "/workflows") {
        const limit = parseInt(searchParams.get("limit") ?? "20", 10);
        const minSuccessRate = parseFloat(searchParams.get("minSuccessRate") ?? "0");
        const patterns = workflowStore
          ? workflowStore.getPatterns({ limit, minSuccessRate })
          : [];
        const out = patterns.map((p) => ({
          goal: p.exampleGoals[0] ?? "",
          tool_sequence: p.toolSequence,
          outcome: p.successRate >= 0.5 ? "success" : "failure",
          tool_count: p.toolSequence.length,
          duration_ms: p.avgDurationMs,
          created_at: 0,
        }));
        sendJson(res, 200, { patterns: out });
        return true;
      }

      sendJson(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
      return true;
    }
  }

  function serveStatic(res: ServerResponse, filePath: string): boolean {
    if (!existsSync(filePath)) return false;
    try {
      const content = readFileSync(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = parseUrl(req.url ?? "/");

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    const handled = await handleApi(pathname, searchParams, res);
    if (handled) return;

    const distDir = join(__dirname, "dist");
    const base = "/plugins/memory-dashboard";
    let filePath: string;
    if (pathname.startsWith(base)) {
      const sub = pathname.slice(base.length) || "/index.html";
      filePath = join(distDir, sub === "/" ? "index.html" : sub);
    } else if (pathname === "/" || pathname === "") {
      filePath = join(distDir, "index.html");
    } else {
      filePath = join(distDir, pathname);
    }

    // Path traversal guard: ensure resolved path stays within distDir
    const resolvedPath = resolve(filePath);
    const resolvedDistDir = resolve(distDir);
    if (!resolvedPath.startsWith(resolvedDistDir + sep) && resolvedPath !== resolvedDistDir) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    if (serveStatic(res, filePath)) return;
    if (pathname.startsWith("/api")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (serveStatic(res, join(distDir, "index.html"))) return;
    res.writeHead(404);
    res.end("Not found");
  });
}
