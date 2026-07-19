/**
 * Evidence capsule tools (Issue #2148) — durable proof objects backing claims,
 * task checkpoints, goal assessments, and final reports.
 */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { LoomStore } from "../backends/loom-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { renderEvidenceCapsuleMarkdown } from "../services/evidence-capsule-render.js";
import { EvidenceUnredactableError, redactEvidenceCapsuleInput } from "../services/evidence-redaction.js";
import type { CreateEvidenceCapsuleInput } from "../types/evidence-types.js";
import { stringEnum } from "../utils/typebox.js";

export interface EvidenceToolsContext {
  loomStore: LoomStore;
  cfg: HybridMemoryConfig;
  currentAgentIdRef: { value: string | null };
}

const notEnabled = () => ({
  content: [{ type: "text" as const, text: "The Loom is disabled. Set loom.enabled: true in plugin config." }],
  details: { error: "loom_disabled" },
});

function fail(err: unknown, operation: string) {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "loom-evidence", operation });
  return { content: [{ type: "text" as const, text: String(err) }], details: { error: String(err) } };
}

export function registerEvidenceTools(ctx: EvidenceToolsContext, api: ClawdbotPluginApi): void {
  const { loomStore: store, cfg, currentAgentIdRef } = ctx;
  const lc = cfg.loom;

  api.registerTool(
    {
      name: "memory_evidence_capsule_create",
      label: "Create Evidence Capsule",
      description:
        "Create a durable evidence capsule: a proof object recording what was checked, what changed, and what remains unverified. Secret-like values are redacted before storage. Capsules can back claims, task checkpoints, goal assessments, and final reports.",
      parameters: Type.Object({
        title: Type.String({ description: "Short title for the capsule." }),
        claim: Type.String({ description: "The statement this capsule supports." }),
        evidence: Type.Optional(
          Type.Array(
            Type.Object({
              kind: stringEnum([
                "command",
                "tool_output",
                "live_readback",
                "observation",
                "artifact_ref",
                "other",
              ] as const),
              text: Type.String(),
            }),
          ),
        ),
        commands_run: Type.Optional(Type.Array(Type.String())),
        artifacts: Type.Optional(
          Type.Array(Type.Object({ path: Type.String(), description: Type.Optional(Type.String()) })),
        ),
        unverified_items: Type.Optional(Type.Array(Type.String())),
        risk_flags: Type.Optional(Type.Array(Type.String())),
        limits: Type.Optional(Type.String({ description: "What was NOT checked / scope limits." })),
        linked_claim_ids: Type.Optional(Type.Array(Type.String())),
        linked_task_label: Type.Optional(Type.String()),
        linked_goal_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.evidence.enabled) return notEnabled();
        try {
          const p = params as unknown as {
            title: string;
            claim: string;
            evidence?: CreateEvidenceCapsuleInput["evidence"];
            commands_run?: string[];
            artifacts?: CreateEvidenceCapsuleInput["artifacts"];
            unverified_items?: string[];
            risk_flags?: string[];
            limits?: string;
            linked_claim_ids?: string[];
            linked_task_label?: string;
            linked_goal_id?: string;
          };
          const input: CreateEvidenceCapsuleInput = {
            title: p.title,
            claim: p.claim,
            evidence: p.evidence,
            commandsRun: p.commands_run,
            artifacts: p.artifacts,
            unverifiedItems: p.unverified_items,
            riskFlags: p.risk_flags,
            limits: p.limits,
            linkedClaimIds: p.linked_claim_ids,
            linkedTaskLabel: p.linked_task_label,
            linkedGoalId: p.linked_goal_id,
          };
          const content = redactEvidenceCapsuleInput(input, {
            redactSecrets: lc.evidence.redactSecrets,
            rejectUnredactable: lc.evidence.rejectUnredactable,
          });
          const capsule = store.createEvidenceCapsule({
            content,
            actor: currentAgentIdRef.value ?? undefined,
            linkedClaimIds: p.linked_claim_ids,
            linkedTaskLabel: p.linked_task_label,
            linkedGoalId: p.linked_goal_id,
          });
          for (const claimId of p.linked_claim_ids ?? []) {
            store.linkEvidenceCapsuleToClaim(capsule.id, claimId);
          }
          const redactedNote = content.redacted ? ` (${content.redactionCount} value(s) redacted)` : "";
          return {
            content: [
              {
                type: "text",
                text: `Created evidence capsule ${capsule.id.slice(0, 8)}: "${capsule.title}"${redactedNote}.`,
              },
            ],
            details: { id: capsule.id, capsule },
          };
        } catch (err) {
          if (err instanceof EvidenceUnredactableError) {
            return {
              content: [{ type: "text", text: `Refused to store capsule: ${err.message}` }],
              details: { error: "unredactable", field: err.field },
            };
          }
          return fail(err, "memory_evidence_capsule_create");
        }
      },
    },
    { name: "memory_evidence_capsule_create" },
  );

  api.registerTool(
    {
      name: "memory_evidence_capsule_show",
      label: "Show Evidence Capsule",
      description: "Show one evidence capsule as prompt-safe, redacted Markdown or structured JSON.",
      parameters: Type.Object({
        capsule_id: Type.String({ description: "Capsule id or short id prefix." }),
        format: Type.Optional(stringEnum(["md", "json"] as const)),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.evidence.enabled) return notEnabled();
        try {
          const p = params as { capsule_id?: string; format?: "md" | "json" };
          const capsule = store.resolveEvidenceCapsule(String(p.capsule_id ?? "").trim());
          if (!capsule)
            return {
              content: [{ type: "text", text: "Evidence capsule not found." }],
              details: { error: "not_found" },
            };
          const text =
            p.format === "json"
              ? JSON.stringify(capsule, null, 2)
              : renderEvidenceCapsuleMarkdown(capsule, { concise: false });
          return { content: [{ type: "text", text }], details: { capsule } };
        } catch (err) {
          return fail(err, "memory_evidence_capsule_show");
        }
      },
    },
    { name: "memory_evidence_capsule_show" },
  );

  api.registerTool(
    {
      name: "memory_evidence_capsule_attach",
      label: "Attach Evidence Capsule",
      description: "Link an evidence capsule to an active task label, a goal id, or a claim.",
      parameters: Type.Object({
        capsule_id: Type.String({ description: "Capsule id or short id prefix." }),
        task_label: Type.Optional(Type.String()),
        goal_id: Type.Optional(Type.String()),
        claim_id: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.evidence.enabled) return notEnabled();
        try {
          const p = params as { capsule_id?: string; task_label?: string; goal_id?: string; claim_id?: string };
          const capsule = store.resolveEvidenceCapsule(String(p.capsule_id ?? "").trim());
          if (!capsule)
            return {
              content: [{ type: "text", text: "Evidence capsule not found." }],
              details: { error: "not_found" },
            };
          let updated = capsule;
          if (p.task_label !== undefined || p.goal_id !== undefined) {
            updated = store.attachEvidenceCapsule(capsule.id, {
              linkedTaskLabel: p.task_label,
              linkedGoalId: p.goal_id,
            });
          }
          if (p.claim_id) updated = store.linkEvidenceCapsuleToClaim(capsule.id, p.claim_id);
          return {
            content: [{ type: "text", text: `Attached capsule ${capsule.id.slice(0, 8)}.` }],
            details: { capsule: updated },
          };
        } catch (err) {
          return fail(err, "memory_evidence_capsule_attach");
        }
      },
    },
    { name: "memory_evidence_capsule_attach" },
  );

  api.registerTool(
    {
      name: "memory_evidence_capsule_list",
      label: "List Evidence Capsules",
      description: "List evidence capsules, optionally filtered by linked claim/task/goal.",
      parameters: Type.Object({
        linked_claim_id: Type.Optional(Type.String()),
        linked_task_label: Type.Optional(Type.String()),
        linked_goal_id: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!lc.enabled || !lc.evidence.enabled) return notEnabled();
        try {
          const p = params as {
            linked_claim_id?: string;
            linked_task_label?: string;
            linked_goal_id?: string;
            limit?: number;
          };
          const capsules = store.listEvidenceCapsules({
            linkedClaimId: p.linked_claim_id,
            linkedTaskLabel: p.linked_task_label,
            linkedGoalId: p.linked_goal_id,
            limit: p.limit,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  capsules.length === 0
                    ? "No evidence capsules match."
                    : `${capsules.length} capsule(s):\n${capsules.map((c) => `- [${c.id.slice(0, 8)}] ${c.title}`).join("\n")}`,
              },
            ],
            details: { count: capsules.length, capsules },
          };
        } catch (err) {
          return fail(err, "memory_evidence_capsule_list");
        }
      },
    },
    { name: "memory_evidence_capsule_list" },
  );
}
