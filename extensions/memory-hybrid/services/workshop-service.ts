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
import { existsSync, rmSync } from "node:fs";
import { getEnv } from "../utils/env-manager.js";
import { resolveWorkspacePath } from "../utils/path.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { CrystallizationProposer, outputDirForInstalledSkill } from "./crystallization-proposer.js";
import { quarantineCrystallizedSkillOnDisk } from "./crystallization-disk.js";
import { generateAutoSkillForProcedure } from "./procedure-skill-generator.js";
import {
  DEFAULT_WORKSHOP_MAX_PENDING,
  inspectUnifiedProposal,
  listUnifiedProposals,
  listUndoablePersonaProposals,
  mergeWorkshopListItems,
  makeUnifiedKey,
  parseUnifiedKey,
  type UnifiedProposal,
  type UnifiedProposalStores,
} from "./unified-proposals.js";
import {
  DEFAULT_WORKSHOP_LIST_LIMIT,
  resolveWorkshopMaxPending,
  resolveWorkshopSessionKey,
  resolveWorkshopProposedSessionKey,
  resolveWorkshopAppliedSessionKey,
} from "./workshop-config.js";
import { readProposalRollback, undoProposalRollback, deleteProposalRollback } from "./proposal-rollback.js";
import { GapDetector } from "./gap-detector.js";
import { ToolProposer } from "./tool-proposer.js";
import type { ChangeFeed } from "./change-feed.js";
import {
  emitChangeReverted,
  emitCrystallizationProposed,
  emitPersonaProposed,
  emitProcedureSkillProposed,
  emitSkillApplied,
  emitToolProposed,
  supersedeActiveProposedEvent,
  syncAppliedWithdrawnInChangeFeed,
  syncProposalWithdrawnInChangeFeed,
} from "./change-feed-emit.js";

export type WorkshopServiceContext = UnifiedProposalStores & {
  resolvedSqlitePath: string;
  workflowStore?: WorkflowStore | null;
  api?: ClawdbotPluginApi;
  maxPending?: number;
  changeFeed?: ChangeFeed | null;
  sessionKey?: string;
};

export function withWorkshopDefaults(
  ctx: Omit<WorkshopServiceContext, "maxPending"> & Partial<Pick<WorkshopServiceContext, "maxPending">>,
): WorkshopServiceContext {
  return {
    ...ctx,
    maxPending: ctx.maxPending ?? resolveWorkshopMaxPending(ctx.cfg),
    sessionKey: ctx.sessionKey ?? resolveWorkshopSessionKey(ctx.cfg),
  };
}

export type WorkshopActionResult =
  | { ok: true; message: string; details?: Record<string, unknown> }
  | { ok: false; error: string };

function resolveKey(unifiedKey: string): { type: string; storeId: string } | { error: string } {
  const parsed = parseUnifiedKey(unifiedKey);
  if (!parsed) return { error: `Invalid unified proposal key: ${unifiedKey}` };
  return parsed;
}

export function workshopList(
  ctx: WorkshopServiceContext,
  opts?: { status?: "pending"; limit?: number; includeUndoable?: boolean },
) {
  const limit = opts?.limit ?? DEFAULT_WORKSHOP_LIST_LIMIT;
  const status = opts?.status ?? "pending";
  const pending = listUnifiedProposals(ctx, { status, limit });
  const includeUndoable = opts?.includeUndoable ?? true;
  if (!includeUndoable || status !== "pending") return pending;
  const undoable = listUndoablePersonaProposals(ctx, Math.min(20, limit));
  return mergeWorkshopListItems(pending, undoable, limit);
}

export function workshopInspect(ctx: WorkshopServiceContext, unifiedKey: string) {
  return inspectUnifiedProposal(ctx, unifiedKey);
}

