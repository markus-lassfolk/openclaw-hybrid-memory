/**
 * Crystallization Tools — expose crystallization workflow to the agent (Issue #208).
 *
 * Tools:
 *  - memory_crystallize:         manually trigger a crystallization cycle
 *  - memory_crystallize_list:    list pending/approved/rejected proposals
 *  - memory_crystallize_approve: approve a pending proposal (writes skill to disk)
 *  - memory_crystallize_reject:  reject a pending proposal
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import { capturePluginError } from "../services/error-reporter.js";
import { summarizeSkillProposalValidation } from "../services/generated-skill-validation.js";

interface CrystallizationToolsContext {
  crystallizationStore: CrystallizationStore;
  workflowStore: WorkflowStore;
  cfg: HybridMemoryConfig;
}

export function registerCrystallizationTools(ctx: CrystallizationToolsContext, api: ClawdbotPluginApi): void {
  const { crystallizationStore, workflowStore, cfg } = ctx;

  // -------------------------------------------------------------------------
  // memory_crystallize — trigger a crystallization cycle
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "memory_crystallize",
    label: "Trigger Workflow Crystallization",
    description:
      "Analyse workflow patterns and generate pending AgentSkill SKILL.md proposals from high-confidence patterns. Requires human approval (memory_crystallize_approve) before skills are written to disk.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      try {
        const proposer = new CrystallizationProposer(workflowStore, crystallizationStore, cfg.crystallization);
        // Issue: skill proposal lifecycle — tool-triggered crystallization should never install directly.
        const result = proposer.runCycle({ autoApproveOverride: false });

        const lines: string[] = [];
        lines.push("Crystallization cycle complete.");
        lines.push(`  Proposed: ${result.proposed}`);
        lines.push(`  Skipped:  ${result.skipped}`);
        if (result.reasons.length > 0) {
          lines.push("  Details:");
          result.reasons.forEach((r) => lines.push(`    - ${r}`));
        }
        if (result.proposed > 0) {
          lines.push("");
          lines.push("Use memory_crystallize_list to review proposals.");
          lines.push("Use memory_crystallize_approve <id> to approve and write a skill.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "crystallization",
          operation: "memory-crystallize",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // memory_crystallize_list — list proposals
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "memory_crystallize_list",
    label: "List Crystallization Proposals",
    description:
      "List crystallization proposals (proposal cards). Filter by lifecycle status (pending/approved/rejected or drafted/validated/installed/etc). Each entry includes ID for approve/reject.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("approved"),
            Type.Literal("rejected"),
            Type.Literal("drafted"),
            Type.Literal("validated"),
            Type.Literal("installed"),
            Type.Literal("quarantined"),
            Type.Literal("superseded"),
          ],
          {
            description: "Filter by proposal status. Omit to list all proposals.",
          },
        ),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Maximum number of proposals to return. Default: 20.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { status, limit } = params as {
        status?:
          | "pending"
          | "approved"
          | "rejected"
          | "drafted"
          | "validated"
          | "installed"
          | "quarantined"
          | "superseded";
        limit?: number;
      };

      try {
        const proposals = crystallizationStore.list({
          status,
          limit: limit ?? 20,
        });

        if (proposals.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: status ? `No ${status} crystallization proposals found.` : "No crystallization proposals found.",
              },
            ],
            details: [],
          };
        }

        const lines = proposals.map((p, i) => {
          let patternStats = "";
          try {
            const snap = JSON.parse(p.patternSnapshot) as {
              totalCount?: number;
              successRate?: number;
            };
            if (snap.totalCount !== undefined) {
              patternStats = ` | ${snap.totalCount} uses, ${Math.round((snap.successRate ?? 0) * 100)}% success`;
            }
          } catch {
            // ignore parse errors
          }
          let cardSummary = "";
          try {
            if (p.proposalCardJson) {
              const card = JSON.parse(p.proposalCardJson) as { category?: string; risks?: unknown; captures?: unknown };
              const cat = typeof card.category === "string" ? card.category : "";
              const captures =
                Array.isArray(card.captures) && card.captures.length > 0 ? ` | captures: ${card.captures.length}` : "";
              const risks = Array.isArray(card.risks) && card.risks.length > 0 ? ` | risks: ${card.risks.length}` : "";
              cardSummary = [cat ? ` | ${cat}` : "", captures, risks].join("");
            }
          } catch {
            // ignore parse errors
          }
          const outputInfo = p.outputPath ? ` → ${p.outputPath}` : "";
          const rejectInfo = p.rejectionReason ? ` (reason: ${p.rejectionReason})` : "";
          const validationInfo = p.validationResult
            ? `\n   Validation: ${summarizeSkillProposalValidation(p.validationResult)}`
            : "";
          return (
            `${i + 1}. [${p.status.toUpperCase()}] ${p.skillName}${patternStats}${cardSummary}\n` +
            `   ID: ${p.id}${outputInfo}${rejectInfo}${validationInfo}\n` +
            `   Created: ${p.createdAt}`
          );
        });

        const summary = `Found ${proposals.length} proposal(s)${status ? ` (${status})` : ""}:\n\n${lines.join("\n\n")}`;

        return {
          content: [{ type: "text", text: summary }],
          details: proposals,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "crystallization",
          operation: "memory-crystallize-list",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // memory_crystallize_approve — approve a pending proposal
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "memory_crystallize_approve",
    label: "Approve Crystallization Proposal",
    description:
      "Approve a crystallization proposal. Re-validates the skill content, then writes the SKILL.md file to disk. Optional overrides let you rename/categorize before installation.",
    parameters: Type.Object({
      id: Type.String({
        description: "The proposal ID to approve (from memory_crystallize_list).",
      }),
      name: Type.Optional(
        Type.String({
          description: "Optional rename (slug). If omitted, keeps the generated name.",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description: "Optional category override (e.g. workflow-automation).",
        }),
      ),
      recommended_output: Type.Optional(
        Type.Union([Type.Literal("SKILL.md only")], {
          description: "Optional output-type override.",
        }),
      ),
      overrideWarnings: Type.Optional(
        Type.Boolean({
          description: "Set true to approve when activation evaluation warns (requires explicit human intent).",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { id, name, category, recommended_output, overrideWarnings } = params as {
        id: string;
        name?: string;
        category?: string;
        recommended_output?: "SKILL.md only";
        overrideWarnings?: boolean;
      };

      try {
        const proposer = new CrystallizationProposer(workflowStore, crystallizationStore, cfg.crystallization);
        const result = proposer.approveProposal(id, {
          name,
          category,
          recommendedOutput: recommended_output,
          overrideWarnings,
        });

        return {
          content: [
            {
              type: "text",
              text: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "crystallization",
          operation: "memory-crystallize-approve",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  // -------------------------------------------------------------------------
  // memory_crystallize_reject — reject a pending proposal
  // -------------------------------------------------------------------------
  api.registerTool({
    name: "memory_crystallize_reject",
    label: "Reject Crystallization Proposal",
    description:
      "Reject a pending crystallization proposal. The pattern will not be crystallized into a skill. Optionally provide a reason.",
    parameters: Type.Object({
      id: Type.String({
        description: "The proposal ID to reject (from memory_crystallize_list).",
      }),
      reason: Type.Optional(
        Type.String({
          description: "Optional reason for rejection (stored for audit trail).",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const { id, reason } = params as { id: string; reason?: string };

      try {
        const proposer = new CrystallizationProposer(workflowStore, crystallizationStore, cfg.crystallization);
        const result = proposer.rejectProposal(id, reason);

        return {
          content: [
            {
              type: "text",
              text: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "crystallization",
          operation: "memory-crystallize-reject",
          phase: "runtime",
        });
        throw err;
      }
    },
  });

  api.registerTool({
    name: "memory_crystallize_skills_rescan",
    label: "Rescan Installed Crystallization Skills",
    description:
      "Re-read each installed proposal's SKILL.md from disk, run generated-skill validation, and persist results. Proposals that fail validation are moved to status quarantined with a stale-validation reason.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      try {
        const proposer = new CrystallizationProposer(workflowStore, crystallizationStore, cfg.crystallization);
        const result = proposer.rescanInstalledSkills();
        const lines: string[] = [
          `Scanned: ${result.scanned}, quarantined: ${result.quarantined}, skipped (no path): ${result.skipped}`,
        ];
        for (const m of result.messages) lines.push(`  ${m}`);
        for (const e of result.errors) lines.push(`  error: ${e}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "crystallization",
          operation: "memory-crystallize-skills-rescan",
          phase: "runtime",
        });
        throw err;
      }
    },
  });
}
