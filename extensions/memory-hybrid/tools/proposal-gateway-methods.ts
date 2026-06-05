/**
 * Gateway RPC methods for unified proposal workshop (Phase 2).
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
  workshopPendingCount,
  workshopQuarantine,
  workshopReject,
  workshopRevise,
} from "../services/workshop-service.js";

export interface ProposalGatewayContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  workflowStore?: WorkflowStore | null;
  resolvedSqlitePath: string;
  api: ClawdbotPluginApi;
}

type GatewayRespond = (ok: boolean, payload?: unknown, error?: { message: string }) => void;

type GatewayHandler = (opts: {
  params: Record<string, unknown>;
  respond: GatewayRespond;
}) => void | Promise<void>;

function workshopCtx(ctx: ProposalGatewayContext): WorkshopServiceContext {
  return {
    cfg: ctx.cfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    api: ctx.api,
  };
}

export function registerProposalGatewayMethods(ctx: ProposalGatewayContext): void {
  if (!ctx.cfg.health.enabled) return;
  const register = (ctx.api as { registerGatewayMethod?: (method: string, handler: GatewayHandler) => void })
    .registerGatewayMethod;
  if (typeof register !== "function") {
    ctx.api.logger?.debug?.("memory-hybrid: registerGatewayMethod unavailable; skipping proposal RPC methods");
    return;
  }

  const w = () => workshopCtx(ctx);

  register("hybrid-mem.proposals.list", async ({ params, respond }) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    respond(true, { proposals: workshopList(w(), { status: "pending", limit }) });
  });

  register("hybrid-mem.proposals.inspect", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) return respond(false, undefined, { message: "missing id" });
    const item = workshopInspect(w(), id);
    if (!item) return respond(false, undefined, { message: "not found" });
    respond(true, item);
  });

  register("hybrid-mem.proposals.approve", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) return respond(false, undefined, { message: "missing id" });
    const result = await workshopApprove(w(), id);
    respond(result.ok, result.ok ? result : undefined, result.ok ? undefined : { message: result.error });
  });

  register("hybrid-mem.proposals.reject", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) return respond(false, undefined, { message: "missing id" });
    const result = workshopReject(w(), id, typeof params.reason === "string" ? params.reason : undefined);
    respond(result.ok, result.ok ? result : undefined, result.ok ? undefined : { message: result.error });
  });

  register("hybrid-mem.proposals.quarantine", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id : "";
    if (!id) return respond(false, undefined, { message: "missing id" });
    const result = workshopQuarantine(w(), id, typeof params.reason === "string" ? params.reason : undefined);
    respond(result.ok, result.ok ? result : undefined, result.ok ? undefined : { message: result.error });
  });

  register("hybrid-mem.proposals.revise", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id : "";
    const revision = typeof params.revision === "string" ? params.revision : "";
    if (!id || !revision) return respond(false, undefined, { message: "missing id or revision" });
    const result = workshopRevise(w(), id, revision);
    respond(result.ok, result.ok ? result : undefined, result.ok ? undefined : { message: result.error });
  });

  register("hybrid-mem.proposals.digest", async ({ respond }) => {
    respond(true, buildWorkshopDigestReport(w()));
  });

  const registerUi = (ctx.api as { registerControlUiDescriptor?: (d: Record<string, unknown>) => void })
    .registerControlUiDescriptor;
  if (typeof registerUi === "function") {
    registerUi({
      id: "hybrid-memory-workshop",
      surface: "settings",
      label: "Memory Workshop",
      description: "Pending skill, persona, and tool proposals from hybrid-memory",
      schema: { pendingCount: "number" },
    });
  }

  ctx.api.logger?.info?.(
    `memory-hybrid: registered proposal gateway methods (pending=${workshopPendingCount(w())})`,
  );
}