/** Backfill missing proposed change-feed events for backlog items (uses broadcast session). */
export function syncWorkshopProposedEvents(ctx: WorkshopServiceContext): number {
  if (!ctx.changeFeed) return 0;
  const pending = listUnifiedProposals(ctx, { status: "pending", limit: 200 });
  let emitted = 0;
  for (const p of pending) {
    if (p.status !== "pending") continue;
    if (ctx.changeFeed.findActiveByProposalKey(p.unifiedKey, "proposed")) continue;
    switch (p.type) {
      case "persona":
        emitPersonaProposed(ctx.changeFeed, ctx.cfg, {
          sessionKey: resolveWorkshopProposedSessionKey(),
          proposalId: p.id,
          title: p.title,
          targetFile: p.targetPath ?? "SOUL.md",
          detail: p.preview,
        });
        emitted++;
        break;
      case "crystallization":
        emitCrystallizationProposed(ctx.changeFeed, ctx.cfg, {
          sessionKey: resolveWorkshopProposedSessionKey(),
          proposalId: p.id,
          skillName: p.title,
          detail: p.preview,
        });
        emitted++;
        break;
      case "tool":
        emitToolProposed(ctx.changeFeed, ctx.cfg, {
          sessionKey: resolveWorkshopProposedSessionKey(),
          proposalId: p.id,
          toolName: p.title,
          detail: p.preview,
        });
        emitted++;
        break;
      case "procedure-skill":
        emitProcedureSkillProposed(ctx.changeFeed, ctx.cfg, {
          sessionKey: resolveWorkshopProposedSessionKey(),
          procedureId: p.id,
          title: p.title,
          detail: p.preview,
        });
        emitted++;
        break;
      default:
        break;
    }
  }
  return emitted;
}

function workshopAppliedSessionKey(ctx: WorkshopServiceContext): string {
  return ctx.sessionKey ?? resolveWorkshopAppliedSessionKey(ctx.cfg);
}

function dismissProcedureSkillProposal(
  ctx: WorkshopServiceContext,
  procedureId: string,
  reason?: string,
  opts?: { skipChangeFeed?: boolean },
): WorkshopActionResult {
  const proc = ctx.factsDb.getProcedureById(procedureId);
  if (!proc) return { ok: false, error: "Procedure not found" };
  if (proc.promotedToSkill === 1) return { ok: false, error: "Procedure skill is already promoted" };
  if (proc.skillState === "rejected" || proc.skillState === "archived") {
    return { ok: true, message: "Procedure skill promotion already dismissed" };
  }
  const now = Math.floor(Date.now() / 1000);
  const summary = reason ?? "dismissed via workshop";
  const result = ctx.factsDb
    .getRawDb()
    .prepare(
      `UPDATE procedures
         SET skill_state = 'rejected',
             skill_state_reason = ?,
             skill_state_changed_at = ?,
             updated_at = ?
       WHERE id = ? AND promoted_to_skill = 0`,
    )
    .run(summary, now, now, procedureId);
  if (result.changes === 0) return { ok: false, error: "Could not dismiss procedure skill proposal" };
  if (!opts?.skipChangeFeed) {
    syncProposalWithdrawnInChangeFeed(
      ctx.changeFeed,
      ctx.cfg,
      makeUnifiedKey("procedure-skill", procedureId),
      reason ? `Dismissed: ${reason}` : "Procedure skill promotion dismissed",
    );
  }
  return { ok: true, message: "Procedure skill promotion dismissed" };
}

/** Withdraw an approved tool proposal (change-feed revert / operator undo). */
export function workshopWithdrawTool(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  reason?: string,
  opts?: { skipChangeFeed?: boolean },
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (parsed.type !== "tool") return { ok: false, error: "Not a tool proposal" };
  if (!ctx.toolProposalStore) return { ok: false, error: "Tool proposals not available" };
  const proposal = ctx.toolProposalStore.getById(parsed.storeId);
  if (!proposal) return { ok: false, error: "Proposal not found" };
  const fromStatus =
    proposal.status === "approved"
      ? "approved"
      : proposal.status === "proposed"
        ? "proposed"
        : proposal.status === "implemented"
          ? "implemented"
          : null;
  if (!fromStatus) {
    return { ok: false, error: `Tool proposal is ${proposal.status} — cannot withdraw` };
  }
  const updated = ctx.toolProposalStore.updateStatus(
    parsed.storeId,
    "rejected",
    fromStatus,
    reason ?? "withdrawn via workshop",
  );
  if (!updated) return { ok: false, error: "Could not withdraw tool proposal" };
  if (!opts?.skipChangeFeed) {
    if (fromStatus === "approved" || fromStatus === "implemented") {
      syncAppliedWithdrawnInChangeFeed(
        ctx.changeFeed,
        ctx.cfg,
        unifiedKey,
        reason ? `Withdrawn: ${reason}` : "Tool proposal withdrawn",
      );
    } else {
      syncProposalWithdrawnInChangeFeed(
        ctx.changeFeed,
        ctx.cfg,
        unifiedKey,
        reason ? `Rejected: ${reason}` : "Tool proposal rejected",
      );
    }
  }
  return { ok: true, message: "Tool proposal withdrawn" };
}

