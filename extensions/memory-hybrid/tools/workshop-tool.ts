/**
 * memory_workshop — unified proposal review tool (OpenClaw integration plan Phase 1).
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { buildWorkshopDigestReport } from "../services/unified-proposals.js";
import {
  DEFAULT_WORKSHOP_TOOL_LIST_LIMIT,
  isWorkshopToolMutationEnabled,
  resolveWorkshopRevertSessionKey,
} from "../services/workshop-config.js";
import { revertChangeByOrdinal, buildChangeRevertContext } from "../services/change-feed-revert.js";
import type { ChangeFeed } from "../services/change-feed.js";
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

export interface WorkshopToolsContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  workflowStore?: WorkflowStore | null;
  resolvedSqlitePath: string;
  changeFeed?: ChangeFeed | null;
  sessionStateRef?: { value: SessionState | null };
}

function buildWorkshopCtx(ctx: WorkshopToolsContext, api: ClawdbotPluginApi): WorkshopServiceContext {
  return withWorkshopDefaults({
    cfg: ctx.cfg,
    factsDb: ctx.factsDb,
    proposalsDb: ctx.proposalsDb ?? null,
    crystallizationStore: ctx.crystallizationStore ?? null,
    toolProposalStore: ctx.toolProposalStore ?? null,
    workflowStore: ctx.workflowStore ?? null,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    changeFeed: ctx.changeFeed ?? null,
    api,
  });
}

const READ_ONLY_WORKSHOP_ACTIONS = [Type.Literal("list"), Type.Literal("inspect"), Type.Literal("digest")];
const MUTATING_WORKSHOP_ACTION_NAMES = [
  "approve",
  "reject",
  "quarantine",
  "revise",
  "undo",
  "revert_by_ordinal",
] as const;
const MUTATING_WORKSHOP_ACTIONS = MUTATING_WORKSHOP_ACTION_NAMES.map((action) => Type.Literal(action));

function workshopMutationDisabledResponse(action: string) {
  return {
    content: [
      {
        type: "text",
        text: `memory_workshop action '${action}' is disabled for agent tool calls. Review and mutate proposals from the trusted dashboard/gateway, or set workshop.allowAgentMutations=true to opt in.`,
      },
    ],
    details: { ok: false, error: "workshop_agent_mutations_disabled" },
  };
}

export function registerWorkshopTools(ctx: WorkshopToolsContext, api: ClawdbotPluginApi): void {
  const allowMutations = isWorkshopToolMutationEnabled(ctx.cfg);
  api.registerTool({
    name: "memory_workshop",
    label: "Memory Workshop",
    description: allowMutations
      ? "Unified review queue for persona proposals, crystallization skills, tool proposals, and procedure-skill promotions. Actions: list, inspect, approve, reject, quarantine, revise, undo, revert_by_ordinal, digest."
      : "Read-only unified review queue for persona proposals, crystallization skills, tool proposals, and procedure-skill promotions. Actions: list, inspect, digest. Mutating actions are disabled unless workshop.allowAgentMutations=true.",
    parameters: Type.Object({
      action: Type.Union(
        allowMutations ? [...READ_ONLY_WORKSHOP_ACTIONS, ...MUTATING_WORKSHOP_ACTIONS] : READ_ONLY_WORKSHOP_ACTIONS,
        {
          description: allowMutations
            ? "Workshop action to perform."
            : "Read-only workshop action to perform. Mutating actions are disabled unless workshop.allowAgentMutations=true.",
        },
      ),
      id: Type.Optional(
        Type.String({ description: "Unified proposal key (type:storeId) for inspect/approve/reject/etc." }),
      ),
      ordinal: Type.Optional(
        Type.Integer({ minimum: 1, description: "Change feed ordinal (#N) for revert_by_ordinal." }),
      ),
      sessionKey: Type.Optional(
        Type.String({ description: "Session key for revert_by_ordinal (defaults to current session)." }),
      ),
      reason: Type.Optional(Type.String({ description: "Rejection or quarantine reason." })),
      revision: Type.Optional(Type.String({ description: "Revised suggested_change body (persona proposals only)." })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: `Max proposals for list (default ${DEFAULT_WORKSHOP_TOOL_LIST_LIMIT}).`,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = params.action as string;
      const workshopCtx = buildWorkshopCtx(ctx, api);
      try {
        if (MUTATING_WORKSHOP_ACTION_NAMES.some((mutatingAction) => mutatingAction === action) && !allowMutations) {
          return workshopMutationDisabledResponse(action);
        }
        switch (action) {
          case "list": {
            const items = workshopList(workshopCtx, {
              status: "pending",
              limit: (params.limit as number) ?? DEFAULT_WORKSHOP_TOOL_LIST_LIMIT,
              includeUndoable: true,
            });
            const lines = items.map(
              (p, i) =>
                `${i + 1}. [${p.type}] ${p.title} (${p.unifiedKey}, conf=${p.confidence.toFixed(2)}${p.actions.undoSupported ? ", undoable" : ""}, ${p.preview.slice(0, 80)})`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: items.length
                    ? `Workshop queue (${items.length}):\n\n${lines.join("\n")}`
                    : "No proposals in the unified workshop queue.",
                },
              ],
              details: items,
            };
          }
          case "inspect": {
            const id = params.id as string | undefined;
            if (!id) return { content: [{ type: "text", text: "id is required for inspect" }], details: { ok: false } };
            const item = workshopInspect(workshopCtx, id);
            if (!item)
              return { content: [{ type: "text", text: `Proposal not found: ${id}` }], details: { ok: false } };
            return {
              content: [{ type: "text", text: `${item.type} ${item.title}\n\n${item.fullContent ?? item.preview}` }],
              details: item,
            };
          }
          case "approve": {
            const id = params.id as string | undefined;
            if (!id) return { content: [{ type: "text", text: "id is required for approve" }], details: { ok: false } };
            const result = await workshopApprove(workshopCtx, id);
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "reject": {
            const id = params.id as string | undefined;
            if (!id) return { content: [{ type: "text", text: "id is required for reject" }], details: { ok: false } };
            const result = workshopReject(workshopCtx, id, params.reason as string | undefined);
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "quarantine": {
            const id = params.id as string | undefined;
            if (!id)
              return { content: [{ type: "text", text: "id is required for quarantine" }], details: { ok: false } };
            const result = workshopQuarantine(workshopCtx, id, params.reason as string | undefined);
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "revise": {
            const id = params.id as string | undefined;
            const revision = params.revision as string | undefined;
            if (!id || !revision) {
              return {
                content: [{ type: "text", text: "id and revision are required for revise" }],
                details: { ok: false },
              };
            }
            const result = workshopRevise(workshopCtx, id, revision);
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "undo": {
            const id = params.id as string | undefined;
            if (!id) return { content: [{ type: "text", text: "id is required for undo" }], details: { ok: false } };
            const result = workshopUndo(workshopCtx, id);
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "revert_by_ordinal": {
            const ordinal = params.ordinal as number | undefined;
            if (!ordinal || ordinal < 1) {
              return {
                content: [{ type: "text", text: "ordinal is required for revert_by_ordinal (positive integer)" }],
                details: { ok: false },
              };
            }
            if (!ctx.changeFeed) {
              return {
                content: [{ type: "text", text: "Change feed is not available" }],
                details: { ok: false },
              };
            }
            const chatSessionKey =
              (api.context?.sessionKey as string | undefined) ?? (api.context?.sessionId as string | undefined);
            const sessionKey = resolveWorkshopRevertSessionKey(
              ctx.cfg,
              params.sessionKey as string | undefined,
              chatSessionKey,
            );
            const result = revertChangeByOrdinal(
              buildChangeRevertContext({
                changeFeed: ctx.changeFeed,
                cfg: ctx.cfg,
                workshopCtx,
                sessionKey,
                sessionState: ctx.sessionStateRef?.value ?? null,
              }),
              ordinal,
              sessionKey,
            );
            return {
              content: [{ type: "text", text: result.ok ? result.message : result.error }],
              details: result,
            };
          }
          case "digest": {
            const report = buildWorkshopDigestReport(workshopCtx);
            return {
              content: [
                {
                  type: "text",
                  text: `Pending: persona=${report.pendingReview.persona} procedures=${report.pendingReview.procedures} tools=${report.pendingReview.tools} crystal=${report.pendingReview.crystallization}`,
                },
              ],
              details: report,
            };
          }
          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: { ok: false } };
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "workshop",
          operation: `memory-workshop-${action}`,
        });
        throw err;
      }
    },
  });
}
