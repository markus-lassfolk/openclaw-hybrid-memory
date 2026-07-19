/** Live-check contract tools (Issue #2156) — beliefs that must be verified against mutable external systems before use. */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { stringEnum } from "../utils/typebox.js";

export interface LiveCheckToolsContext {
  loomStore: LoomStore;
  cfg: HybridMemoryConfig;
}

const notEnabled = () => ({
  content: [{ type: "text" as const, text: "The Loom is disabled. Set loom.enabled: true in plugin config." }],
  details: { error: "loom_disabled" },
});

function fail(err: unknown, operation: string) {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "loom-live-check", operation });
  return { content: [{ type: "text" as const, text: String(err) }], details: { error: String(err) } };
}

export function registerLiveCheckTools(ctx: LiveCheckToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore: store, cfg } = ctx;
  const lc = cfg.loom;
  const gate = () => !lc.enabled || !lc.liveChecks.enabled;

  api.registerTool(
    {
      name: "memory_live_check_list",
      label: "List Live Checks",
      description:
        "List claims that require a live check before action, with their current state (required_unsatisfied | satisfied | expired). Memory is context, not proof — verify live state before acting on these.",
      parameters: Type.Object({
        entity: Type.Optional(Type.String()),
        only_unsatisfied: Type.Optional(
          Type.Boolean({ description: "Only required_unsatisfied/expired (default: true)." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { entity?: string; only_unsatisfied?: boolean };
          const onlyUnsatisfied = p.only_unsatisfied !== false;
          const claims = onlyUnsatisfied
            ? store.listUnsatisfiedLiveChecks()
            : store.listClaims({ liveCheckRequired: true, entity: p.entity, limit: 200 });
          const filtered = p.entity ? claims.filter((c) => c.entity === p.entity) : claims;
          const withStatus = filtered.map((c) => ({ claim: c, status: store.getLiveCheckStatus(c.id) }));
          return {
            content: [
              {
                type: "text",
                text:
                  withStatus.length === 0
                    ? "No live checks pending."
                    : withStatus
                        .map(
                          (x) =>
                            `- [${x.status.state}] ${x.claim.entity} ${x.claim.predicate} (id ${x.claim.id.slice(0, 8)})`,
                        )
                        .join("\n"),
              },
            ],
            details: { count: withStatus.length, items: withStatus },
          };
        } catch (err) {
          return fail(err, "memory_live_check_list");
        }
      },
    },
    { name: "memory_live_check_list" },
  );

  api.registerTool(
    {
      name: "memory_live_check_satisfy",
      label: "Satisfy Live Check",
      description:
        "Record that a claim's live-check requirement has been satisfied, optionally citing evidence. Satisfaction expires after a configured TTL.",
      parameters: Type.Object({
        claim_id: Type.String(),
        evidence_capsule_id: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        ttl_hours: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { claim_id: string; evidence_capsule_id?: string; note?: string; ttl_hours?: number };
          const claim = store.resolveClaim(p.claim_id.trim());
          if (!claim) return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const event = store.satisfyLiveCheck({
            claimId: claim.id,
            evidenceCapsuleId: p.evidence_capsule_id,
            note: p.note,
            ttlHours: p.ttl_hours ?? lc.liveChecks.defaultTtlHours,
          });
          const status = store.getLiveCheckStatus(claim.id);
          return {
            content: [
              {
                type: "text",
                text: `Live check satisfied for ${claim.id.slice(0, 8)}${event.expiresAt ? ` (valid until ${event.expiresAt})` : ""}.`,
              },
            ],
            details: { event, status },
          };
        } catch (err) {
          return fail(err, "memory_live_check_satisfy");
        }
      },
    },
    { name: "memory_live_check_satisfy" },
  );

  api.registerTool(
    {
      name: "memory_live_check_require",
      label: "Require Live Check",
      description:
        "Declare that a claim must be live-checked before it is used for action (e.g. it depends on mutable external auth state).",
      parameters: Type.Object({
        claim_id: Type.String(),
        reason: Type.String(),
        suggested_checks: Type.Optional(
          Type.Array(
            Type.Object({
              kind: stringEnum(["command", "api_call", "manual", "other"] as const),
              text: Type.String(),
              expected: Type.Optional(Type.String()),
            }),
          ),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as {
            claim_id: string;
            reason: string;
            suggested_checks?: Array<{
              kind: "command" | "api_call" | "manual" | "other";
              text: string;
              expected?: string;
            }>;
          };
          const claim = store.resolveClaim(p.claim_id.trim());
          if (!claim) return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const updated = store.requireLiveCheck(claim.id, { reason: p.reason, suggestedChecks: p.suggested_checks });
          return {
            content: [{ type: "text", text: `Claim ${claim.id.slice(0, 8)} now requires a live check: ${p.reason}` }],
            details: { claim: updated },
          };
        } catch (err) {
          return fail(err, "memory_live_check_require");
        }
      },
    },
    { name: "memory_live_check_require" },
  );
}