export async function workshopApprove(ctx: WorkshopServiceContext, unifiedKey: string): Promise<WorkshopActionResult> {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const item = inspectUnifiedProposal(ctx, unifiedKey);
  if (!item) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
  if (!item.actions.approveSupported)
    return { ok: false, error: `Approve not supported for ${item.type} proposal in status ${item.status}` };

  switch (parsed.type) {
    case "persona": {
      if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
      const p = ctx.proposalsDb.get(parsed.storeId);
      if (!p) return { ok: false, error: "Proposal not found" };
      if (p.status !== "pending") return { ok: false, error: `Proposal is ${p.status}` };
      const expiryError = getProposalExpiryError(p);
      if (expiryError) return { ok: false, error: expiryError };
      const approved = ctx.proposalsDb.updateStatusIf(parsed.storeId, "approved", "pending");
      if (!approved) return { ok: false, error: "Proposal is not pending" };
      const applyResult = await applyApprovedProposal(
        {
          proposalsDb: ctx.proposalsDb,
          cfg: ctx.cfg,
          resolvedSqlitePath: ctx.resolvedSqlitePath,
          api: ctx.api,
          changeFeed: ctx.changeFeed,
          sessionKey: workshopAppliedSessionKey(ctx),
        },
        parsed.storeId,
      );
      if (!applyResult.ok) {
        ctx.proposalsDb.updateStatusIf(parsed.storeId, "pending", "approved");
        return { ok: false, error: applyResult.error };
      }
      return {
        ok: true,
        message: `Applied persona proposal to ${applyResult.targetFile}`,
        details: { targetFile: applyResult.targetFile },
      };
    }
    case "crystallization": {
      if (!ctx.crystallizationStore || !ctx.workflowStore) return { ok: false, error: "Crystallization not available" };
      const proposer = new CrystallizationProposer(
        ctx.workflowStore,
        ctx.crystallizationStore,
        ctx.cfg.crystallization,
      );
      const result = proposer.approveProposal(parsed.storeId);
      if (result.success) {
        emitSkillApplied(ctx.changeFeed, ctx.cfg, {
          sessionKey: workshopAppliedSessionKey(ctx),
          proposalKey: unifiedKey,
          title: `Skill installed: ${item.title}`,
          detail: result.message,
          category: "skill",
        });
        supersedeActiveProposedEvent(ctx.changeFeed, unifiedKey);
      }
      return result.success
        ? { ok: true, message: result.message, details: { outputPath: result.outputPath } }
        : { ok: false, error: result.message };
    }
    case "tool": {
      if (!ctx.toolProposalStore || !ctx.workflowStore) return { ok: false, error: "Tool proposals not available" };
      const gapDetector = new GapDetector(ctx.workflowStore);
      const proposer = new ToolProposer(gapDetector, ctx.toolProposalStore, ctx.cfg.selfExtension);
      const result = proposer.approveProposal(parsed.storeId);
      if (result.success) {
        emitSkillApplied(ctx.changeFeed, ctx.cfg, {
          sessionKey: workshopAppliedSessionKey(ctx),
          proposalKey: unifiedKey,
          title: `Tool proposal approved: ${item.title}`,
          detail: result.message,
          category: "tool",
          rollbackAvailable: true,
        });
        supersedeActiveProposedEvent(ctx.changeFeed, unifiedKey);
      }
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
      const procedureKey = makeUnifiedKey("procedure-skill", parsed.storeId);
      supersedeActiveProposedEvent(ctx.changeFeed, procedureKey);
      if (!result.alreadyPromoted) {
        const draftNote = result.enabled === false ? " (draft, enable manually after review)" : "";
        emitSkillApplied(ctx.changeFeed, ctx.cfg, {
          sessionKey: workshopAppliedSessionKey(ctx),
          proposalKey: makeUnifiedKey("procedure-skill", parsed.storeId),
          title: `Procedure skill draft written: ${item.title}${draftNote}`,
          detail: result.skillPath ? `Written to ${result.skillPath}` : undefined,
          category: "procedure-skill",
        });
      }
      return {
        ok: true,
        message: `Generated skill at ${result.skillPath ?? "skills/auto"}`,
        details: { skillPath: result.skillPath },
      };
    }
    default:
      return { ok: false, error: `Unknown proposal type: ${parsed.type}` };
  }
}

