/** Open-loop obligations ledger tools (Issue #2152). */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { OpenLoopEvidenceRequiredError } from "../backends/loom/open-loops.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { LOOP_OWNERS, LOOP_STATUSES, LOOP_TYPES } from "../types/open-loop-types.js";
import { stringEnum } from "../utils/typebox.js";

export interface OpenLoopToolsContext {
  loomStore: LoomStore;
  cfg: HybridMemoryConfig;
}

const notEnabled = () => ({
  content: [{ type: "text" as const, text: "The Loom is disabled. Set loom.enabled: true in plugin config." }],
  details: { error: "loom_disabled" },
});

function fail(err: unknown, operation: string) {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "loom-open-loops", operation });
  return { content: [{ type: "text" as const, text: String(err) }], details: { error: String(err) } };
}

export function registerOpenLoopTools(ctx: OpenLoopToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore: store, cfg } = ctx;
  const lc = cfg.loom;
  const gate = () => !lc.enabled || !lc.openLoops.enabled;

  api.registerTool(
    {
      name: "memory_loop_create",
      label: "Create Open Loop",
      description:
        "Create an open-loop obligation: an unfinished promise, blocked task, unresolved incident, or thing that should not depend on human memory. Records the next safe action and closure criteria.",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.Optional(Type.String()),
        loop_type: stringEnum(LOOP_TYPES as unknown as readonly string[]),
        scope: Type.Optional(Type.String()),
        entity: Type.Optional(Type.String()),
        repo: Type.Optional(Type.String()),
        owner: Type.Optional(stringEnum(LOOP_OWNERS as unknown as readonly string[])),
        next_action: Type.Optional(Type.String()),
        closure_criteria: Type.Optional(Type.String()),
        evidence_required: Type.Optional(Type.Boolean()),
        linked_goal_ids: Type.Optional(Type.Array(Type.String())),
        linked_task_labels: Type.Optional(Type.Array(Type.String())),
        linked_claim_ids: Type.Optional(Type.Array(Type.String())),
        linked_evidence_capsule_ids: Type.Optional(Type.Array(Type.String())),
        resurface_at: Type.Optional(Type.String()),
        urgency: Type.Optional(Type.Number()),
        importance: Type.Optional(Type.Number()),
        operator_load_risk: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as unknown as Parameters<typeof store.createOpenLoop>[0] & {
            loop_type: string;
            next_action?: string;
            closure_criteria?: string;
            evidence_required?: boolean;
            linked_goal_ids?: string[];
            linked_task_labels?: string[];
            linked_claim_ids?: string[];
            linked_evidence_capsule_ids?: string[];
            resurface_at?: string;
            operator_load_risk?: number;
          };
          const loop = store.createOpenLoop(
            {
              title: p.title,
              description: p.description,
              loopType: p.loop_type as never,
              scope: p.scope,
              entity: p.entity,
              repo: p.repo,
              owner: p.owner,
              nextAction: p.next_action,
              closureCriteria: p.closure_criteria,
              evidenceRequired: p.evidence_required,
              linkedGoalIds: p.linked_goal_ids,
              linkedTaskLabels: p.linked_task_labels,
              linkedClaimIds: p.linked_claim_ids,
              linkedEvidenceCapsuleIds: p.linked_evidence_capsule_ids,
              resurfaceAt: p.resurface_at,
              urgency: p.urgency,
              importance: p.importance,
              operatorLoadRisk: p.operator_load_risk,
            },
            { defaultResurfaceDays: lc.openLoops.defaultResurfaceDays },
          );
          return {
            content: [
              { type: "text", text: `Created open loop ${loop.id.slice(0, 8)}: "${loop.title}" (${loop.loopType}).` },
            ],
            details: { id: loop.id, loop },
          };
        } catch (err) {
          return fail(err, "memory_loop_create");
        }
      },
    },
    { name: "memory_loop_create" },
  );

  api.registerTool(
    {
      name: "memory_loop_list",
      label: "List Open Loops",
      description: "List open loops, filtered by status/type/scope/entity/repo/owner.",
      parameters: Type.Object({
        status: Type.Optional(Type.Array(stringEnum(LOOP_STATUSES as unknown as readonly string[]))),
        loop_type: Type.Optional(Type.Array(stringEnum(LOOP_TYPES as unknown as readonly string[]))),
        scope: Type.Optional(Type.String()),
        entity: Type.Optional(Type.String()),
        repo: Type.Optional(Type.String()),
        owner: Type.Optional(stringEnum(LOOP_OWNERS as unknown as readonly string[])),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as Parameters<typeof store.listOpenLoops>[0] & object;
          const loops = store.listOpenLoops(p as never);
          return {
            content: [
              {
                type: "text",
                text:
                  loops.length === 0
                    ? "No open loops match."
                    : loops.map((l) => `- [${l.status}] ${l.title} (${l.loopType}, id ${l.id.slice(0, 8)})`).join("\n"),
              },
            ],
            details: { count: loops.length, loops },
          };
        } catch (err) {
          return fail(err, "memory_loop_list");
        }
      },
    },
    { name: "memory_loop_list" },
  );

  api.registerTool(
    {
      name: "memory_loop_update",
      label: "Update Open Loop",
      description: "Update an open loop's status, next action, closure criteria, links, or priority scores.",
      parameters: Type.Object({
        loop_id: Type.String(),
        status: Type.Optional(stringEnum(LOOP_STATUSES as unknown as readonly string[])),
        next_action: Type.Optional(Type.String()),
        closure_criteria: Type.Optional(Type.String()),
        urgency: Type.Optional(Type.Number()),
        importance: Type.Optional(Type.Number()),
        resurface_at: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            loop_id: string;
            status?: string;
            next_action?: string;
            closure_criteria?: string;
            urgency?: number;
            importance?: number;
            resurface_at?: string;
          };
          const loop = store.resolveOpenLoop(p.loop_id.trim());
          if (!loop)
            return { content: [{ type: "text", text: "Open loop not found." }], details: { error: "not_found" } };
          const updated = store.updateOpenLoop(loop.id, {
            status: p.status as never,
            nextAction: p.next_action,
            closureCriteria: p.closure_criteria,
            urgency: p.urgency,
            importance: p.importance,
            resurfaceAt: p.resurface_at,
          });
          return {
            content: [{ type: "text", text: `Updated open loop ${loop.id.slice(0, 8)}.` }],
            details: { loop: updated },
          };
        } catch (err) {
          return fail(err, "memory_loop_update");
        }
      },
    },
    { name: "memory_loop_update" },
  );

  api.registerTool(
    {
      name: "memory_loop_close",
      label: "Close Open Loop",
      description:
        "Close (or supersede) an open loop. If the loop requires evidence to close, an evidence_capsule_id must be provided.",
      parameters: Type.Object({
        loop_id: Type.String(),
        reason: Type.Optional(Type.String()),
        evidence_capsule_id: Type.Optional(Type.String()),
        superseded_by_loop_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            loop_id: string;
            reason?: string;
            evidence_capsule_id?: string;
            superseded_by_loop_id?: string;
          };
          const loop = store.resolveOpenLoop(p.loop_id.trim());
          if (!loop)
            return { content: [{ type: "text", text: "Open loop not found." }], details: { error: "not_found" } };
          const updated = store.closeOpenLoop(loop.id, {
            reason: p.reason,
            evidenceCapsuleId: p.evidence_capsule_id,
            status: p.superseded_by_loop_id ? "superseded" : "closed",
            supersededByLoopId: p.superseded_by_loop_id,
          });
          return {
            content: [{ type: "text", text: `Open loop ${loop.id.slice(0, 8)} → ${updated.status}.` }],
            details: { loop: updated },
          };
        } catch (err) {
          if (err instanceof OpenLoopEvidenceRequiredError) {
            return { content: [{ type: "text", text: err.message }], details: { error: "evidence_required" } };
          }
          return fail(err, "memory_loop_close");
        }
      },
    },
    { name: "memory_loop_close" },
  );
}
