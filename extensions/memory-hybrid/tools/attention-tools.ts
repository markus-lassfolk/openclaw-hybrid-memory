/** Attention steward tools (Issue #2153) — ranking, demotion, and focus. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LoomStore } from "../backends/loom-store.js";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { rankAttention } from "../services/attention-steward.js";
import { capturePluginError } from "../services/error-reporter.js";
import { ATTENTION_OVERRIDE_ACTIONS, ATTENTION_TARGET_KINDS } from "../types/attention-types.js";
import { stringEnum } from "../utils/typebox.js";

export interface AttentionToolsContext {
  loomStore: LoomStore;
  serendipityStore?: SerendipityStore | null;
  cfg: HybridMemoryConfig;
}

export function registerAttentionTools(ctx: AttentionToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore, serendipityStore, cfg } = ctx;
  const lc = cfg.loom;
  const gate = () => !lc.enabled || !lc.attention.enabled;
  const notEnabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "The Loom attention steward is disabled. Set loom.enabled and loom.attention.enabled: true.",
      },
    ],
    details: { error: "loom_disabled" },
  });

  api.registerTool(
    {
      name: "memory_attention_rank",
      label: "Rank Attention",
      description:
        "Rank what deserves attention across claims, open loops, drift findings, and serendipity findings: urgent, important-not-urgent, blocked, needs-verification, stale/noisy, and more, with reasons — not just a score.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String()),
        entity: Type.Optional(Type.String()),
        target_kinds: Type.Optional(Type.Array(stringEnum(ATTENTION_TARGET_KINDS as unknown as readonly string[]))),
        limit: Type.Optional(Type.Number()),
        include_snoozed: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            scope?: string;
            entity?: string;
            target_kinds?: string[];
            limit?: number;
            include_snoozed?: boolean;
          };
          const report = rankAttention(
            { loomStore, serendipityStore },
            {
              scope: p.scope,
              entity: p.entity,
              targetKinds: p.target_kinds as never,
              limit: p.limit ?? lc.attention.defaultLimit,
              includeSnoozed: p.include_snoozed,
            },
          );
          return {
            content: [
              {
                type: "text",
                text:
                  report.items.length === 0
                    ? "Nothing needs attention right now."
                    : report.items
                        .map(
                          (i) =>
                            `- [${i.category}] ${i.title} (${i.targetKind}, score ${i.score.toFixed(2)}, id ${i.targetId.slice(0, 8)})`,
                        )
                        .join("\n"),
              },
            ],
            details: report,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-attention",
            operation: "memory_attention_rank",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_attention_rank" },
  );

  api.registerTool(
    {
      name: "memory_attention_update",
      label: "Snooze Or Demote",
      description:
        "Snooze (until a date) or demote an item without deleting its provenance. Use action=restore to clear a prior override.",
      parameters: Type.Object({
        target_kind: stringEnum(ATTENTION_TARGET_KINDS as unknown as readonly string[]),
        target_id: Type.String(),
        action: stringEnum(ATTENTION_OVERRIDE_ACTIONS as unknown as readonly string[]),
        reason: Type.Optional(Type.String()),
        until: Type.Optional(Type.String({ description: "ISO date to snooze until." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            target_kind: string;
            target_id: string;
            action: string;
            reason?: string;
            until?: string;
          };
          const override = loomStore.setAttentionOverride({
            targetKind: p.target_kind as never,
            targetId: p.target_id,
            action: p.action as never,
            reason: p.reason,
            snoozedUntil: p.until,
          });
          return {
            content: [
              {
                type: "text",
                text: `${override.action} applied to ${override.targetKind}:${override.targetId.slice(0, 8)}.`,
              },
            ],
            details: { override },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-attention",
            operation: "memory_attention_update",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_attention_update" },
  );
}