export function workshopReject(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  reason?: string,
  opts?: { skipChangeFeed?: boolean },
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
      if (!p) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
      if (p.status !== "pending") {
        if (p.status === "rejected") return { ok: true, message: "Persona proposal already rejected" };
        return { ok: false, error: "Proposal not pending" };
      }
      const rejected = ctx.proposalsDb.updateStatusIf(parsed.storeId, "rejected", "pending", undefined, reason);
      if (!rejected) return { ok: false, error: "Proposal is not pending" };
      if (!opts?.skipChangeFeed) {
        syncProposalWithdrawnInChangeFeed(
          ctx.changeFeed,
          ctx.cfg,
          unifiedKey,
          reason ? `Rejected: ${reason}` : "Proposal rejected via workshop",
        );
      }
      return { ok: true, message: "Persona proposal rejected" };
    }
    case "crystallization": {
      if (!ctx.crystallizationStore || !ctx.workflowStore) return { ok: false, error: "Crystallization not available" };
      const existing = ctx.crystallizationStore.getById(parsed.storeId);
      if (!existing) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
      if (existing.status !== "pending") {
        if (existing.status === "rejected") return { ok: true, message: "Crystallization proposal already rejected" };
        return { ok: false, error: "Proposal not pending" };
      }
      const proposer = new CrystallizationProposer(
        ctx.workflowStore,
        ctx.crystallizationStore,
        ctx.cfg.crystallization,
      );
      const result = proposer.rejectProposal(parsed.storeId, reason);
      if (!result.success) return { ok: false, error: result.message };
      if (!opts?.skipChangeFeed) {
        syncProposalWithdrawnInChangeFeed(
          ctx.changeFeed,
          ctx.cfg,
          unifiedKey,
          reason ? `Rejected: ${reason}` : "Proposal rejected via workshop",
        );
      }
      return { ok: true, message: result.message };
    }
    case "tool": {
      if (!ctx.toolProposalStore || !ctx.workflowStore) return { ok: false, error: "Tool proposals not available" };
      const existing = ctx.toolProposalStore.getById(parsed.storeId);
      if (!existing) return { ok: false, error: `Proposal not found: ${unifiedKey}` };
      if (existing.status !== "proposed") {
        if (existing.status === "rejected") return { ok: true, message: "Tool proposal already rejected" };
        return { ok: false, error: "Proposal not pending" };
      }
      const gapDetector = new GapDetector(ctx.workflowStore);
      const proposer = new ToolProposer(gapDetector, ctx.toolProposalStore, ctx.cfg.selfExtension);
      const result = proposer.rejectProposal(parsed.storeId, reason);
      if (!result.success) return { ok: false, error: result.message };
      if (!opts?.skipChangeFeed) {
        syncProposalWithdrawnInChangeFeed(
          ctx.changeFeed,
          ctx.cfg,
          unifiedKey,
          reason ? `Rejected: ${reason}` : "Proposal rejected via workshop",
        );
      }
      return { ok: true, message: result.message };
    }
    case "procedure-skill": {
      return dismissProcedureSkillProposal(ctx, parsed.storeId, reason, opts);
    }
    default:
      return { ok: false, error: `Reject not supported for type ${parsed.type}` };
  }
}

