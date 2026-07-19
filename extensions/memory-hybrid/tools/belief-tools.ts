/**
 * Belief graph / claim ledger tools (Issue #2151). A claim is a justified,
 * inspectable statement — distinct from a raw recalled fact — with confidence,
 * staleness, evidence, contradiction, and supersession tracking.
 */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { renderClaimExplainMarkdown } from "../services/belief-explain.js";
import { capturePluginError } from "../services/error-reporter.js";
import { stringEnum } from "../utils/typebox.js";

export interface BeliefToolsContext {
  loomStore: LoomStore;
  cfg: HybridMemoryConfig;
}

const notEnabled = () => ({
  content: [{ type: "text" as const, text: "The Loom is disabled. Set loom.enabled: true in plugin config." }],
  details: { error: "loom_disabled" },
});

function fail(err: unknown, operation: string) {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "loom-beliefs", operation });
  return { content: [{ type: "text" as const, text: String(err) }], details: { error: String(err) } };
}

export function registerBeliefTools(ctx: BeliefToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore: store, cfg } = ctx;
  const lc = cfg.loom;
  const gate = () => !lc.enabled || !lc.beliefs.enabled;

  api.registerTool(
    {
      name: "memory_belief_assert",
      label: "Assert Claim",
      description:
        "Assert a claim into the belief graph: a justified statement distinct from a raw recalled fact. Can cite source facts and evidence capsules, declare invalidation conditions, and require a live check before use.",
      parameters: Type.Object({
        entity: Type.String(),
        key: Type.String({ description: "Predicate / key, e.g. m365_identity." }),
        value: Type.String(),
        scope: Type.Optional(Type.String()),
        why: Type.Optional(Type.String({ description: "Justification for the claim." })),
        confidence: Type.Optional(Type.Number()),
        source_fact_ids: Type.Optional(Type.Array(Type.String())),
        evidence_capsule_ids: Type.Optional(Type.Array(Type.String())),
        invalidation_conditions: Type.Optional(Type.Array(Type.String())),
        operational_impact: Type.Optional(Type.String()),
        live_check_required: Type.Optional(Type.Boolean()),
        live_check_reason: Type.Optional(Type.String()),
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
            entity: string;
            key: string;
            value: string;
            scope?: string;
            why?: string;
            confidence?: number;
            source_fact_ids?: string[];
            evidence_capsule_ids?: string[];
            invalidation_conditions?: string[];
            operational_impact?: string;
            live_check_required?: boolean;
            live_check_reason?: string;
            suggested_checks?: Array<{
              kind: "command" | "api_call" | "manual" | "other";
              text: string;
              expected?: string;
            }>;
          };
          const claim = store.assertClaim({
            entity: p.entity,
            predicate: p.key,
            value: p.value,
            scope: p.scope,
            why: p.why,
            confidence: p.confidence,
            sourceFactIds: p.source_fact_ids,
            evidenceCapsuleIds: p.evidence_capsule_ids,
            invalidationConditions: p.invalidation_conditions,
            operationalImpact: p.operational_impact,
            liveCheckRequired: p.live_check_required,
            liveCheckReason: p.live_check_reason,
            suggestedChecks: p.suggested_checks,
          });
          for (const capsuleId of p.evidence_capsule_ids ?? []) {
            store.linkEvidenceCapsuleToClaim(capsuleId, claim.id);
          }
          return {
            content: [
              {
                type: "text",
                text: `Asserted claim ${claim.id.slice(0, 8)}: ${claim.entity} ${claim.predicate} = ${claim.value} (status: ${claim.status}).`,
              },
            ],
            details: { id: claim.id, claim },
          };
        } catch (err) {
          return fail(err, "memory_belief_assert");
        }
      },
    },
    { name: "memory_belief_assert" },
  );

  api.registerTool(
    {
      name: "memory_belief_get",
      label: "Get Beliefs",
      description:
        "Get current primary beliefs for an entity (excludes contradicted/superseded claims unless include_non_primary is set), or fetch a single claim by id.",
      parameters: Type.Object({
        entity: Type.Optional(Type.String()),
        claim_id: Type.Optional(Type.String()),
        include_non_primary: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { entity?: string; claim_id?: string; include_non_primary?: boolean };
          if (p.claim_id) {
            const claim = store.resolveClaim(p.claim_id.trim());
            if (!claim)
              return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
            return {
              content: [
                { type: "text", text: `${claim.entity} ${claim.predicate} = ${claim.value} (${claim.status})` },
              ],
              details: { claim },
            };
          }
          if (!p.entity) {
            return {
              content: [{ type: "text", text: "Provide entity or claim_id." }],
              details: { error: "missing_args" },
            };
          }
          const beliefs = store.getBeliefsForEntity(p.entity, p.include_non_primary === true);
          return {
            content: [
              {
                type: "text",
                text:
                  beliefs.length === 0
                    ? `No beliefs for ${p.entity}.`
                    : beliefs
                        .map(
                          (c) =>
                            `- [${c.status}] ${c.predicate} = ${c.value} (confidence ${c.confidence}, id ${c.id.slice(0, 8)})`,
                        )
                        .join("\n"),
              },
            ],
            details: { count: beliefs.length, beliefs },
          };
        } catch (err) {
          return fail(err, "memory_belief_get");
        }
      },
    },
    { name: "memory_belief_get" },
  );

  api.registerTool(
    {
      name: "memory_belief_verify",
      label: "Verify Claim",
      description: "Mark a claim as verified, optionally citing the evidence capsule that verified it.",
      parameters: Type.Object({
        claim_id: Type.String(),
        evidence_capsule_id: Type.Optional(Type.String()),
        confidence: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { claim_id: string; evidence_capsule_id?: string; confidence?: number };
          const claim = store.resolveClaim(p.claim_id.trim());
          if (!claim) return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const updated = store.verifyClaim(claim.id, {
            evidenceCapsuleId: p.evidence_capsule_id,
            confidence: p.confidence,
          });
          if (p.evidence_capsule_id) store.linkEvidenceCapsuleToClaim(p.evidence_capsule_id, claim.id);
          return {
            content: [{ type: "text", text: `Claim ${claim.id.slice(0, 8)} → ${updated.status}.` }],
            details: { claim: updated },
          };
        } catch (err) {
          return fail(err, "memory_belief_verify");
        }
      },
    },
    { name: "memory_belief_verify" },
  );

  api.registerTool(
    {
      name: "memory_belief_contradict",
      label: "Contradict Claim",
      description: "Mark two claims as mutually contradicting each other.",
      parameters: Type.Object({
        claim_id: Type.String(),
        with_claim_id: Type.String(),
        reason: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { claim_id: string; with_claim_id: string; reason?: string };
          const claim = store.resolveClaim(p.claim_id.trim());
          const other = store.resolveClaim(p.with_claim_id.trim());
          if (!claim || !other)
            return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const updated = store.contradictClaim(claim.id, other.id, p.reason);
          return {
            content: [
              { type: "text", text: `Claims ${claim.id.slice(0, 8)} and ${other.id.slice(0, 8)} marked contradicted.` },
            ],
            details: { claim: updated },
          };
        } catch (err) {
          return fail(err, "memory_belief_contradict");
        }
      },
    },
    { name: "memory_belief_contradict" },
  );

  api.registerTool(
    {
      name: "memory_belief_supersede",
      label: "Supersede Claim",
      description: "Mark a claim as superseded by a newer claim. The old claim stops being primary truth.",
      parameters: Type.Object({ claim_id: Type.String(), by_claim_id: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { claim_id: string; by_claim_id: string };
          const claim = store.resolveClaim(p.claim_id.trim());
          const successor = store.resolveClaim(p.by_claim_id.trim());
          if (!claim || !successor)
            return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const updated = store.supersedeClaim(claim.id, successor.id);
          return {
            content: [
              { type: "text", text: `Claim ${claim.id.slice(0, 8)} superseded by ${successor.id.slice(0, 8)}.` },
            ],
            details: { claim: updated },
          };
        } catch (err) {
          return fail(err, "memory_belief_supersede");
        }
      },
    },
    { name: "memory_belief_supersede" },
  );

  api.registerTool(
    {
      name: "memory_belief_explain",
      label: "Explain Claim",
      description:
        "Explain a claim: status, confidence, evidence, last verification, invalidation conditions, and whether a live check is required before acting on it. Prompt-safe and redacted.",
      parameters: Type.Object({
        claim_id: Type.String(),
        format: Type.Optional(stringEnum(["md", "json"] as const)),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (gate()) return notEnabled();
        try {
          const p = params as { claim_id: string; format?: "md" | "json" };
          const claim = store.resolveClaim(p.claim_id.trim());
          if (!claim) return { content: [{ type: "text", text: "Claim not found." }], details: { error: "not_found" } };
          const liveCheck = store.getLiveCheckStatus(claim.id);
          const text =
            p.format === "json"
              ? JSON.stringify({ claim, liveCheck }, null, 2)
              : renderClaimExplainMarkdown(claim, liveCheck);
          return { content: [{ type: "text", text }], details: { claim, liveCheck } };
        } catch (err) {
          return fail(err, "memory_belief_explain");
        }
      },
    },
    { name: "memory_belief_explain" },
  );
}
