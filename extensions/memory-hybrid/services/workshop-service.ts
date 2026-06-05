/**
 * Workshop service — unified approve/reject/quarantine/revise/undo across proposal stores.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  applyApprovedProposal,
  capProposalConfidence,
  getProposalExpiryError,
  validateProposalContent,
} from "../cli/proposals.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnv } from "../utils/env-manager.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { CrystallizationProposer } from "./crystallization-proposer.js";
import { generateAutoSkillForProcedure } from "./procedure-skill-generator.js";
import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  inspectUnifiedProposal,
  listUnifiedProposals,
  parseUnifiedKey,
  type UnifiedProposalStores,
} from "./unified-proposals.js";
import { readProposalRollback, undoProposalRollback, deleteProposalRollback } from "./proposal-rollback.js";
import { GapDetector } from "./gap-detector.js";
import { ToolProposer } from "./tool-proposer.js";

export type WorkshopServiceContext = UnifiedProposalStores & {
  resolvedSqlitePath: string;
  workflowStore?: WorkflowStore | null;
  api?: ClawdbotPluginApi;
  maxPending?: number;
};

export type WorkshopActionResult = { ok: true; message: string; details?: Record<string, unknown> } | { ok: false; error: string };

function resolveKey(unifiedKey: string): { type: string; storeId: string } | { error: string } {
  const parsed = parseUnifiedKey(unifiedKey);
  if (!parsed) return { error: `Invalid unified proposal key: ${unifiedKey}` };
  return parsed;
}

export function workshopList(ctx: WorkshopServiceContext, opts?: { status?: "pending"; limit?: number }) {
  return listUnifiedProposals(ctx, opts);
}

export function workshopInspect(ctx: WorkshopServiceContext, unifiedKey: string) {
  return inspectUnifiedProposal(ctx, unifiedKey);
}

export async function workshopApprove(ctx: WorkshopServiceContext, unifiedKey: string): Promise<WorkshopActionResult> {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const item = inspectUnifiedProposal(ctx, unifiedKey);
  if (!item) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
  if (!item.actions.approveSupported) return { ok: false, error: `Approve not supported for ${item.type} proposal in status ${item.status}` };

  switch (parsed.type) {
    case "persona": {
      if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
      const p = ctx.proposalsDb.get(parsed.storeId);
      if (!p) return { ok: false, error: "Proposal not found" };
      if (p.status !== "pending") return { ok: false, error: `Proposal is ${p.status}` };
      const expiryError = getProposalExpiryError(p);
      if (expiryError) return { ok: false, error: expiryError };
      ctx.proposalsDb.updateStatus(parsed.storeId, "approved");
      const applyResult = await applyApprovedProposal(
        { proposalsDb: ctx.proposalsDb, cfg: ctx.cfg, resolvedSqlitePath: ctx.resolvedSqlitePath, api: ctx.api },
        parsed.storeId,
      );
      if (!applyResult.ok) {
        ctx.proposalsDb.updateStatus(parsed.storeId, "pending");
        return { ok: false, error: applyResult.error };
      }
      return { ok: true, message: `Applied persona proposal to ${applyResult.targetFile}`, details: { targetFile: applyResult.targetFile } };
    }
    case "crystallization": {
      if (!ctx.crystallizationStore || !ctx.workflowStore) return { ok: false, error: "Crystallization not available" };
      const proposer = new CrystallizationProposer(ctx.workflowStore, ctx.crystallizationStore, ctx.cfg.crystallization);
      const result = proposer.approveProposal(parsed.storeId);
      return result.success
        ? { ok: true, message: result.message, details: { outputPath: result.outputPath } }
        : { ok: false, error: result.message };
    }
    case "tool": {
      if (!ctx.toolProposalStore || !ctx.workflowStore) return { ok: false, error: "Tool proposals not available" };
      const gapDetector = new GapDetector(ctx.workflowStore);
      const proposer = new ToolProposer(gapDetector, ctx.toolProposalStore, ctx.cfg.selfExtension);
      const result = proposer.approveProposal(parsed.storeId);
      return result.success ? { ok: true, message: result.message } : { ok: false, error: result.message };
    }
    case "procedure-skill": {
      const logger = { info: (s: string) => ctx.api?.logger.info?.(s), warn: (s: string) => ctx.api?.logger.warn?.(s) };
      const result = generateAutoSkillForProcedure(
        ctx.factsDb,
        {
          procedureId: parsed.storeId,
          validationThreshold: ctx.cfg.procedures?.validationThreshold ?? 3,
          skillsAutoPath: ctx.cfg.procedures?.skillsAutoPath,
          // Workshop approval is the human promote gate — write directly to skillsAutoPath.
          requireApprovalForPromote: false,
          apply: true,
        },
        logger,
      );
      if (!result.ok) {
        return { ok: false, error: "reason" in result ? result.reason : "procedure promotion failed" };
      }
      return { ok: true, message: `Generated skill at ${result.skillPath ?? "skills/auto"}`, details: { skillPath: result.skillPath } };
    }
    default:
      return { ok: false, error: `Unknown proposal type: ${parsed.type}` };
  }
}

export function workshopReject(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  reason?: string,
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const item = inspectUnifiedProposal(ctx, unifiedKey);
  if (!item) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
  if (!item.actions.rejectSupported) return { ok: false, error: `Reject not supported for ${item.type}` };

  switch (parsed.type) {
    case "persona": {
      if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
      const p = ctx.proposalsDb.get(parsed.storeId);
      if (!p || p.status !== "pending") return { ok: false, error: "Proposal not pending" };
      ctx.proposalsDb.updateStatus(parsed.storeId, "rejected", undefined, reason);
      return { ok: true, message: "Persona proposal rejected" };
    }
    case "crystallization": {
      if (!ctx.crystallizationStore || !ctx.workflowStore) return { ok: false, error: "Crystallization not available" };
      const proposer = new CrystallizationProposer(ctx.workflowStore, ctx.crystallizationStore, ctx.cfg.crystallization);
      const result = proposer.rejectProposal(parsed.storeId, reason);
      return result.success ? { ok: true, message: result.message } : { ok: false, error: result.message };
    }
    case "tool": {
      if (!ctx.toolProposalStore || !ctx.workflowStore) return { ok: false, error: "Tool proposals not available" };
      const gapDetector = new GapDetector(ctx.workflowStore);
      const proposer = new ToolProposer(gapDetector, ctx.toolProposalStore, ctx.cfg.selfExtension);
      const result = proposer.rejectProposal(parsed.storeId);
      return result.success ? { ok: true, message: result.message } : { ok: false, error: result.message };
    }
    default:
      return { ok: false, error: `Reject not supported for type ${parsed.type}` };
  }
}

export function workshopQuarantine(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  reason?: string,
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };

  if (parsed.type === "persona") {
    if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
    const p = ctx.proposalsDb.get(parsed.storeId);
    if (!p || p.status !== "pending") return { ok: false, error: "Proposal not pending" };
    ctx.proposalsDb.updateStatus(parsed.storeId, "rejected", undefined, reason ? `quarantine: ${reason}` : "quarantine");
    return { ok: true, message: "Persona proposal quarantined (marked rejected with quarantine reason)" };
  }

  if (parsed.type === "crystallization" && ctx.crystallizationStore && ctx.workflowStore) {
    const proposal = ctx.crystallizationStore.getById(parsed.storeId);
    if (!proposal) return { ok: false, error: "Proposal not found" };
    const isPending = proposal.status === "drafted" || proposal.status === "validated";
    const proposer = new CrystallizationProposer(ctx.workflowStore, ctx.crystallizationStore, ctx.cfg.crystallization);
    if (isPending) {
      const result = proposer.rejectProposal(
        parsed.storeId,
        reason ? `quarantine: ${reason}` : "workshop quarantine",
      );
      return result.success
        ? { ok: true, message: "Crystallization proposal quarantined (rejected)" }
        : { ok: false, error: result.message };
    }
    if (proposal.status === "installed") {
      const updated = ctx.crystallizationStore.quarantine(parsed.storeId, reason ?? "workshop quarantine");
      return updated
        ? { ok: true, message: "Crystallization proposal quarantined" }
        : { ok: false, error: "Could not quarantine crystallization proposal" };
    }
    return { ok: false, error: `Cannot quarantine crystallization proposal in status ${proposal.status}` };
  }

  if (parsed.type === "tool" && ctx.toolProposalStore) {
    const updated = ctx.toolProposalStore.updateStatus(parsed.storeId, "rejected", "proposed");
    return updated
      ? { ok: true, message: "Tool proposal quarantined (marked rejected)" }
      : { ok: false, error: "Could not quarantine tool proposal" };
  }

  return { ok: false, error: "Quarantine not supported for this proposal type" };
}

export function workshopRevise(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  revision: string,
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (parsed.type !== "persona") return { ok: false, error: "In-place revision is only supported for persona proposals" };
  if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
  const p = ctx.proposalsDb.get(parsed.storeId);
  if (!p || p.status !== "pending") return { ok: false, error: "Proposal not pending" };
  const trimmed = revision.trim();
  if (!trimmed) return { ok: false, error: "Revision must be non-empty" };
  const contentCheck = validateProposalContent(`${p.title}\n${p.observation}\n${trimmed}`);
  if (!contentCheck.ok) {
    return { ok: false, error: `Revision failed safety validation (${contentCheck.reason})` };
  }
  if (!ctx.cfg.personaProposals.allowedFiles.includes(p.targetFile as (typeof ctx.cfg.personaProposals.allowedFiles)[number])) {
    return { ok: false, error: `Target file ${p.targetFile} is not in allowedFiles` };
  }
  const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const snapshot = getFileSnapshot(join(workspace, p.targetFile));
  const confidence = capProposalConfidence(p.confidence, p.targetFile, trimmed);
  if (confidence < ctx.cfg.personaProposals.minConfidence) {
    return {
      ok: false,
      error: `Revision would reduce effective confidence to ${confidence.toFixed(2)} (min ${ctx.cfg.personaProposals.minConfidence})`,
    };
  }
  const updated = ctx.proposalsDb.updateSuggestedChange(parsed.storeId, trimmed, {
    targetMtimeMs: snapshot?.mtimeMs ?? null,
    targetHash: snapshot?.hash ?? null,
    confidence,
  });
  if (!updated || updated.suggestedChange !== trimmed) {
    return { ok: false, error: "Failed to revise proposal (not found or not pending)" };
  }
  return { ok: true, message: "Proposal revised in place" };
}

export function workshopUndo(ctx: WorkshopServiceContext, unifiedKey: string): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (parsed.type !== "persona") return { ok: false, error: "Undo is only supported for persona proposals" };
  if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
  const proposal = ctx.proposalsDb.get(parsed.storeId);
  if (!proposal || proposal.status !== "applied") {
    return { ok: false, error: "Proposal is not in applied state" };
  }
  const record = readProposalRollback(ctx.resolvedSqlitePath, parsed.storeId);
  if (!record) return { ok: false, error: "No rollback metadata found for this proposal" };
  const result = undoProposalRollback(ctx.resolvedSqlitePath, parsed.storeId);
  if (!result.ok) return { ok: false, error: result.error };
  ctx.proposalsDb.updateStatus(parsed.storeId, "pending");
  deleteProposalRollback(ctx.resolvedSqlitePath, parsed.storeId);
  return { ok: true, message: `Restored ${result.targetPath} and reverted proposal to pending` };
}

export function workshopPendingCount(ctx: WorkshopServiceContext): number {
  return listUnifiedProposals(ctx, { status: "pending" }).length;
}

export function workshopMaxPending(ctx: WorkshopServiceContext): number {
  return ctx.maxPending ?? DEFAULT_WORKSHOP_MAX_PENDING;
}