export function workshopQuarantine(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  reason?: string,
  opts?: { skipChangeFeed?: boolean },
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };

  if (parsed.type === "persona") {
    if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
    const p = ctx.proposalsDb.get(parsed.storeId);
    if (!p || p.status !== "pending") return { ok: false, error: "Proposal not pending" };
    const quarantined = ctx.proposalsDb.updateStatusIf(
      parsed.storeId,
      "rejected",
      "pending",
      undefined,
      reason ? `quarantine: ${reason}` : "quarantine",
    );
    if (!quarantined) return { ok: false, error: "Proposal is not pending" };
    if (!opts?.skipChangeFeed) {
      syncProposalWithdrawnInChangeFeed(
        ctx.changeFeed,
        ctx.cfg,
        unifiedKey,
        reason ? `Quarantined: ${reason}` : "Proposal quarantined via workshop",
      );
    }
    return { ok: true, message: "Persona proposal quarantined (marked rejected with quarantine reason)" };
  }

  if (parsed.type === "crystallization" && ctx.crystallizationStore && ctx.workflowStore) {
    const proposal = ctx.crystallizationStore.getById(parsed.storeId);
    if (!proposal) return { ok: false, error: "Proposal not found" };
    const isPending = proposal.status === "drafted" || proposal.status === "validated";
    const proposer = new CrystallizationProposer(ctx.workflowStore, ctx.crystallizationStore, ctx.cfg.crystallization);
    if (isPending) {
      const result = proposer.rejectProposal(parsed.storeId, reason ? `quarantine: ${reason}` : "workshop quarantine");
      if (!result.success) return { ok: false, error: result.message };
      if (!opts?.skipChangeFeed) {
        syncProposalWithdrawnInChangeFeed(
          ctx.changeFeed,
          ctx.cfg,
          unifiedKey,
          reason ? `Quarantined: ${reason}` : "Proposal quarantined via workshop",
        );
      }
      return { ok: true, message: "Crystallization proposal quarantined (rejected)" };
    }
    if (proposal.status === "installed") {
      const updated = ctx.crystallizationStore.quarantine(parsed.storeId, reason ?? "workshop quarantine");
      if (updated) {
        let diskMessage = "";
        if (proposal.outputPath?.trim()) {
          const outputDir = outputDirForInstalledSkill(
            proposal.outputPath,
            proposal.skillName,
            ctx.cfg.crystallization?.outputDir ?? "skills/crystallized",
          );
          const diskResult = quarantineCrystallizedSkillOnDisk(proposal.outputPath, outputDir);
          if (diskResult.movedTo) {
            ctx.crystallizationStore.updateOutputPath(parsed.storeId, join(diskResult.movedTo, "SKILL.md"));
            diskMessage = ` (moved to ${diskResult.movedTo})`;
          } else if (diskResult.error) {
            diskMessage = ` (disk quarantine: ${diskResult.error})`;
          }
        }
        if (!opts?.skipChangeFeed) {
          syncAppliedWithdrawnInChangeFeed(
            ctx.changeFeed,
            ctx.cfg,
            unifiedKey,
            reason ? `Quarantined: ${reason}` : "Installed skill quarantined via workshop",
          );
        }
        return { ok: true, message: `Crystallization proposal quarantined${diskMessage}` };
      }
      return { ok: false, error: "Could not quarantine crystallization proposal" };
    }
    return { ok: false, error: `Cannot quarantine crystallization proposal in status ${proposal.status}` };
  }

  if (parsed.type === "tool" && ctx.toolProposalStore) {
    const updated = ctx.toolProposalStore.updateStatus(
      parsed.storeId,
      "rejected",
      "proposed",
      reason ? `quarantine: ${reason}` : "quarantine",
    );
    if (!updated) return { ok: false, error: "Could not quarantine tool proposal" };
    if (!opts?.skipChangeFeed) {
      syncProposalWithdrawnInChangeFeed(
        ctx.changeFeed,
        ctx.cfg,
        unifiedKey,
        reason ? `Quarantined: ${reason}` : "Proposal quarantined via workshop",
      );
    }
    return { ok: true, message: "Tool proposal quarantined (marked rejected)" };
  }

  return { ok: false, error: "Quarantine not supported for this proposal type" };
}

