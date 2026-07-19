/** Memory lifecycle workflow tools (Issue #2155) — forgetting, demotion, and archival. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  applyLifecycleAction,
  LifecycleConfirmRequiredError,
  LifecycleStrongConfirmRequiredError,
  listLifecycleCandidates,
} from "../services/memory-lifecycle.js";
import { LIFECYCLE_ACTIONS, LIFECYCLE_TARGET_KINDS } from "../types/lifecycle-workflow-types.js";
import { stringEnum } from "../utils/typebox.js";

export interface LifecycleToolsContext {
  loomStore: LoomStore;
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
}

export function registerLifecycleTools(ctx: LifecycleToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore, factsDb, cfg } = ctx;
  const lc = cfg.loom;
  const gate = () => !lc.enabled || !lc.lifecycle.enabled;
  const notEnabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "The Loom lifecycle workflows are disabled. Set loom.enabled and loom.lifecycle.enabled: true.",
      },
    ],
    details: { error: "loom_disabled" },
  });

  api.registerTool(
    {
      name: "memory_lifecycle_candidates",
      label: "List Lifecycle Candidates",
      description:
        "Report-only: list facts that are candidates for demotion, archival, or deletion (contradicted, superseded, duplicate, stale/low-importance, or prompt-injection-like content), with why each is flagged. Never mutates anything.",
      parameters: Type.Object({
        target_kinds: Type.Optional(Type.Array(stringEnum(LIFECYCLE_TARGET_KINDS as unknown as readonly string[]))),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { target_kinds?: string[]; limit?: number };
          const report = listLifecycleCandidates(
            { factsDb, loomStore },
            { targetKinds: p.target_kinds as never, limit: p.limit },
          );
          return {
            content: [
              {
                type: "text",
                text:
                  report.candidates.length === 0
                    ? "No lifecycle candidates found."
                    : report.candidates
                        .map(
                          (c) =>
                            `- [${c.suggestedAction}] ${c.targetId.slice(0, 8)}: ${c.explanation}${c.isVerifiedOrCritical ? " (verified/critical — needs strong confirm to delete)" : ""}`,
                        )
                        .join("\n"),
              },
            ],
            details: report,
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-lifecycle",
            operation: "memory_lifecycle_candidates",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_lifecycle_candidates" },
  );

  api.registerTool(
    {
      name: "memory_lifecycle_update",
      label: "Apply Lifecycle Action",
      description:
        "Demote, archive, quarantine, or delete a fact. Demote/archive preserve provenance. Quarantine/delete require confirm:true and a reason, and are audited. Verified/critical facts require an additional strong_confirm token to delete.",
      parameters: Type.Object({
        target_kind: stringEnum(LIFECYCLE_TARGET_KINDS as unknown as readonly string[]),
        target_id: Type.String(),
        action: stringEnum(LIFECYCLE_ACTIONS as unknown as readonly string[]),
        reason: Type.String(),
        confirm: Type.Optional(Type.Boolean()),
        strong_confirm: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            target_kind: string;
            target_id: string;
            action: string;
            reason: string;
            confirm?: boolean;
            strong_confirm?: string;
          };
          const result = applyLifecycleAction(
            { factsDb, loomStore },
            {
              targetKind: p.target_kind as never,
              targetId: p.target_id,
              action: p.action as never,
              reason: p.reason,
              confirm: p.confirm,
              strongConfirm: p.strong_confirm,
            },
            { requireStrongConfirmForVerified: lc.lifecycle.requireStrongConfirmForVerified },
          );
          return { content: [{ type: "text", text: result.message }], details: result };
        } catch (err) {
          if (err instanceof LifecycleConfirmRequiredError || err instanceof LifecycleStrongConfirmRequiredError) {
            return { content: [{ type: "text", text: err.message }], details: { error: err.name } };
          }
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "loom-lifecycle",
            operation: "memory_lifecycle_update",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "memory_lifecycle_update" },
  );
}
