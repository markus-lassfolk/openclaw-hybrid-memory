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
import { isWorkshopEnabled } from "../services/workshop-config.js";
import { buildWorkshopDigestReport } from "../services/unified-proposals.js";
import type { ChangeFeed } from "../services/change-feed.js";
import { revertChangeById, revertChangeByOrdinal, buildChangeRevertContext } from "../services/change-feed-revert.js";
import type { SessionState } from "../lifecycle/types.js";
import {
  type WorkshopServiceContext,
  withWorkshopDefaults,
  workshopApprove,
  workshopInspect,
  workshopList,
  workshopQuarantine,
  workshopReject,
  workshopRevise,
  workshopUndo,
} from "../services/workshop-service.js";
import type { HttpRouteOptions } from "./http-route-types.js";
import { createSafeRegisterHttpRoute } from "./safe-register-http-route.js";

export const PROPOSAL_API_PREFIX = "/plugins/memory-proposals";
export const CHANGE_FEED_API_PREFIX = "/plugins/memory-changes";

export interface ProposalRoutesContext {
  cfg: Pick<{ health: { enabled: boolean; authenticated: boolean } }, "health">;
  cfgFull: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  workflowStore?: WorkflowStore | null;
  resolvedSqlitePath: string;
  changeFeed?: ChangeFeed | null;
  sessionStateRef?: { value: SessionState | null };
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
  return withWorkshopDefaults({
    cfg: ctx.cfgFull,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    changeFeed: ctx.changeFeed ?? null,
    api: ctx.api,
  });
}

function parseBody(req: { method: string; url: string; headers: Record<string, string>; body?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
  } catch {
    // ignore malformed URL
  }
  const rawBody = req.body?.trim();
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (out[k] === undefined) out[k] = v;
        }
      }
    } catch {
      // Non-JSON bodies fall back to query params only.
    }
  }
  return out;
}

export function registerProposalHttpRoutes(ctx: ProposalRoutesContext): void {
  if (!isWorkshopEnabled(ctx.cfgFull)) return;
  if (!ctx.cfg.health.enabled) return;
  if (typeof ctx.api.registerHttpRoute !== "function") return;

  const routeOpts: HttpRouteOptions = { authenticated: ctx.cfg.health.authenticated };
  const logger = ctx.api.logger ?? { warn: () => {} };
  const register = createSafeRegisterHttpRoute(ctx.api, logger, "memory-proposals");
  const wctx = () => workshopCtx(ctx);

  register(
    `${PROPOSAL_API_PREFIX}/list`,
    async (req) => json(200, { proposals: workshopList(wctx(), { status: "pending", limit: 50, includeUndoable: true }) }),
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

  register(
    `${PROPOSAL_API_PREFIX}/undo`,
    async (req) => {
      const body = parseBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(400, { error: "missing id" });
      const changeEventId =
        typeof body.changeEventId === "string" && body.changeEventId.trim().length > 0
          ? body.changeEventId.trim()
          : undefined;
      const result = workshopUndo(wctx(), id, { changeEventId });
      return json(result.ok ? 200 : 400, result);
    },
    routeOpts,
  );

  if (ctx.changeFeed) {
    const changeRegister = createSafeRegisterHttpRoute(ctx.api, logger, "memory-changes");
    const feed = ctx.changeFeed;

    changeRegister(
      `${CHANGE_FEED_API_PREFIX}/list`,
      async (req) => {
        const u = new URL(req.url, "http://127.0.0.1");
        const sessionKey = u.searchParams.get("session");
        if (!sessionKey || sessionKey.trim().length === 0) {
          return json(400, {
            error: "missing session query param (use __broadcast__ for system-wide changes)",
          });
        }
        const sinceRaw = u.searchParams.get("since");
        const since = sinceRaw ? Number(sinceRaw) : undefined;
        const sinceOrdinalRaw = u.searchParams.get("sinceOrdinal");
        const sinceOrdinal = sinceOrdinalRaw ? Number(sinceOrdinalRaw) : undefined;
        const limitRaw = u.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 50;
        return json(200, {
          changes: feed.listRecent({
            sessionKey: sessionKey.trim(),
            since: Number.isFinite(since) ? since : undefined,
            sinceOrdinal: Number.isFinite(sinceOrdinal) ? sinceOrdinal : undefined,
            limit: Number.isFinite(limit) ? limit : 50,
          }),
        });
      },
      routeOpts,
    );

    changeRegister(
      `${CHANGE_FEED_API_PREFIX}/revert`,
      async (req) => {
        const body = parseBody(req);
        const sessionKey = String(body.session ?? body.sessionKey ?? "default");
        const revertCtx = buildChangeRevertContext({
          changeFeed: feed,
          cfg: ctx.cfgFull,
          workshopCtx: wctx(),
          sessionKey,
          sessionState: ctx.sessionStateRef?.value ?? null,
        });
        if (body.ordinal != null && String(body.ordinal).length > 0) {
          const ordinal = Number(body.ordinal);
          if (!Number.isFinite(ordinal)) return json(400, { error: "invalid ordinal" });
          const result = revertChangeByOrdinal(revertCtx, ordinal, sessionKey);
          return json(result.ok ? 200 : 400, result);
        }
        const id = String(body.id ?? "");
        if (!id) return json(400, { error: "missing id or ordinal" });
        const result = revertChangeById(revertCtx, id);
        return json(result.ok ? 200 : 400, result);
      },
      routeOpts,
    );
  }
}
