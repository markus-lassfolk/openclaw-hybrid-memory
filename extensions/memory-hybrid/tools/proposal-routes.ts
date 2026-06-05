/**
 * Gateway HTTP routes for unified proposal workshop (Phase 2).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { buildWorkshopDigestReport } from "../services/unified-proposals.js";
import {
  type WorkshopServiceContext,
  workshopApprove,
  workshopInspect,
  workshopList,
  workshopQuarantine,
  workshopReject,
  workshopRevise,
} from "../services/workshop-service.js";
import type { HttpRouteOptions } from "./http-route-types.js";
import { createSafeRegisterHttpRoute } from "./safe-register-http-route.js";

export const PROPOSAL_API_PREFIX = "/plugins/memory-proposals";

export interface ProposalRoutesContext {
  cfg: Pick<{ health: { enabled: boolean; authenticated: boolean } }, "health">;
  cfgFull: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  workflowStore?: WorkflowStore | null;
  resolvedSqlitePath: string;
  api: ClawdbotPluginApi;
}

function json(status: number, body: unknown) {
  return {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  };
}

function workshopCtx(ctx: ProposalRoutesContext): WorkshopServiceContext {
  return {
    cfg: ctx.cfgFull,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    api: ctx.api,
  };
}

function parseBody(req: { method: string; url: string; headers: Record<string, string> }): Record<string, unknown> {
  // Legacy handler receives no body — POST actions accept query params for gateway simplicity.
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const out: Record<string, unknown> = {};
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function registerProposalHttpRoutes(ctx: ProposalRoutesContext): void {
  if (!ctx.cfg.health.enabled) return;
  if (typeof ctx.api.registerHttpRoute !== "function") return;

  const routeOpts: HttpRouteOptions = { authenticated: ctx.cfg.health.authenticated };
  const logger = ctx.api.logger ?? { warn: () => {} };
  const register = createSafeRegisterHttpRoute(ctx.api, logger, "memory-proposals");
  const wctx = () => workshopCtx(ctx);

  register(
    `${PROPOSAL_API_PREFIX}/list`,
    async (req) => json(200, { proposals: workshopList(wctx(), { status: "pending", limit: 50 }) }),
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/digest`,
    async () => json(200, buildWorkshopDigestReport(wctx())),
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/inspect`,
    async (req) => {
      const u = new URL(req.url, "http://127.0.0.1");
      const id = u.searchParams.get("id");
      if (!id) return json(400, { error: "missing id" });
      const item = workshopInspect(wctx(), id);
      if (!item) return json(404, { error: "not found" });
      return json(200, item);
    },
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/approve`,
    async (req) => {
      const body = parseBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(400, { error: "missing id" });
      const result = await workshopApprove(wctx(), id);
      return json(result.ok ? 200 : 400, result);
    },
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/reject`,
    async (req) => {
      const body = parseBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(400, { error: "missing id" });
      const result = workshopReject(wctx(), id, body.reason as string | undefined);
      return json(result.ok ? 200 : 400, result);
    },
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/quarantine`,
    async (req) => {
      const body = parseBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(400, { error: "missing id" });
      const result = workshopQuarantine(wctx(), id, body.reason as string | undefined);
      return json(result.ok ? 200 : 400, result);
    },
    routeOpts,
  );

  register(
    `${PROPOSAL_API_PREFIX}/revise`,
    async (req) => {
      const body = parseBody(req);
      const id = String(body.id ?? "");
      const revision = String(body.revision ?? "");
      if (!id || !revision) return json(400, { error: "missing id or revision" });
      const result = workshopRevise(wctx(), id, revision);
      return json(result.ok ? 200 : 400, result);
    },
    routeOpts,
  );
}