/** Uninstall a promoted procedure skill (change-feed revert / operator undo). */
export function workshopRevertProcedureSkill(
  ctx: WorkshopServiceContext,
  procedureId: string,
  reason?: string,
  opts?: { skipChangeFeed?: boolean },
): WorkshopActionResult {
  const proc = ctx.factsDb.getProcedureById(procedureId);
  if (!proc) return { ok: false, error: "Procedure not found" };
  if (proc.promotedToSkill !== 1 || !proc.skillPath?.trim()) {
    return { ok: false, error: "Procedure skill is not installed" };
  }
  const skillPath = proc.skillPath.trim();
  const now = Math.floor(Date.now() / 1000);
  const summary = reason ?? "reverted via change feed";
  ctx.factsDb
    .getRawDb()
    .prepare(
      `UPDATE procedures
         SET promoted_to_skill = 0,
             skill_state = 'uninstalled',
             skill_state_reason = ?,
             skill_state_changed_at = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .run(summary, now, now, procedureId);
  try {
    const absolutePath = resolveWorkspacePath(skillPath);
    if (existsSync(absolutePath)) {
      rmSync(absolutePath, { recursive: true, force: true });
    }
  } catch {
    // DB state is authoritative; filesystem cleanup is best-effort.
  }
  const procedureKey = makeUnifiedKey("procedure-skill", procedureId);
  if (!opts?.skipChangeFeed) {
    syncAppliedWithdrawnInChangeFeed(ctx.changeFeed, ctx.cfg, procedureKey, summary);
  }
  return { ok: true, message: `Procedure skill uninstalled (${skillPath})` };
}

export function workshopRevise(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  revision: string,
): WorkshopActionResult {
  const parsed = resolveKey(unifiedKey);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (parsed.type !== "persona")
    return { ok: false, error: "In-place revision is only supported for persona proposals" };
  if (!ctx.proposalsDb) return { ok: false, error: "Persona proposals not available" };
  const p = ctx.proposalsDb.get(parsed.storeId);
  if (!p || p.status !== "pending") return { ok: false, error: "Proposal not pending" };
  const trimmed = revision.trim();
  if (!trimmed) return { ok: false, error: "Revision must be non-empty" };
  const contentCheck = validateProposalContent(`${p.title}\n${p.observation}\n${trimmed}`);
  if (!contentCheck.ok) {
    return { ok: false, error: `Revision failed safety validation (${contentCheck.reason})` };
  }
  if (
    !ctx.cfg.personaProposals.allowedFiles.includes(
      p.targetFile as (typeof ctx.cfg.personaProposals.allowedFiles)[number],
    )
  ) {
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
  if (ctx.changeFeed) {
    supersedeActiveProposedEvent(ctx.changeFeed, unifiedKey);
    emitPersonaProposed(ctx.changeFeed, ctx.cfg, {
      sessionKey: resolveWorkshopProposedSessionKey(),
      proposalId: parsed.storeId,
      title: updated.title,
      targetFile: updated.targetFile,
      detail: `${updated.observation}\n${updated.suggestedChange}`.replace(/\s+/g, " ").trim().slice(0, 240),
    });
  }
  return { ok: true, message: "Proposal revised in place" };
}

export function workshopUndo(
  ctx: WorkshopServiceContext,
  unifiedKey: string,
  opts?: { changeEventId?: string },
): WorkshopActionResult {
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
  const claimed = ctx.proposalsDb.updateStatusIf(parsed.storeId, "pending", "applied");
  if (!claimed) return { ok: false, error: "Proposal is not in applied state" };
  const result = undoProposalRollback(ctx.resolvedSqlitePath, parsed.storeId);
  if (!result.ok) {
    ctx.proposalsDb.updateStatusIf(parsed.storeId, "applied", "pending");
    return { ok: false, error: result.error };
  }
  deleteProposalRollback(ctx.resolvedSqlitePath, parsed.storeId);
  if (ctx.changeFeed) {
    let applied = opts?.changeEventId ? ctx.changeFeed.getById(opts.changeEventId) : null;
    if (!applied || applied.status !== "active" || applied.proposalKey !== unifiedKey) {
      applied = ctx.changeFeed.findActiveByProposalKey(unifiedKey, "applied");
    }
    if (applied && applied.status === "active" && applied.proposalKey === unifiedKey) {
      ctx.changeFeed.markReverted(applied.id);
      emitChangeReverted(ctx.changeFeed, ctx.cfg, {
        sessionKey: applied.sessionKey,
        originalEvent: applied,
        detail: `Restored ${result.targetPath} and reverted proposal to pending`,
      });
    }
  }
  return { ok: true, message: `Restored ${result.targetPath} and reverted proposal to pending` };
}

export function workshopPendingCount(ctx: WorkshopServiceContext): number {
  return listUnifiedProposals(ctx, { status: "pending" }).length;
}

export function workshopMaxPending(ctx: WorkshopServiceContext): number {
  return ctx.maxPending ?? DEFAULT_WORKSHOP_MAX_PENDING;
}
